#!/usr/bin/env node

/**
 * OpenCompletions Server
 *
 * Wraps CLI coding agents as a local completions API with OpenAI-compatible,
 * Anthropic-compatible, and multi-turn Agent endpoints.
 *
 * Supports two CLI backends (--cli flag):
 *   - claude:   Claude Code CLI (default)
 *   - opencode: OpenCode CLI (provider-agnostic, local backend only)
 *
 * Supports three execution backends:
 *   - local:  spawns the CLI as a subprocess (default)
 *   - sprite: delegates to a Sprites.dev VM via REST API (claude only)
 *   - vercel: delegates to a Vercel Sandbox via REST API (claude only)
 *
 * Usage:
 *   # Local mode
 *   node server.js
 *
 *   # Sprite mode (single sprite)
 *   node server.js --backend sprite --sprite-token $SPRITE_TOKEN --sprite-name my-sprite
 *
 *   # Sprite pool (multiple sprites as workers)
 *   node server.js --backend sprite --sprite-token $SPRITE_TOKEN \
 *     --sprite-name worker-1 --sprite-name worker-2 --sprite-name worker-3
 *
 *   # Vercel Sandbox mode
 *   node server.js --backend vercel --vercel-token $VERCEL_TOKEN \
 *     --vercel-team-id $TEAM_ID --vercel-snapshot-id $SNAP_ID
 *
 *   # OpenCode mode (provider-agnostic)
 *   node server.js --cli opencode
 *
 *   # Other options
 *   node server.js --port 3456 --concurrency 3 --timeout 120000 --api-key mysecret
 */

const http = require("http");
const { spawn } = require("child_process");
const { randomUUID, timingSafeEqual, createHash } = require("crypto");

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
const AGENT_MAX_TURNS = parseInt(flag("agent-max-turns", "10"), 10);
const AGENT_TIMEOUT_MS = parseInt(flag("agent-timeout", "600000"), 10); // 10 min
const AGENT_MCP_CONFIG = flag("agent-mcp-config", ""); // operator default MCP
const API_KEY = flag("api-key", process.env.API_KEY || "");
const MODEL_NAME = "claude-code";

// Backend config
const BACKEND = flag("backend", "local"); // "local", "sprite", or "vercel"
const CLI_NAME = flag("cli", "claude"); // "claude" or "opencode"
// Auth config: --anthropic-api-key → ANTHROPIC_API_KEY env var (priority)
//              --claude-token → CLAUDE_CODE_OAUTH_TOKEN env var (fallback)
const CONFIGURED_API_KEY = flag(
  "anthropic-api-key",
  process.env.ANTHROPIC_API_KEY || "",
);
const CONFIGURED_OAUTH_TOKEN = flag(
  "claude-token",
  process.env.CLAUDE_CODE_OAUTH_TOKEN || "",
);

// Sprite config
const SPRITE_TOKEN = flag("sprite-token", process.env.SPRITE_TOKEN || process.env.SPRITES_TOKEN || "");
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

// Agent session affinity
const sessionToSprite = new Map();  // session_id → sprite name
const sessionToSandbox = new Map(); // session_id → sandbox id

// Evict stale session mappings every 30 minutes
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const sessionTimestamps = new Map(); // session_id → timestamp
setInterval(() => {
  const now = Date.now();
  for (const [sid, ts] of sessionTimestamps) {
    if (now - ts > SESSION_TTL_MS) {
      sessionTimestamps.delete(sid);
      sessionToSprite.delete(sid);
      sessionToSandbox.delete(sid);
    }
  }
}, 30 * 60 * 1000);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
const VALID_BACKENDS = ["local", "sprite", "vercel"];
if (!VALID_BACKENDS.includes(BACKEND)) {
  console.error(
    `Error: --backend must be one of: ${VALID_BACKENDS.join(", ")} (got "${BACKEND}")`,
  );
  process.exit(1);
}
for (const [name, val] of [
  ["port", PORT],
  ["concurrency", MAX_CONCURRENCY],
  ["timeout", TIMEOUT_MS],
  ["queue-depth", MAX_QUEUE_DEPTH],
  ["agent-max-turns", AGENT_MAX_TURNS],
  ["agent-timeout", AGENT_TIMEOUT_MS],
]) {
  if (Number.isNaN(val) || val <= 0) {
    console.error(`Error: --${name} must be a positive number`);
    process.exit(1);
  }
}
if (!API_KEY) {
  console.warn(
    "WARNING: No --api-key configured. Server is open to all requests.",
  );
}
if (BACKEND === "sprite" && !SPRITE_TOKEN) {
  console.error(
    "Error: --sprite-token or SPRITE_TOKEN env var required for sprite backend",
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
const VALID_CLIS = ["claude", "opencode"];
if (!VALID_CLIS.includes(CLI_NAME)) {
  console.error(
    `Error: --cli must be one of: ${VALID_CLIS.join(", ")} (got "${CLI_NAME}")`,
  );
  process.exit(1);
}
if (CLI_NAME === "opencode" && BACKEND !== "local") {
  console.error("Error: --cli opencode only supports --backend local");
  process.exit(1);
}
if (CLI_NAME === "opencode" && CONFIGURED_OAUTH_TOKEN && !CONFIGURED_API_KEY) {
  console.warn(
    "WARNING: CLAUDE_CODE_OAUTH_TOKEN is set but cannot be used with opencode per Anthropic ToS. " +
    "Set ANTHROPIC_API_KEY or use --anthropic-api-key instead.",
  );
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
function enqueue(prompt, systemPrompt, opts = {}) {
  const { token = null, onChunk = null } = opts;
  if (queue.length >= MAX_QUEUE_DEPTH) {
    return Promise.reject(new Error("Server too busy"));
  }
  return new Promise((resolve, reject) => {
    queue.push({ resolve, reject, prompt, systemPrompt, token, onChunk });
    drain();
  });
}

function enqueueAgent(prompt, opts = {}) {
  if (queue.length >= MAX_QUEUE_DEPTH) {
    return Promise.reject(new Error("Server too busy"));
  }
  return new Promise((resolve, reject) => {
    queue.push({
      resolve,
      reject,
      prompt,
      isAgent: true,
      agentOpts: opts,
      onEvent: opts.onEvent,
    });
    drain();
  });
}

function drain() {
  while (activeWorkers < MAX_CONCURRENCY && queue.length > 0) {
    const job = queue.shift();
    activeWorkers++;

    if (job.isAgent) {
      // Agent jobs — no retry (side effects make retry dangerous)
      const agentFns = {
        local: runAgentLocal,
        sprite: runAgentOnSprite,
        vercel: runAgentOnVercel,
      };
      const agentFn = agentFns[BACKEND];

      const run = async () => {
        try {
          await agentFn(job.prompt, job.agentOpts, job.onEvent);
          job.resolve();
        } catch (err) {
          job.reject(err);
        } finally {
          activeWorkers--;
          drain();
        }
      };
      run();
    } else {
      // Completion jobs
      const streaming = !!job.onChunk;
      const execFns = {
        local: streaming ? runClaudeLocalStreaming : runClaudeLocal,
        sprite: streaming ? runClaudeSpriteStreaming : runClaudeOnSprite,
        vercel: streaming ? runClaudeVercelStreaming : runClaudeOnVercel,
      };
      const execFn = execFns[BACKEND];
      const execArgs = streaming
        ? [job.prompt, job.systemPrompt, job.onChunk, job.token]
        : [job.prompt, job.systemPrompt, job.token];

      const canRetry = !streaming && BACKEND !== "local";

      const run = async () => {
        try {
          const result = await execFn(...execArgs);
          job.resolve(result);
        } catch (err) {
          if (canRetry && !job.retried) {
            job.retried = true;
            console.log(`Retrying after error: ${err.message}`);
            await new Promise((r) => setTimeout(r, 1000));
            try {
              const result = await execFn(...execArgs);
              job.resolve(result);
            } catch (retryErr) {
              job.reject(retryErr);
            }
          } else {
            job.reject(err);
          }
        } finally {
          activeWorkers--;
          drain();
        }
      };
      run();
    }
  }
}

// ---------------------------------------------------------------------------
// Auth env helper – resolve per-request token with server fallback
// ---------------------------------------------------------------------------
function buildAuthEnv(clientToken) {
  // Start clean — only set the auth vars we intend, inheriting nothing
  const env = { ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" };
  const token = clientToken || CONFIGURED_API_KEY;
  if (token) {
    // OAuth tokens (sk-ant-oat*) must go to CLAUDE_CODE_OAUTH_TOKEN
    if (token.startsWith("sk-ant-oat")) {
      env.CLAUDE_CODE_OAUTH_TOKEN = token;
    } else {
      env.ANTHROPIC_API_KEY = token;
    }
  } else if (CONFIGURED_OAUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = CONFIGURED_OAUTH_TOKEN;
  }
  return env;
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
// Agent CLI args builder
// ---------------------------------------------------------------------------
function buildAgentCliArgs(opts) {
  const cliArgs = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--max-turns", String(opts.maxTurns || AGENT_MAX_TURNS),
    "--permission-mode", "bypassPermissions",
  ];

  if (opts.sessionId) {
    cliArgs.push("--resume", opts.sessionId);
  }
  if (opts.systemPrompt) {
    cliArgs.push("--system-prompt", opts.systemPrompt);
  }
  if (opts.model) {
    cliArgs.push("--model", opts.model);
  }
  if (opts.allowedTools && opts.allowedTools.length) {
    cliArgs.push("--allowed-tools", opts.allowedTools.join(","));
  }
  if (opts.disallowedTools && opts.disallowedTools.length) {
    cliArgs.push("--disallowed-tools", opts.disallowedTools.join(","));
  }
  if (opts.maxBudgetUsd != null) {
    cliArgs.push("--max-budget-usd", String(opts.maxBudgetUsd));
  }
  if (opts.includePartialMessages) {
    cliArgs.push("--include-partial-messages");
  }

  // MCP config: merge operator defaults with per-request
  const mcpConfig = {};
  if (AGENT_MCP_CONFIG) {
    try {
      Object.assign(mcpConfig, JSON.parse(AGENT_MCP_CONFIG));
    } catch {
      console.warn("Warning: invalid --agent-mcp-config JSON, ignoring");
    }
  }
  if (opts.mcpServers && typeof opts.mcpServers === "object") {
    Object.assign(mcpConfig, opts.mcpServers);
  }
  if (Object.keys(mcpConfig).length > 0) {
    cliArgs.push("--mcp-config", JSON.stringify({ mcpServers: mcpConfig }));
  }

  return cliArgs;
}

// ---------------------------------------------------------------------------
// Agent event sanitizer
// ---------------------------------------------------------------------------
function sanitizeEvent(event) {
  if (!event || typeof event !== "object") return event;

  if (event.type === "system" && event.subtype === "init") {
    const sanitized = { ...event };
    // Keep tool names only, strip install paths
    if (sanitized.tools) {
      sanitized.tools = sanitized.tools.map((t) =>
        typeof t === "string" ? t : { name: t.name, type: t.type },
      );
    }
    // Keep MCP server names only
    if (sanitized.mcp_servers && typeof sanitized.mcp_servers === "object") {
      sanitized.mcp_servers = Object.keys(sanitized.mcp_servers);
    }
    // Strip local paths and sensitive fields
    delete sanitized.cwd;
    delete sanitized.plugin_paths;
    delete sanitized.uuid;
    // Strip plugin install paths, keep names only
    if (sanitized.plugins) {
      sanitized.plugins = sanitized.plugins.map((p) =>
        typeof p === "string" ? p : { name: p.name },
      );
    }
    return sanitized;
  }

  return event;
}

// ---------------------------------------------------------------------------
// Agent NDJSON line parser helper
// ---------------------------------------------------------------------------
function parseNDJSONLines(buffer, onLine) {
  const lines = buffer.split("\n");
  const remainder = lines.pop(); // keep incomplete line
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      onLine(JSON.parse(line));
    } catch {
      // skip non-JSON lines
    }
  }
  return remainder;
}

// ---------------------------------------------------------------------------
// CLI Providers
// ---------------------------------------------------------------------------
const claudeProvider = {
  name: "claude",
  command: "claude",
  promptViaStdin: true,
  buildCompletionArgs(systemPrompt) {
    const args = ["-p", "--max-turns", MAX_TURNS, "--output-format", "text"];
    if (systemPrompt) args.push("--system-prompt", systemPrompt);
    return args;
  },
  buildAgentArgs(opts) {
    return buildAgentCliArgs(opts);
  },
  buildAuthEnv: buildAuthEnv,
  wrapPrompt(prompt) {
    return prompt;
  },
  createEventTranslator() {
    return (event) => sanitizeEvent(event);
  },
  errorLabel: "claude",
};

const opencodeProvider = {
  name: "opencode",
  command: "opencode",
  promptViaStdin: false,
  buildCompletionArgs() {
    return ["run"];
  },
  buildAgentArgs(opts) {
    const args = ["run", "--format", "json"];
    if (opts.sessionId) args.push("--session", opts.sessionId);
    if (opts.model) args.push("--model", opts.model);
    if (opts.maxTurns && opts.maxTurns !== AGENT_MAX_TURNS) {
      console.warn(
        `Warning: opencode does not support max_turns (requested ${opts.maxTurns}, ignored)`,
      );
    }
    return args;
  },
  buildAuthEnv(clientToken) {
    const env = {};
    const apiKey = clientToken || CONFIGURED_API_KEY;
    if (apiKey) {
      env.ANTHROPIC_API_KEY = apiKey;
    }
    // Never forward OAuth tokens to opencode per Anthropic ToS
    if (CONFIGURED_OAUTH_TOKEN && !apiKey) {
      console.warn("Warning: Claude OAuth token cannot be used with opencode — set ANTHROPIC_API_KEY instead");
    }
    return env;
  },
  wrapPrompt(prompt, systemPrompt) {
    if (!systemPrompt) return prompt;
    return `Instructions: ${systemPrompt}\n\n---\n\n${prompt}`;
  },
  createEventTranslator() {
    let seenFirstStep = false;
    let sessionId = null;
    let totalCost = 0;
    let totalTokens = { input: 0, output: 0 };
    let stepCount = 0;
    let lastText = "";

    return (event) => {
      if (!event || typeof event !== "object") return null;
      sessionId = event.sessionID || sessionId;

      switch (event.type) {
        case "step_start": {
          stepCount++;
          if (!seenFirstStep) {
            seenFirstStep = true;
            return {
              type: "system",
              subtype: "init",
              session_id: sessionId,
              tools: [],
              mcp_servers: [],
            };
          }
          return null;
        }
        case "text": {
          const text = event.part?.text || "";
          if (text) lastText = text;
          return {
            type: "assistant",
            message: { content: [{ type: "text", text }] },
          };
        }
        case "tool_use": {
          const part = event.part || {};
          return {
            type: "assistant",
            message: {
              content: [{
                type: "tool_use",
                id: part.callID || part.id,
                name: part.tool || "unknown",
                input: part.state?.input || {},
              }],
            },
          };
        }
        case "step_finish": {
          const part = event.part || {};
          totalCost += part.cost || 0;
          if (part.tokens) {
            totalTokens.input += part.tokens.input || 0;
            totalTokens.output += part.tokens.output || 0;
          }
          if (part.reason === "stop") {
            return {
              type: "result",
              session_id: sessionId,
              total_cost_usd: totalCost,
              num_turns: stepCount,
              result: lastText,
              usage: {
                input_tokens: totalTokens.input,
                output_tokens: totalTokens.output,
              },
            };
          }
          return null; // tool-calls step_finish — accumulate cost only
        }
        default:
          return null;
      }
    };
  },
  errorLabel: "opencode",
};

const CLI = CLI_NAME === "opencode" ? opencodeProvider : claudeProvider;

// ---------------------------------------------------------------------------
// Backend: Local subprocess
// ---------------------------------------------------------------------------
function runClaudeLocal(prompt, systemPrompt, clientToken) {
  return new Promise((resolve, reject) => {
    const cliArgs = CLI.buildCompletionArgs(systemPrompt);
    if (!CLI.promptViaStdin) cliArgs.push(CLI.wrapPrompt(prompt, systemPrompt));

    const env = { ...process.env, ...CLI.buildAuthEnv(clientToken) };

    const proc = spawn(CLI.command, cliArgs, {
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
        reject(new Error(stderr || `${CLI.errorLabel} exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      activeProcesses.delete(proc);
      if (settled) return;
      settled = true;
      reject(err);
    });

    if (CLI.promptViaStdin) proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

function runClaudeLocalStreaming(prompt, systemPrompt, onChunk, clientToken) {
  return new Promise((resolve, reject) => {
    const cliArgs = CLI.buildCompletionArgs(systemPrompt);
    if (!CLI.promptViaStdin) cliArgs.push(CLI.wrapPrompt(prompt, systemPrompt));

    const env = { ...process.env, ...CLI.buildAuthEnv(clientToken) };

    const proc = spawn(CLI.command, cliArgs, {
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
      else reject(new Error(stderr || `${CLI.errorLabel} exited with code ${code}`));
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      activeProcesses.delete(proc);
      if (settled) return;
      settled = true;
      reject(err);
    });

    if (CLI.promptViaStdin) proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Backend: Local agent subprocess
// ---------------------------------------------------------------------------
function runAgentLocal(prompt, opts, onEvent) {
  return new Promise((resolve, reject) => {
    const cliArgs = CLI.buildAgentArgs(opts);
    if (!CLI.promptViaStdin) cliArgs.push(CLI.wrapPrompt(prompt, opts.systemPrompt));
    const env = { ...process.env, ...CLI.buildAuthEnv(opts.clientToken) };
    const spawnOpts = { stdio: ["pipe", "pipe", "pipe"], env };
    if (opts.cwd) spawnOpts.cwd = opts.cwd;

    const proc = spawn(CLI.command, cliArgs, spawnOpts);
    activeProcesses.add(proc);

    let settled = false;
    let stderr = "";
    let buffer = "";
    const timeout = opts.timeoutMs || AGENT_TIMEOUT_MS;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGTERM");
      reject(new Error(`Agent timed out after ${timeout}ms`));
    }, timeout);

    // Abort on client disconnect
    if (opts.abortSignal) {
      const onAbort = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          proc.kill("SIGTERM");
          activeProcesses.delete(proc);
          reject(new Error("Agent aborted by client"));
        }
      };
      if (opts.abortSignal.aborted) {
        onAbort();
        return;
      }
      opts.abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    const translate = CLI.createEventTranslator();
    proc.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      buffer = parseNDJSONLines(buffer, (event) => {
        const translated = translate(event);
        if (translated) onEvent(translated);
      });
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      activeProcesses.delete(proc);
      if (settled) return;
      // Flush remaining buffer only if not already settled (e.g. by timeout)
      if (buffer.trim()) {
        try {
          const translated = translate(JSON.parse(buffer.trim()));
          if (translated) onEvent(translated);
        } catch {}
      }
      settled = true;
      if (code === 0) resolve();
      else reject(new Error(stderr || `${CLI.errorLabel} agent exited with code ${code}`));
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      activeProcesses.delete(proc);
      if (settled) return;
      settled = true;
      reject(err);
    });

    if (CLI.promptViaStdin) proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Backend: Sprite exec via REST API
// ---------------------------------------------------------------------------

// Write auth wrapper to sprite filesystem via stdin (keeps token out of URLs,
// avoids shell interpretation of args by using exec with separate cmd params)
// Sprite wrapper: reads env vars from stdin (one per line) until blank line,
// then execs claude with remaining stdin as the prompt. No credentials on
// disk or in URLs — auth flows per-request through the POST body.
const SPRITE_WRAPPER_SCRIPT = [
  "#!/bin/bash",
  'while IFS= read -r line; do [ -z "$line" ] && break; export "$line"; done',
  'exec claude "$@"',
].join("\n");

async function initSpriteSetup(spriteName) {
  const params = new URLSearchParams();
  params.append("cmd", "bash");
  params.append("cmd", "-c");
  params.append(
    "cmd",
    "printf '%s' '" +
      SPRITE_WRAPPER_SCRIPT.replace(/'/g, "'\\''") +
      "' > ~/.claude-wrapper && chmod +x ~/.claude-wrapper",
  );

  const url = `${SPRITE_API}/v1/sprites/${encodeURIComponent(
    spriteName,
  )}/exec?${params.toString()}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${SPRITE_TOKEN}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to init sprite: ${await res.text()}`);
  }
}

async function cleanupSpriteAuth(spriteName) {
  const params = new URLSearchParams();
  params.append("cmd", "rm");
  params.append("cmd", "-f");
  params.append("cmd", "/home/sprite/.claude-wrapper");
  params.append("cmd", "/home/sprite/.claude-env");

  const url = `${SPRITE_API}/v1/sprites/${encodeURIComponent(
    spriteName,
  )}/exec?${params.toString()}`;

  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${SPRITE_TOKEN}` },
  }).catch((err) => {
    console.warn(`Warning: failed to clean up sprite for ${spriteName}: ${err.message}`);
  });
}

async function initSprites() {
  // Clean stale files from any previous crash
  console.log("Cleaning stale sprite files...");
  await Promise.all(SPRITE_NAMES.map((name) => cleanupSpriteAuth(name)));
  console.log("Initializing sprites...");
  await Promise.all(SPRITE_NAMES.map((name) => initSpriteSetup(name)));
  console.log("Sprites ready.");
}

// Build the POST body for sprite exec: env vars + blank line + prompt
// Credentials flow via stdin (POST body), never in URLs or on disk
function buildSpriteBody(clientToken, prompt) {
  const authEnv = buildAuthEnv(clientToken);
  const envLines = [];
  for (const [key, val] of Object.entries(authEnv)) {
    if (val) envLines.push(`${key}=${val}`);
  }
  return envLines.join("\n") + "\n\n" + prompt;
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

async function runClaudeOnSprite(prompt, systemPrompt, clientToken) {
  const sprite = acquireSprite();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = buildSpriteExecUrl(sprite.name, systemPrompt);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SPRITE_TOKEN}`,
        "Content-Type": "text/plain",
        Accept: "application/json",
      },
      body: buildSpriteBody(clientToken, prompt),
      signal: controller.signal,
    });

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
    clearTimeout(timer);
    releaseSprite(sprite);
  }
}

async function runClaudeSpriteStreaming(prompt, systemPrompt, onChunk, clientToken) {
  const sprite = acquireSprite();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const url = buildSpriteExecUrl(sprite.name, systemPrompt);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SPRITE_TOKEN}`,
        "Content-Type": "text/plain",
        Accept: "application/json",
      },
      body: buildSpriteBody(clientToken, prompt),
      signal: controller.signal,
    });

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
    clearTimeout(timer);
    releaseSprite(sprite);
  }
}

// ---------------------------------------------------------------------------
// Backend: Sprite agent exec
// ---------------------------------------------------------------------------
function buildSpriteAgentExecUrl(spriteName, opts) {
  const cliArgs = buildAgentCliArgs(opts);
  const params = new URLSearchParams();
  params.append("cmd", "/home/sprite/.claude-wrapper");
  for (const arg of cliArgs) {
    params.append("cmd", arg);
  }
  params.append("stdin", "true");
  return `${SPRITE_API}/v1/sprites/${encodeURIComponent(spriteName)}/exec?${params.toString()}`;
}

async function runAgentOnSprite(prompt, opts, onEvent) {

  // Session affinity: if resuming, try to use the same sprite
  let sprite;
  if (opts.sessionId && sessionToSprite.has(opts.sessionId)) {
    const spriteName = sessionToSprite.get(opts.sessionId);
    sprite = spritePool.find((s) => s.name === spriteName);
    if (sprite) {
      sprite.busy++;
      sessionTimestamps.set(opts.sessionId, Date.now()); // refresh TTL
    } else {
      sprite = acquireSprite();
    }
  } else {
    sprite = acquireSprite();
  }

  const controller = new AbortController();
  const timeout = opts.timeoutMs || AGENT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeout);

  // Abort on client disconnect
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const url = buildSpriteAgentExecUrl(sprite.name, opts);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SPRITE_TOKEN}`,
        "Content-Type": "text/plain",
        Accept: "application/json",
      },
      body: buildSpriteBody(opts.clientToken, prompt),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Sprite agent exec failed (${response.status}): ${await response.text()}`);
    }

    const contentType = response.headers.get("content-type") || "";

    const trackSession = (event) => {
      if (event.type === "system" && event.subtype === "init" && event.session_id) {
        sessionToSprite.set(event.session_id, sprite.name);
        sessionTimestamps.set(event.session_id, Date.now());
      }
    };

    if (contentType.includes("application/json")) {
      const result = await response.json();
      if (result.exit_code && result.exit_code !== 0) {
        throw new Error(result.stderr || `claude agent exited with code ${result.exit_code}`);
      }
      // Parse NDJSON from stdout
      const lines = (result.stdout || "").split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          trackSession(event);
          onEvent(sanitizeEvent(event));
        } catch {}
      }
    } else {
      // Streamed binary — sprite exec uses framing bytes (0x01=stdout, 0x02=stderr, 0x03=exit)
      // Strip framing before parsing NDJSON
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: false });
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const raw = decoder.decode(value, { stream: true });
        buffer += raw.replace(CONTROL_CHARS, "");
        buffer = parseNDJSONLines(buffer, (event) => {
          trackSession(event);
          onEvent(sanitizeEvent(event));
        });
      }
    }
  } finally {
    clearTimeout(timer);
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
  cmdArgs.push("--", prompt); // -- prevents prompt from being parsed as a flag
  return cmdArgs;
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

async function vercelStreamLogs(sandboxId, cmdId, onStdout, onStderr, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

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
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          console.warn(`Skipping non-JSON log line: ${line.slice(0, 100)}`);
          continue;
        }
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
  // Mutex: if already being replaced, wait for the existing replacement
  if (sandbox.replacing) {
    await sandbox._replacePromise;
    if (sandbox.dead) throw new Error("Sandbox replacement failed permanently");
    return;
  }
  sandbox.replacing = true;
  sandbox._replacePromise = (async () => {
    console.log(`Replacing dead sandbox ${sandbox.id}...`);
    await stopVercelSandbox(sandbox.id);
    try {
      const newSbx = await createVercelSandbox();
      sandbox.id = newSbx.id;
      sandbox.dead = false;
      console.log(`Replaced with ${newSbx.id}`);
    } catch (err) {
      sandbox.dead = true;
      console.error(`Failed to replace sandbox: ${err.message}`);
      throw err;
    } finally {
      sandbox.replacing = false;
      sandbox._replacePromise = null;
    }
  })();
  await sandbox._replacePromise;
}

async function runClaudeOnVercel(prompt, systemPrompt, clientToken) {
  const sandbox = acquireVercelSandbox();
  try {
    const cmdArgs = buildVercelClaudeArgs(prompt, systemPrompt);
    const env = buildAuthEnv(clientToken);
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

async function runClaudeVercelStreaming(prompt, systemPrompt, onChunk, clientToken) {
  const sandbox = acquireVercelSandbox();
  try {
    const cmdArgs = buildVercelClaudeArgs(prompt, systemPrompt);
    const env = buildAuthEnv(clientToken);
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
// Backend: Vercel agent exec
// ---------------------------------------------------------------------------
async function runAgentOnVercel(prompt, opts, onEvent) {
  // Session affinity: if resuming, try to use the same sandbox
  let sandbox;
  if (opts.sessionId && sessionToSandbox.has(opts.sessionId)) {
    const sandboxId = sessionToSandbox.get(opts.sessionId);
    sandbox = vercelPool.find((s) => s.id === sandboxId && !s.replacing);
    if (sandbox) {
      sandbox.busy++;
      sessionTimestamps.set(opts.sessionId, Date.now()); // refresh TTL
    } else {
      sessionToSandbox.delete(opts.sessionId);
      sandbox = acquireVercelSandbox();
    }
  } else {
    sandbox = acquireVercelSandbox();
  }

  try {
    const cliArgs = buildAgentCliArgs(opts);
    cliArgs.push("--", prompt); // -- prevents prompt from being parsed as a flag
    const env = buildAuthEnv(opts.clientToken);

    let cmdId;
    try {
      cmdId = await vercelExec(sandbox.id, cliArgs, env);
    } catch (err) {
      if (
        err.message.includes("sandbox_stopped") ||
        err.message.includes("not found")
      ) {
        // Clear stale session mappings for this sandbox
        for (const [sid, sbxId] of sessionToSandbox) {
          if (sbxId === sandbox.id) sessionToSandbox.delete(sid);
        }
        await replaceVercelSandbox(sandbox);
        cmdId = await vercelExec(sandbox.id, cliArgs, env);
      } else {
        throw err;
      }
    }

    const timeout = opts.timeoutMs || AGENT_TIMEOUT_MS;
    let buffer = "";
    const trackSession = (event) => {
      if (event.type === "system" && event.subtype === "init" && event.session_id) {
        sessionToSandbox.set(event.session_id, sandbox.id);
        sessionTimestamps.set(event.session_id, Date.now());
      }
    };

    await vercelStreamLogs(
      sandbox.id,
      cmdId,
      (data) => {
        buffer += data;
        buffer = parseNDJSONLines(buffer, (event) => {
          trackSession(event);
          onEvent(sanitizeEvent(event));
        });
      },
      (data) => {
        // stderr — could log for debugging
      },
      timeout,
    );

    const code = await vercelExitCode(sandbox.id, cmdId);
    if (code !== 0) {
      throw new Error(`claude agent exited with code ${code}`);
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

function buildModelObject(id) {
  return {
    id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "local",
    capabilities: { chat: true, completions: true, agent: true, embeddings: false },
    context_length: 200000,
    max_output_tokens: 16384,
  };
}

function buildOpenAIModelsResponse() {
  return {
    object: "list",
    data: [buildModelObject(MODEL_NAME)],
  };
}

function errorResponse(status, message, type = "invalid_request_error") {
  return { status, body: { error: { message, type, code: status } } };
}

// ---------------------------------------------------------------------------
// Embeddings stub — deterministic hash-based pseudo-embeddings
// ---------------------------------------------------------------------------
const EMBEDDING_DIM = 1536; // Match OpenAI ada-002 dimension

function hashEmbedding(text) {
  // Generate a deterministic float vector from text via repeated hashing
  const vec = new Float64Array(EMBEDDING_DIM);
  let hash = createHash("sha256").update(text).digest();
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    if (i % 32 === 0 && i > 0) {
      hash = createHash("sha256").update(hash).digest();
    }
    // Convert byte to float in [-1, 1]
    vec[i] = (hash[i % 32] / 127.5) - 1;
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  const result = [];
  for (let i = 0; i < EMBEDDING_DIM; i++) result.push(vec[i] / norm);
  return result;
}

function buildEmbeddingResponse(inputs, model) {
  const data = inputs.map((text, i) => ({
    object: "embedding",
    index: i,
    embedding: hashEmbedding(typeof text === "string" ? text : String(text)),
  }));
  return {
    object: "list",
    data,
    model: model || MODEL_NAME,
    usage: { prompt_tokens: 0, total_tokens: 0 },
  };
}

// ---------------------------------------------------------------------------
// OpenAI Responses API builder
// ---------------------------------------------------------------------------
function extractResponsesPrompt(body) {
  const input = body.input;
  if (!input) return { prompt: null, systemPrompt: null };

  // String input
  if (typeof input === "string") {
    return { prompt: input, systemPrompt: body.instructions || null };
  }

  // Array of message objects
  if (Array.isArray(input)) {
    let systemPrompt = body.instructions || null;
    const parts = [];
    for (const item of input) {
      // String item in array
      if (typeof item === "string") {
        parts.push(`user: ${item}`);
        continue;
      }
      if (item.role === "system" || item.role === "developer") {
        const text = typeof item.content === "string"
          ? item.content
          : Array.isArray(item.content)
            ? item.content.map((c) => c.text || "").join("\n")
            : "";
        systemPrompt = systemPrompt ? `${systemPrompt}\n${text}` : text;
      } else {
        const text = typeof item.content === "string"
          ? item.content
          : Array.isArray(item.content)
            ? item.content.map((c) => c.text || "").join("\n")
            : "";
        parts.push(`${item.role}: ${text}`);
      }
    }
    return { prompt: parts.join("\n\n") || null, systemPrompt };
  }

  return { prompt: null, systemPrompt: null };
}

function buildResponsesResponse(text, model) {
  const id = `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  return {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    model: model || MODEL_NAME,
    status: "completed",
    output: [
      {
        type: "message",
        id: `msg_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  };
}

async function handleResponsesStream(
  req, res, start, prompt, systemPrompt, model, clientToken,
) {
  const respId = `resp_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const msgId = `msg_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const m = model || MODEL_NAME;
  const created = Math.floor(Date.now() / 1000);

  initSSE(res, req, start);

  // response.created
  sseEvent(res, "response.created", {
    type: "response.created",
    response: {
      id: respId, object: "response", created_at: created, model: m,
      status: "in_progress", output: [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    },
  });

  // output_item.added
  sseEvent(res, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: {
      type: "message", id: msgId, role: "assistant",
      status: "in_progress", content: [],
    },
  });

  // content_part.added
  sseEvent(res, "response.content_part.added", {
    type: "response.content_part.added",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "" },
  });

  let fullText = "";
  try {
    await enqueue(prompt, systemPrompt, {
      token: clientToken,
      onChunk: (text) => {
        fullText += text;
        sseEvent(res, "response.output_text.delta", {
          type: "response.output_text.delta",
          output_index: 0,
          content_index: 0,
          delta: text,
        });
      },
    });

    // content_part.done
    sseEvent(res, "response.content_part.done", {
      type: "response.content_part.done",
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: fullText },
    });

    // output_item.done
    sseEvent(res, "response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "message", id: msgId, role: "assistant",
        status: "completed", content: [{ type: "output_text", text: fullText }],
      },
    });

    // response.completed
    sseEvent(res, "response.completed", {
      type: "response.completed",
      response: {
        id: respId, object: "response", created_at: created, model: m,
        status: "completed", output: [{
          type: "message", id: msgId, role: "assistant",
          status: "completed", content: [{ type: "output_text", text: fullText }],
        }],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
    });
  } catch (err) {
    sseEvent(res, "error", {
      type: "error",
      error: { message: err.message, type: "server_error", code: "server_error" },
    });
  }

  res.end();
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
  clientToken,
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
    await enqueue(prompt, systemPrompt, { token: clientToken, onChunk: (text) => {
      sseData(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model: m,
        choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
      });
    }});

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

async function handleOpenAICompletionsStream(req, res, start, prompt, model, clientToken) {
  const id = `cmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const m = model || MODEL_NAME;

  initSSE(res, req, start);

  try {
    await enqueue(prompt, null, { token: clientToken, onChunk: (text) => {
      sseData(res, {
        id,
        object: "text_completion",
        created,
        model: m,
        choices: [{ index: 0, text, finish_reason: null }],
      });
    }});

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
  clientToken,
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
    await enqueue(prompt, systemPrompt, { token: clientToken, onChunk: (text) => {
      sseEvent(res, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      });
    }});

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
// Agent SSE streaming handler
// ---------------------------------------------------------------------------
async function handleAgentStream(req, res, start, prompt, agentOpts) {
  initSSE(res, req, start);

  const keepalive = setInterval(() => {
    if (!res.writableEnded) res.write(":ping\n\n");
  }, 15000);

  let aborted = false;
  const abortController = new AbortController();

  res.on("close", () => {
    aborted = true;
    abortController.abort();
    clearInterval(keepalive);
  });

  agentOpts.abortSignal = abortController.signal;

  try {
    await enqueueAgent(prompt, {
      ...agentOpts,
      onEvent: (event) => {
        if (aborted) return;
        sseEvent(res, event.type || "message", event);
      },
    });

    if (!aborted) {
      res.write("event: done\ndata: [DONE]\n\n");
      res.end();
    }
  } catch (err) {
    if (!aborted) {
      sseEvent(res, "error", {
        type: "error",
        error: { message: err.message, type: "server_error" },
      });
      res.write("event: done\ndata: [DONE]\n\n");
      res.end();
    }
  } finally {
    clearInterval(keepalive);
  }
}

// ---------------------------------------------------------------------------
// Agent buffered (non-streaming) handler
// ---------------------------------------------------------------------------
async function handleAgentBuffered(req, res, start, prompt, agentOpts, sendJSON) {
  const events = [];
  let sessionId = null;
  let totalCostUsd = 0;
  let numTurns = 0;
  let resultText = "";
  let usage = {};

  try {
    await enqueueAgent(prompt, {
      ...agentOpts,
      onEvent: (event) => {
        events.push(event);

        if (event.type === "system" && event.subtype === "init") {
          sessionId = event.session_id;
        }
        if (event.type === "result") {
          sessionId = event.session_id || sessionId;
          totalCostUsd = event.total_cost_usd || 0;
          numTurns = event.num_turns || 0;
          usage = event.usage || {};
          resultText = event.result || resultText;
        }
        // Extract text from assistant messages
        if (event.type === "assistant" && event.message) {
          const textBlocks = (event.message.content || []).filter(
            (b) => b.type === "text",
          );
          if (textBlocks.length > 0) {
            resultText = textBlocks.map((b) => b.text).join("\n");
          }
        }
      },
    });

    sendJSON(200, {
      session_id: sessionId,
      result: resultText,
      num_turns: numTurns,
      total_cost_usd: totalCostUsd,
      usage,
      events,
    });
  } catch (err) {
    sendJSON(500, {
      error: { message: err.message, type: "server_error", code: 500 },
    });
  }
}

// ---------------------------------------------------------------------------
// Request parsing
// ---------------------------------------------------------------------------
function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
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
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
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
    if (res.headersSent) {
      console.error(
        `Cannot send ${status} — headers already sent for ${req.method} ${req.url}`,
      );
      return;
    }
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

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "*",
    });
    return res.end();
  }

  // Public routes (no auth required)
  const publicUrl = req.url.split("?")[0];
  if (publicUrl === "/openapi.json" && req.method === "GET") {
    try {
      const specPath = require("path").join(__dirname, "openapi.json");
      const spec = require("fs").readFileSync(specPath, "utf-8");
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(spec);
      console.log(`${req.method} ${req.url} 200 ${Date.now() - start}ms`);
      return;
    } catch {
      return sendJSON(404, { error: { message: "openapi.json not found", type: "not_found" } });
    }
  }

  if (publicUrl === "/docs" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/html",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(`<!DOCTYPE html>
<html>
<head>
  <title>OpenCompletions API</title>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
</head>
<body>
  <div id="app"></div>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
  <script>
    Scalar.createApiReference('#app', {
      url: '/openapi.json',
      download: 'direct'
    })
  </script>
</body>
</html>`);
    console.log(`${req.method} ${req.url} 200 ${Date.now() - start}ms`);
    return;
  }

  // Extract auth: Bearer token for server auth, x-api-key for backend forwarding
  const authHeader = req.headers.authorization || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const xApiKey = req.headers["x-api-key"] || "";

  if (API_KEY) {
    // Bearer token must match the server API key
    const a = Buffer.from(bearerToken || xApiKey);
    const b = Buffer.from(API_KEY);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return sendJSON(401, {
        error: {
          message: "Invalid API key",
          type: "authentication_error",
          code: 401,
        },
      });
    }
  }

  // x-api-key is forwarded to the backend as the provider token (any provider)
  const forwardToken = xApiKey || null;

  let url = req.url.split("?")[0];

  // Normalize prefix-less routes: /chat/completions → /v1/chat/completions
  // Many SDKs set base_url with or without /v1/, causing 404s
  const V1_ROUTES = [
    "/chat/completions", "/completions", "/models", "/messages",
    "/messages/count_tokens", "/agent", "/embeddings", "/responses", "/status",
  ];
  for (const route of V1_ROUTES) {
    if (url === route || (route === "/models" && url.startsWith("/models/"))) {
      url = `/v1${url}`;
      break;
    }
  }

  try {
    // ----- Health / Info -----
    if (url === "/" && req.method === "GET") {
      const info = {
        name: "opencompletions",
        status: "ok",
        cli: CLI.name,
        backend: BACKEND,
        active_workers: activeWorkers,
        queued: queue.length,
        max_concurrency: MAX_CONCURRENCY,
        endpoints: {
          openai_chat: "POST /v1/chat/completions",
          openai_completions: "POST /v1/completions",
          openai_responses: "POST /v1/responses",
          openai_embeddings: "POST /v1/embeddings",
          anthropic_messages: "POST /v1/messages",
          anthropic_count_tokens: "POST /v1/messages/count_tokens",
          agent: "POST /v1/agent",
          openapi_spec: "GET  /openapi.json",
          docs: "GET  /docs",
          models: "GET  /v1/models",
          model_detail: "GET  /v1/models/:id",
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

    // ----- OpenAI: GET /v1/models/:id -----
    if (url.startsWith("/v1/models/") && req.method === "GET") {
      const modelId = decodeURIComponent(url.slice("/v1/models/".length));
      if (modelId === MODEL_NAME) {
        return sendJSON(200, buildModelObject(MODEL_NAME));
      }
      return sendJSON(404, {
        error: {
          message: `The model '${modelId}' does not exist`,
          type: "invalid_request_error",
          code: "model_not_found",
        },
      });
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
          forwardToken,
        );
      }
      const text = await enqueue(prompt, systemPrompt, { token: forwardToken });
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
      let p = typeof prompt === "string" ? prompt : prompt.join("\n");
      // FIM (fill-in-the-middle): wrap prefix + suffix for infill
      if (body.suffix) {
        p = `Complete the code that goes between <prefix> and <suffix>. Return ONLY the infill code, nothing else.\n\n<prefix>\n${p}\n</prefix>\n\n<suffix>\n${body.suffix}\n</suffix>`;
      }
      if (body.stream) {
        return await handleOpenAICompletionsStream(
          req,
          res,
          start,
          p,
          body.model,
          forwardToken,
        );
      }
      const text = await enqueue(p, null, { token: forwardToken });
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
          forwardToken,
        );
      }
      const text = await enqueue(prompt, systemPrompt, { token: forwardToken });
      return sendJSON(200, buildAnthropicResponse(text, body.model));
    }

    // ----- Anthropic: POST /v1/messages/count_tokens -----
    if (url === "/v1/messages/count_tokens" && req.method === "POST") {
      const body = await parseBody(req);
      const { prompt, systemPrompt } = extractAnthropicPrompt(body);
      // Rough estimate: ~4 characters per token
      const inputText = (systemPrompt || "") + (prompt || "");
      const inputTokens = Math.ceil(inputText.length / 4);
      return sendJSON(200, { input_tokens: inputTokens });
    }

    // ----- OpenAI: POST /v1/embeddings -----
    if (url === "/v1/embeddings" && req.method === "POST") {
      const body = await parseBody(req);
      const input = body.input;
      if (!input) {
        const err = errorResponse(400, "input is required");
        return sendJSON(err.status, err.body);
      }
      // Normalize to array
      const inputs = Array.isArray(input) ? input : [input];
      return sendJSON(200, buildEmbeddingResponse(inputs, body.model));
    }

    // ----- OpenAI: POST /v1/responses -----
    if (url === "/v1/responses" && req.method === "POST") {
      const body = await parseBody(req);
      const { prompt, systemPrompt } = extractResponsesPrompt(body);
      if (!prompt) {
        const err = errorResponse(400, "input is required");
        return sendJSON(err.status, err.body);
      }
      if (body.stream) {
        return await handleResponsesStream(
          req, res, start, prompt, systemPrompt, body.model, forwardToken,
        );
      }
      const text = await enqueue(prompt, systemPrompt, { token: forwardToken });
      return sendJSON(200, buildResponsesResponse(text, body.model));
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

    // ----- Agent API: POST /v1/agent -----
    if (url === "/v1/agent" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.prompt) {
        const err = errorResponse(400, "prompt is required");
        return sendJSON(err.status, err.body);
      }

      // Validate unsupported features for non-claude CLIs
      if (CLI.name === "opencode") {
        if (body.allowed_tools?.length)
          return sendJSON(400, { error: { message: "opencode backend does not support allowed_tools", type: "invalid_request_error" } });
        if (body.disallowed_tools?.length)
          return sendJSON(400, { error: { message: "opencode backend does not support disallowed_tools", type: "invalid_request_error" } });
        if (body.max_budget_usd != null)
          return sendJSON(400, { error: { message: "opencode backend does not support max_budget_usd", type: "invalid_request_error" } });
        if (body.mcp_servers && Object.keys(body.mcp_servers).length)
          return sendJSON(400, { error: { message: "opencode backend does not support per-request MCP config", type: "invalid_request_error" } });
      }

      const agentOpts = {
        sessionId: body.session_id || null,
        maxTurns: body.max_turns || AGENT_MAX_TURNS,
        systemPrompt: body.system_prompt || null,
        model: body.model || null,
        allowedTools: body.allowed_tools || null,
        disallowedTools: body.disallowed_tools || null,
        maxBudgetUsd: body.max_budget_usd != null ? body.max_budget_usd : null,
        cwd: body.cwd || null,
        includePartialMessages: body.include_partial_messages || false,
        mcpServers: body.mcp_servers || null,
        clientToken: forwardToken,
        timeoutMs: body.timeout_ms || null,
      };

      const stream = body.stream !== false; // default true

      if (stream) {
        return await handleAgentStream(req, res, start, body.prompt, agentOpts);
      } else {
        return await handleAgentBuffered(
          req,
          res,
          start,
          body.prompt,
          agentOpts,
          sendJSON,
        );
      }
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
║  CLI:         ${CLI.name.padEnd(43)}║
║  Backend:     ${backendInfo.slice(0, 43).padEnd(43)}║
║  Concurrency: ${String(MAX_CONCURRENCY).padEnd(43)}║
║  Timeout:     ${String(TIMEOUT_MS + "ms").padEnd(43)}║
║                                                          ║
║  Endpoints:                                              ║
║    POST /v1/chat/completions      (OpenAI chat)          ║
║    POST /v1/completions           (OpenAI completions)   ║
║    POST /v1/responses             (OpenAI responses)     ║
║    POST /v1/embeddings            (OpenAI embeddings)    ║
║    POST /v1/messages              (Anthropic messages)   ║
║    POST /v1/messages/count_tokens (Anthropic tokens)     ║
║    POST /v1/agent                 (Agent API)            ║
║    GET  /v1/models                (Model list)           ║
║    GET  /v1/models/:id            (Model detail)         ║
║    GET  /v1/status                (Queue status)         ║
║    GET  /openapi.json             (OpenAPI spec)         ║
║    GET  /docs                    (API docs viewer)      ║
║    GET  /                         (Health check)         ║
║    * /v1/ prefix optional on all routes                  ║
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
