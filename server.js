#!/usr/bin/env node

/**
 * OpenCompletions Server
 *
 * Wraps `claude -p --max-turns 1` as a local completions API
 * with both OpenAI-compatible and Anthropic-compatible endpoints.
 *
 * Supports three execution backends:
 *   - local:  spawns `claude -p` as a subprocess (default)
 *   - sprite: delegates to a Sprites.dev VM via REST API
 *   - vercel: delegates to a Vercel Sandbox via REST API
 *
 * Usage:
 *   # Local mode
 *   node server.js
 *
 *   # Sprite mode (single sprite)
 *   node server.js --backend sprite --sprite-token $SPRITES_TOKEN --sprite-name my-sprite
 *
 *   # Sprite pool (multiple sprites as workers)
 *   node server.js --backend sprite --sprite-token $SPRITES_TOKEN \
 *     --sprite-name worker-1 --sprite-name worker-2 --sprite-name worker-3
 *
 *   # Vercel Sandbox mode
 *   node server.js --backend vercel --vercel-token $VERCEL_TOKEN \
 *     --vercel-team-id $TEAM_ID --vercel-snapshot-id $SNAP_ID
 *
 *   # Other options
 *   node server.js --port 3456 --concurrency 3 --timeout 120000 --api-key mysecret
 */

const http = require("http");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const val = args[i + 1];
  if (!val || val.startsWith("--")) {
    console.error(`Error: --${name} requires a value`);
    process.exit(1);
  }
  return val;
}

function flagAll(name) {
  const results = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && args[i + 1]) {
      results.push(args[i + 1]);
      i++; // skip the value
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = parseInt(flag("port", "3456"), 10);
const MAX_CONCURRENCY = parseInt(flag("concurrency", "3"), 10);
const TIMEOUT_MS = parseInt(flag("timeout", "120000"), 10);
const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB
const MAX_QUEUE_DEPTH = parseInt(flag("queue-depth", "100"), 10);
const MAX_TURNS = flag("max-turns", "1");
const API_KEY = flag("api-key", process.env.API_KEY || "");
const MODEL_NAME = "claude-code";

// Backend config
const BACKEND = flag("backend", "local"); // "local", "sprite", or "vercel"
const CLAUDE_TOKEN = flag(
  "claude-token",
  process.env.CLAUDE_CODE_OAUTH_TOKEN || "",
);

// Sprite config
const SPRITE_TOKEN = flag("sprite-token", process.env.SPRITES_TOKEN || "");
const SPRITE_NAMES = flagAll("sprite-name");
const SPRITE_API = flag("sprite-api", "https://api.sprites.dev");

// Vercel Sandbox config
const VERCEL_TOKEN = flag("vercel-token", process.env.VERCEL_TOKEN || "");
const VERCEL_TEAM_ID = flag(
  "vercel-team-id",
  process.env.VERCEL_TEAM_ID || "",
);
const VERCEL_PROJECT_ID = flag(
  "vercel-project-id",
  process.env.VERCEL_PROJECT_ID || "",
);
const VERCEL_SNAPSHOT_ID = flag("vercel-snapshot-id", "");
const VERCEL_API = "https://api.vercel.com";

// Regex for stripping terminal artifacts
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
const ANSI_ESCAPES = /\x1B\[[0-9;]*[a-zA-Z]/g;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let activeWorkers = 0;
const queue = [];
const activeProcesses = new Set();
const spritePool = SPRITE_NAMES.map((name) => ({ name, busy: 0 }));
const vercelPool = [];

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
if (BACKEND === "sprite" && !SPRITE_TOKEN) {
  console.error(
    "Error: --sprite-token or SPRITES_TOKEN env var required for sprite backend",
  );
  process.exit(1);
}
if (BACKEND === "sprite" && SPRITE_NAMES.length === 0) {
  console.error(
    "Error: at least one --sprite-name required for sprite backend",
  );
  process.exit(1);
}
if (BACKEND === "vercel" && !VERCEL_TOKEN) {
  console.error(
    "Error: --vercel-token or VERCEL_TOKEN env var required for vercel backend",
  );
  process.exit(1);
}
if (BACKEND === "vercel" && !VERCEL_TEAM_ID) {
  console.error(
    "Error: --vercel-team-id or VERCEL_TEAM_ID env var required for vercel backend",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Pool helpers (shared pattern for sprite and vercel)
// ---------------------------------------------------------------------------
function acquireSprite() {
  let sprite = spritePool[0];
  for (let i = 1; i < spritePool.length; i++) {
    if (spritePool[i].busy < sprite.busy) {
      sprite = spritePool[i];
    }
  }
  sprite.busy++;
  return sprite;
}

function releaseSprite(sprite) {
  sprite.busy = Math.max(0, sprite.busy - 1);
}

function acquireVercelSandbox() {
  let sandbox = null;
  for (let i = 0; i < vercelPool.length; i++) {
    if (vercelPool[i].replacing) continue;
    if (!sandbox || vercelPool[i].busy < sandbox.busy) {
      sandbox = vercelPool[i];
    }
  }
  if (!sandbox) throw new Error("No healthy Vercel sandboxes available");
  sandbox.busy++;
  return sandbox;
}

function releaseVercelSandbox(sandbox) {
  sandbox.busy = Math.max(0, sandbox.busy - 1);
}

// ---------------------------------------------------------------------------
// Request queue
// ---------------------------------------------------------------------------
function enqueue(prompt, systemPrompt, onChunk) {
  if (queue.length >= MAX_QUEUE_DEPTH) {
    return Promise.reject(new Error("Server too busy"));
  }
  return new Promise((resolve, reject) => {
    queue.push({ resolve, reject, prompt, systemPrompt, onChunk });
    drain();
  });
}

function drain() {
  while (activeWorkers < MAX_CONCURRENCY && queue.length > 0) {
    const job = queue.shift();
    activeWorkers++;

    const streaming = !!job.onChunk;
    const execFns = {
      local: streaming ? runClaudeLocalStreaming : runClaudeLocal,
      sprite: streaming ? runClaudeSpriteStreaming : runClaudeOnSprite,
      vercel: streaming ? runClaudeVercelStreaming : runClaudeOnVercel,
    };
    const execFn = execFns[BACKEND];
    const execArgs = streaming
      ? [job.prompt, job.systemPrompt, job.onChunk]
      : [job.prompt, job.systemPrompt];

    execFn(...execArgs)
      .then(job.resolve)
      .catch((err) => {
        // One retry for transient backend failures
        if (!job.retried && BACKEND !== "local") {
          job.retried = true;
          console.log(`Retrying after error: ${err.message}`);
          return new Promise((r) => setTimeout(r, 1000)).then(() =>
            execFn(...execArgs).then(job.resolve).catch(job.reject),
          );
        }
        job.reject(err);
      })
      .finally(() => {
        activeWorkers--;
        drain();
      });
  }
}

// ---------------------------------------------------------------------------
// Output cleaning
// ---------------------------------------------------------------------------
function cleanOutput(text) {
  return text.replace(ANSI_ESCAPES, "").replace(CONTROL_CHARS, "").trim();
}

function cleanChunk(text) {
  return text.replace(ANSI_ESCAPES, "").replace(CONTROL_CHARS, "");
}

// ---------------------------------------------------------------------------
// Backend: Local subprocess
// ---------------------------------------------------------------------------
function runClaudeLocal(prompt, systemPrompt) {
  return new Promise((resolve, reject) => {
    const cliArgs = ["-p", "--max-turns", MAX_TURNS, "--output-format", "text"];

    if (systemPrompt) {
      cliArgs.push("--system-prompt", systemPrompt);
    }

    const env = { ...process.env };
    if (CLAUDE_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = CLAUDE_TOKEN;

    const proc = spawn("claude", cliArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    activeProcesses.add(proc);
    let settled = false;
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGTERM");
      reject(new Error(`Timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      activeProcesses.delete(proc);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve(cleanOutput(stdout));
      } else {
        reject(new Error(stderr || `claude exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      activeProcesses.delete(proc);
      if (settled) return;
      settled = true;
      reject(err);
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

function runClaudeLocalStreaming(prompt, systemPrompt, onChunk) {
  return new Promise((resolve, reject) => {
    const cliArgs = ["-p", "--max-turns", MAX_TURNS, "--output-format", "text"];
    if (systemPrompt) cliArgs.push("--system-prompt", systemPrompt);

    const env = { ...process.env };
    if (CLAUDE_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = CLAUDE_TOKEN;

    const proc = spawn("claude", cliArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    activeProcesses.add(proc);
    let settled = false;
    let stderr = "";
    const decoder = new TextDecoder("utf-8", { fatal: false });

    proc.stdout.on("data", (chunk) => {
      const text = cleanChunk(decoder.decode(chunk, { stream: true }));
      if (text) onChunk(text);
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGTERM");
      reject(new Error(`Timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);
      activeProcesses.delete(proc);
      if (settled) return;
      settled = true;
      if (code === 0) resolve();
      else reject(new Error(stderr || `claude exited with code ${code}`));
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      activeProcesses.delete(proc);
      if (settled) return;
      settled = true;
      reject(err);
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Backend: Sprite exec via REST API
// ---------------------------------------------------------------------------

// Write auth wrapper to sprite filesystem via stdin (keeps token out of URLs,
// avoids shell interpretation of args by using exec with separate cmd params)
async function initSpriteSetup(spriteName) {
  const script = [
    "#!/bin/bash",
    "set -a; source ~/.claude-env 2>/dev/null; set +a",
    'exec claude "$@"',
  ].join("\n");

  const body = CLAUDE_TOKEN
    ? `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_TOKEN}`
    : "";

  const params = new URLSearchParams();
  params.append("cmd", "bash");
  params.append("cmd", "-c");
  params.append(
    "cmd",
    "cat > ~/.claude-env && chmod 600 ~/.claude-env && " +
      "printf '%s' '" +
      script.replace(/'/g, "'\\''") +
      "' > ~/.claude-wrapper && chmod +x ~/.claude-wrapper",
  );
  params.append("stdin", "true");

  const url = `${SPRITE_API}/v1/sprites/${encodeURIComponent(
    spriteName,
  )}/exec?${params.toString()}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SPRITE_TOKEN}`,
      "Content-Type": "text/plain",
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`Failed to init sprite: ${await res.text()}`);
  }
}

async function cleanupSpriteAuth(spriteName) {
  const params = new URLSearchParams();
  params.append("cmd", "bash");
  params.append("cmd", "-c");
  params.append("cmd", "rm -f ~/.claude-env ~/.claude-wrapper");

  const url = `${SPRITE_API}/v1/sprites/${encodeURIComponent(
    spriteName,
  )}/exec?${params.toString()}`;

  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${SPRITE_TOKEN}` },
  }).catch(() => {});
}

async function initSprites() {
  console.log("Initializing sprites...");
  await Promise.all(SPRITE_NAMES.map((name) => initSpriteSetup(name)));
  console.log("Sprites ready.");
}

function buildSpriteExecUrl(spriteName, systemPrompt) {
  const params = new URLSearchParams();
  params.append("cmd", "/home/sprite/.claude-wrapper");
  params.append("cmd", "-p");
  params.append("cmd", "--max-turns");
  params.append("cmd", MAX_TURNS);
  params.append("cmd", "--output-format");
  params.append("cmd", "text");
  if (systemPrompt) {
    params.append("cmd", "--system-prompt");
    params.append("cmd", systemPrompt);
  }
  params.append("stdin", "true");
  return `${SPRITE_API}/v1/sprites/${encodeURIComponent(
    spriteName,
  )}/exec?${params.toString()}`;
}

async function runClaudeOnSprite(prompt, systemPrompt) {
  const sprite = acquireSprite();

  try {
    const url = buildSpriteExecUrl(sprite.name, systemPrompt);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SPRITE_TOKEN}`,
        "Content-Type": "text/plain",
        Accept: "application/json",
      },
      body: prompt,
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Sprite exec failed (${response.status}): ${errBody}`);
    }

    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const result = await response.json();
      if (result.exit_code && result.exit_code !== 0) {
        throw new Error(
          result.stderr || `claude exited with code ${result.exit_code}`,
        );
      }
      return cleanOutput(result.stdout || "");
    }

    // Fallback: plain text
    const text = await response.text();
    return cleanOutput(text);
  } finally {
    releaseSprite(sprite);
  }
}

async function runClaudeSpriteStreaming(prompt, systemPrompt, onChunk) {
  const sprite = acquireSprite();

  try {
    const url = buildSpriteExecUrl(sprite.name, systemPrompt);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SPRITE_TOKEN}`,
        "Content-Type": "text/plain",
        Accept: "application/json",
      },
      body: prompt,
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Sprite exec failed (${response.status}): ${errBody}`);
    }

    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      // Buffered JSON response — send as single chunk
      const result = await response.json();
      if (result.exit_code && result.exit_code !== 0) {
        throw new Error(
          result.stderr || `claude exited with code ${result.exit_code}`,
        );
      }
      const text = cleanChunk(result.stdout || "");
      if (text) onChunk(text);
    } else {
      // Plain text — stream chunks as they arrive
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: false });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = cleanChunk(decoder.decode(value, { stream: true }));
        if (text) onChunk(text);
      }
    }
  } finally {
    releaseSprite(sprite);
  }
}

// ---------------------------------------------------------------------------
// Backend: Vercel Sandbox via REST API
// ---------------------------------------------------------------------------
function vercelHeaders() {
  return {
    Authorization: `Bearer ${VERCEL_TOKEN}`,
    "Content-Type": "application/json",
  };
}

function vercelUrl(path) {
  const sep = path.includes("?") ? "&" : "?";
  return `${VERCEL_API}${path}${sep}teamId=${encodeURIComponent(VERCEL_TEAM_ID)}`;
}

async function createVercelSandbox() {
  const body = { runtime: "node24" };
  if (VERCEL_SNAPSHOT_ID) {
    body.source = { type: "snapshot", snapshotId: VERCEL_SNAPSHOT_ID };
  }
  if (VERCEL_PROJECT_ID) {
    body.projectId = VERCEL_PROJECT_ID;
  }

  const res = await fetch(vercelUrl("/v1/sandboxes"), {
    method: "POST",
    headers: vercelHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Failed to create sandbox: ${await res.text()}`);
  }

  const data = await res.json();
  return data.sandbox;
}

async function stopVercelSandbox(sandboxId) {
  await fetch(vercelUrl(`/v1/sandboxes/${sandboxId}/stop`), {
    method: "POST",
    headers: vercelHeaders(),
  }).catch(() => {});
}

async function initVercelPool() {
  console.log(`Creating ${MAX_CONCURRENCY} Vercel sandbox(es)...`);
  const results = await Promise.all(
    Array.from({ length: MAX_CONCURRENCY }, () => createVercelSandbox()),
  );
  for (const sbx of results) {
    vercelPool.push({ id: sbx.id, busy: 0 });
  }
  console.log(
    `Vercel sandboxes ready: ${vercelPool.map((s) => s.id).join(", ")}`,
  );
}

function buildVercelClaudeArgs(prompt, systemPrompt) {
  const cmdArgs = ["-p", "--max-turns", MAX_TURNS, "--output-format", "text"];
  if (systemPrompt) cmdArgs.push("--system-prompt", systemPrompt);
  cmdArgs.push(prompt);
  return cmdArgs;
}

function buildVercelEnv() {
  const env = {};
  if (CLAUDE_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = CLAUDE_TOKEN;
  return env;
}

async function vercelExec(sandboxId, cmdArgs, env) {
  const res = await fetch(vercelUrl(`/v1/sandboxes/${sandboxId}/cmd`), {
    method: "POST",
    headers: vercelHeaders(),
    body: JSON.stringify({ command: "claude", args: cmdArgs, env }),
  });

  if (!res.ok) throw new Error(`Vercel exec failed: ${await res.text()}`);
  const data = await res.json();
  return data.command.id;
}

async function vercelStreamLogs(sandboxId, cmdId, onStdout, onStderr) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(
      vercelUrl(`/v1/sandboxes/${sandboxId}/cmd/${cmdId}/logs`),
      {
        headers: { Authorization: `Bearer ${VERCEL_TOKEN}` },
        signal: controller.signal,
      },
    );

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.stream === "stdout" && onStdout) onStdout(event.data);
        else if (event.stream === "stderr" && onStderr) onStderr(event.data);
        else if (event.stream === "error")
          throw new Error(event.data?.message || "Stream error");
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

async function vercelExitCode(sandboxId, cmdId) {
  const res = await fetch(
    vercelUrl(`/v1/sandboxes/${sandboxId}/cmd/${cmdId}?wait=true`),
    { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } },
  );
  const data = await res.json();
  return data.command.exitCode;
}

async function replaceVercelSandbox(sandbox) {
  sandbox.replacing = true;
  console.log(`Replacing dead sandbox ${sandbox.id}...`);
  stopVercelSandbox(sandbox.id);
  try {
    const newSbx = await createVercelSandbox();
    sandbox.id = newSbx.id;
    console.log(`Replaced with ${newSbx.id}`);
  } finally {
    sandbox.replacing = false;
  }
}

async function runClaudeOnVercel(prompt, systemPrompt) {
  const sandbox = acquireVercelSandbox();
  try {
    const cmdArgs = buildVercelClaudeArgs(prompt, systemPrompt);
    const env = buildVercelEnv();
    let cmdId;
    try {
      cmdId = await vercelExec(sandbox.id, cmdArgs, env);
    } catch (err) {
      if (
        err.message.includes("sandbox_stopped") ||
        err.message.includes("not found")
      ) {
        await replaceVercelSandbox(sandbox);
        cmdId = await vercelExec(sandbox.id, cmdArgs, env);
      } else {
        throw err;
      }
    }

    let stdout = "";
    let stderr = "";
    await vercelStreamLogs(
      sandbox.id,
      cmdId,
      (data) => {
        stdout += data;
      },
      (data) => {
        stderr += data;
      },
    );

    const code = await vercelExitCode(sandbox.id, cmdId);
    if (code !== 0) {
      throw new Error(stderr || `claude exited with code ${code}`);
    }
    return cleanOutput(stdout);
  } finally {
    releaseVercelSandbox(sandbox);
  }
}

async function runClaudeVercelStreaming(prompt, systemPrompt, onChunk) {
  const sandbox = acquireVercelSandbox();
  try {
    const cmdArgs = buildVercelClaudeArgs(prompt, systemPrompt);
    const env = buildVercelEnv();
    let cmdId;
    try {
      cmdId = await vercelExec(sandbox.id, cmdArgs, env);
    } catch (err) {
      if (
        err.message.includes("sandbox_stopped") ||
        err.message.includes("not found")
      ) {
        await replaceVercelSandbox(sandbox);
        cmdId = await vercelExec(sandbox.id, cmdArgs, env);
      } else {
        throw err;
      }
    }

    let stderr = "";
    await vercelStreamLogs(
      sandbox.id,
      cmdId,
      (data) => {
        const cleaned = cleanChunk(data);
        if (cleaned) onChunk(cleaned);
      },
      (data) => {
        stderr += data;
      },
    );

    const code = await vercelExitCode(sandbox.id, cmdId);
    if (code !== 0) {
      throw new Error(stderr || `claude exited with code ${code}`);
    }
  } finally {
    releaseVercelSandbox(sandbox);
  }
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------
function buildOpenAIResponse(text, model, isChat) {
  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  if (isChat) {
    return {
      id,
      object: "chat.completion",
      created,
      model: model || MODEL_NAME,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  return {
    id: id.replace("chatcmpl", "cmpl"),
    object: "text_completion",
    created,
    model: model || MODEL_NAME,
    choices: [{ index: 0, text, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function buildAnthropicResponse(text, model) {
  return {
    id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "message",
    role: "assistant",
    model: model || MODEL_NAME,
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

function buildOpenAIModelsResponse() {
  return {
    object: "list",
    data: [
      {
        id: MODEL_NAME,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "local",
      },
    ],
  };
}

function errorResponse(status, message, type = "invalid_request_error") {
  return { status, body: { error: { message, type, code: status } } };
}

// ---------------------------------------------------------------------------
// SSE streaming helpers
// ---------------------------------------------------------------------------
function initSSE(res, req, start) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "*",
  });
  res.flushHeaders();
  res.on("close", () => {
    console.log(
      `${req.method} ${req.url} 200 stream ${Date.now() - start}ms`,
    );
  });
}

function sseData(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function sseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function handleOpenAIChatStream(
  req,
  res,
  start,
  prompt,
  systemPrompt,
  model,
) {
  const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const m = model || MODEL_NAME;

  initSSE(res, req, start);

  // Initial role chunk
  sseData(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: m,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });

  try {
    await enqueue(prompt, systemPrompt, (text) => {
      sseData(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model: m,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      });
    });

    // Stop chunk
    sseData(res, {
      id,
      object: "chat.completion.chunk",
      created,
      model: m,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });
  } catch (err) {
    sseData(res, {
      error: { message: err.message, type: "server_error" },
    });
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

async function handleOpenAICompletionsStream(req, res, start, prompt, model) {
  const id = `cmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const m = model || MODEL_NAME;

  initSSE(res, req, start);

  try {
    await enqueue(prompt, null, (text) => {
      sseData(res, {
        id,
        object: "text_completion",
        created,
        model: m,
        choices: [{ index: 0, text, finish_reason: null }],
      });
    });

    sseData(res, {
      id,
      object: "text_completion",
      created,
      model: m,
      choices: [{ index: 0, text: "", finish_reason: "stop" }],
    });
  } catch (err) {
    sseData(res, {
      error: { message: err.message, type: "server_error" },
    });
  }

  res.write("data: [DONE]\n\n");
  res.end();
}

async function handleAnthropicStream(
  req,
  res,
  start,
  prompt,
  systemPrompt,
  model,
) {
  const id = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const m = model || MODEL_NAME;

  initSSE(res, req, start);

  sseEvent(res, "message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      content: [],
      model: m,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  sseEvent(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });

  sseEvent(res, "ping", { type: "ping" });

  try {
    await enqueue(prompt, systemPrompt, (text) => {
      sseEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      });
    });

    sseEvent(res, "content_block_stop", {
      type: "content_block_stop",
      index: 0,
    });

    sseEvent(res, "message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 0 },
    });
  } catch (err) {
    sseEvent(res, "error", {
      type: "error",
      error: { type: "server_error", message: err.message },
    });
  }

  sseEvent(res, "message_stop", { type: "message_stop" });
  res.end();
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let settled = false;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

// NOTE: Multi-turn conversations are flattened into a single string
// ("role: content\n\nrole: content") because `claude -p` is a single-turn CLI
// tool. Prior assistant responses become user-authored text from Claude's
// perspective. This works fine for single-turn use but degrades with long
// multi-turn conversations.
function extractOpenAIChatPrompt(body) {
  const messages = body.messages || [];
  if (!messages.length) return { prompt: null, systemPrompt: null };

  let systemPrompt = null;
  const parts = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemPrompt =
        typeof msg.content === "string"
          ? msg.content
          : msg.content?.map((c) => c.text || "").join("\n");
    } else {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : msg.content?.map((c) => c.text || "").join("\n");
      parts.push(`${msg.role}: ${content}`);
    }
  }

  return { prompt: parts.join("\n\n"), systemPrompt };
}

function extractAnthropicPrompt(body) {
  const messages = body.messages || [];
  let systemPrompt = null;
  if (typeof body.system === "string") {
    systemPrompt = body.system;
  } else if (Array.isArray(body.system)) {
    const text = body.system
      .map((block) => block.text || "")
      .filter(Boolean)
      .join("\n");
    if (text) systemPrompt = text;
  }

  const parts = messages.map((msg) => {
    const content =
      typeof msg.content === "string"
        ? msg.content
        : msg.content?.map((c) => c.text || "").join("\n");
    return `${msg.role}: ${content}`;
  });

  return { prompt: parts.join("\n\n") || null, systemPrompt };
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const start = Date.now();

  const sendJSON = (status, data) => {
    const json = JSON.stringify(data, null, 2);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*",
    });
    res.end(json);
    console.log(
      `${req.method} ${req.url} ${status} ${Date.now() - start}ms`,
    );
  };

  if (req.method === "OPTIONS") return sendJSON(204, {});

  // Auth check
  if (API_KEY) {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== API_KEY) {
      return sendJSON(401, {
        error: {
          message: "Invalid API key",
          type: "authentication_error",
          code: 401,
        },
      });
    }
  }

  const url = req.url.split("?")[0];

  try {
    // ----- Health / Info -----
    if (url === "/" && req.method === "GET") {
      const info = {
        name: "opencompletions",
        status: "ok",
        backend: BACKEND,
        active_workers: activeWorkers,
        queued: queue.length,
        max_concurrency: MAX_CONCURRENCY,
        endpoints: {
          openai_chat: "POST /v1/chat/completions",
          openai_completions: "POST /v1/completions",
          anthropic_messages: "POST /v1/messages",
          models: "GET  /v1/models",
        },
      };
      if (BACKEND === "sprite") {
        info.sprites = spritePool.map((s) => ({
          name: s.name,
          active_jobs: s.busy,
        }));
      }
      if (BACKEND === "vercel") {
        info.sandboxes = vercelPool.map((s) => ({
          id: s.id,
          active_jobs: s.busy,
        }));
      }
      return sendJSON(200, info);
    }

    // ----- OpenAI: GET /v1/models -----
    if (url === "/v1/models" && req.method === "GET") {
      return sendJSON(200, buildOpenAIModelsResponse());
    }

    // ----- OpenAI: POST /v1/chat/completions -----
    if (url === "/v1/chat/completions" && req.method === "POST") {
      const body = await parseBody(req);
      const { prompt, systemPrompt } = extractOpenAIChatPrompt(body);
      if (!prompt) {
        const err = errorResponse(400, "messages array is required");
        return sendJSON(err.status, err.body);
      }
      if (body.stream) {
        return await handleOpenAIChatStream(
          req,
          res,
          start,
          prompt,
          systemPrompt,
          body.model,
        );
      }
      const text = await enqueue(prompt, systemPrompt);
      return sendJSON(200, buildOpenAIResponse(text, body.model, true));
    }

    // ----- OpenAI: POST /v1/completions -----
    if (url === "/v1/completions" && req.method === "POST") {
      const body = await parseBody(req);
      const prompt = body.prompt;
      if (!prompt) {
        const err = errorResponse(400, "prompt is required");
        return sendJSON(err.status, err.body);
      }
      const p = typeof prompt === "string" ? prompt : prompt.join("\n");
      if (body.stream) {
        return await handleOpenAICompletionsStream(
          req,
          res,
          start,
          p,
          body.model,
        );
      }
      const text = await enqueue(p, null);
      return sendJSON(200, buildOpenAIResponse(text, body.model, false));
    }

    // ----- Anthropic: POST /v1/messages -----
    if (url === "/v1/messages" && req.method === "POST") {
      const body = await parseBody(req);
      const { prompt, systemPrompt } = extractAnthropicPrompt(body);
      if (!prompt) {
        const err = errorResponse(400, "messages array is required");
        return sendJSON(err.status, err.body);
      }
      if (body.stream) {
        return await handleAnthropicStream(
          req,
          res,
          start,
          prompt,
          systemPrompt,
          body.model,
        );
      }
      const text = await enqueue(prompt, systemPrompt);
      return sendJSON(200, buildAnthropicResponse(text, body.model));
    }

    // ----- Queue status -----
    if (url === "/v1/status" && req.method === "GET") {
      const status = {
        active_workers: activeWorkers,
        queued: queue.length,
        max_concurrency: MAX_CONCURRENCY,
        backend: BACKEND,
      };
      if (BACKEND === "vercel") {
        status.sandboxes = vercelPool.map((s) => ({
          id: s.id,
          active_jobs: s.busy,
        }));
      }
      if (BACKEND === "sprite") {
        status.sprites = spritePool.map((s) => ({
          name: s.name,
          active_jobs: s.busy,
        }));
      }
      return sendJSON(200, status);
    }

    sendJSON(404, { error: { message: "Not found", type: "not_found" } });
  } catch (err) {
    console.error("Error:", err.message);
    const status = err.message === "Server too busy" ? 503 : 500;
    sendJSON(status, {
      error: { message: err.message, type: "server_error", code: status },
    });
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function start() {
  if (BACKEND === "sprite") {
    await initSprites();
  }
  if (BACKEND === "vercel") {
    await initVercelPool();
  }

  server.listen(PORT, () => {
    const backendLabels = {
      local: "Local subprocess",
      sprite: `Sprite pool: ${SPRITE_NAMES.join(", ")}`,
      vercel: `Vercel sandboxes (${vercelPool.length})`,
    };
    const backendInfo = backendLabels[BACKEND] || BACKEND;

    console.log(`
╔══════════════════════════════════════════════════════════╗
║              OpenCompletions Server                      ║
╠══════════════════════════════════════════════════════════╣
║                                                          ║
║  Listening on http://localhost:${String(PORT).padEnd(26)}║
║  Backend:     ${backendInfo.slice(0, 43).padEnd(43)}║
║  Concurrency: ${String(MAX_CONCURRENCY).padEnd(43)}║
║  Timeout:     ${String(TIMEOUT_MS + "ms").padEnd(43)}║
║                                                          ║
║  Endpoints:                                              ║
║    POST /v1/chat/completions   (OpenAI chat)             ║
║    POST /v1/completions        (OpenAI completions)      ║
║    POST /v1/messages           (Anthropic messages)      ║
║    GET  /v1/models             (OpenAI models list)      ║
║    GET  /v1/status             (Queue status)            ║
║    GET  /                      (Health check)            ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
`);
  });
}

start().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(signal) {
  console.log(`\nReceived ${signal}, shutting down...`);
  server.close();

  // Reject all queued jobs
  while (queue.length > 0) {
    const job = queue.shift();
    job.reject(new Error("Server shutting down"));
  }

  // Kill active child processes
  for (const proc of activeProcesses) {
    proc.kill("SIGTERM");
  }

  // Clean up sprite credentials
  for (const name of SPRITE_NAMES) {
    cleanupSpriteAuth(name);
  }

  // Stop Vercel sandboxes
  for (const sandbox of vercelPool) {
    stopVercelSandbox(sandbox.id);
  }

  const deadline = setTimeout(() => {
    console.error("Force exit after timeout");
    process.exit(1);
  }, 10000);
  deadline.unref();

  const check = setInterval(() => {
    if (activeWorkers === 0) {
      clearInterval(check);
      clearTimeout(deadline);
      process.exit(0);
    }
  }, 200);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
