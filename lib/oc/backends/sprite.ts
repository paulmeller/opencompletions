/**
 * Sprite backend for the OpenCompletions engine.
 *
 * Delegates execution to Sprites.dev VMs via REST API.
 * Supports pool of multiple sprites with session affinity and workspace binding.
 *
 * Ported from server.js lines 1240-1554.
 */

import { getState, acquireSprite, releaseSprite } from "../state";
import { getConfig } from "../config";
import {
  buildAuthEnv,
  buildAgentCliArgs,
  cleanOutput,
  cleanChunk,
  sanitizeEvent,
  parseNDJSONLines,
  mergeAgentMcpConfig,
} from "../helpers";
import { getCliProvider } from "../cli-providers";
import type { AgentOpts, AgentEvent, SpriteEntry } from "../types";

// ---------------------------------------------------------------------------
// Control chars regex (for stripping sprite framing bytes)
// ---------------------------------------------------------------------------

const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

// ---------------------------------------------------------------------------
// Sprite wrapper script
// ---------------------------------------------------------------------------

/**
 * Sprite wrapper: reads env vars from stdin (one per line) until blank line,
 * then execs claude with remaining stdin as the prompt. No credentials on
 * disk or in URLs -- auth flows per-request through the POST body.
 */
const SPRITE_WRAPPER_SCRIPT = [
  "#!/bin/bash",
  'while IFS= read -r line; do [ -z "$line" ] && break; export "$line"; done',
  'exec claude "$@"',
].join("\n");

// ---------------------------------------------------------------------------
// Initialization and cleanup
// ---------------------------------------------------------------------------

export async function initSpriteSetup(spriteName: string): Promise<void> {
  const config = getConfig();

  const params = new URLSearchParams();
  params.append("cmd", "bash");
  params.append("cmd", "-c");
  params.append(
    "cmd",
    "printf '%s' '" +
      SPRITE_WRAPPER_SCRIPT.replace(/'/g, "'\\''") +
      "' > ~/.claude-wrapper && chmod +x ~/.claude-wrapper",
  );

  const url = `${config.spriteApi}/v1/sprites/${encodeURIComponent(
    spriteName,
  )}/exec?${params.toString()}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.spriteToken}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to init sprite: ${await res.text()}`);
  }
}

export async function cleanupSpriteAuth(spriteName: string): Promise<void> {
  const config = getConfig();

  const params = new URLSearchParams();
  params.append("cmd", "rm");
  params.append("cmd", "-f");
  params.append("cmd", "/home/sprite/.claude-wrapper");
  params.append("cmd", "/home/sprite/.claude-env");

  const url = `${config.spriteApi}/v1/sprites/${encodeURIComponent(
    spriteName,
  )}/exec?${params.toString()}`;

  await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.spriteToken}` },
  }).catch((err) => {
    console.warn(`Warning: failed to clean up sprite for ${spriteName}: ${err.message}`);
  });
}

export async function initSprites(): Promise<void> {
  const config = getConfig();
  const spriteNames = config.spriteNames;

  // Clean stale files from any previous crash
  console.log("Cleaning stale sprite files...");
  await Promise.all(spriteNames.map((name) => cleanupSpriteAuth(name)));
  console.log("Initializing sprites...");
  await Promise.all(spriteNames.map((name) => initSpriteSetup(name)));

  // NOTE: setup commands (e.g. plugin installs) are run by init.ts,
  // which is the single owner of runSpriteSetup() calls.

  console.log("Sprites ready.");
}

// ---------------------------------------------------------------------------
// Body and URL builders
// ---------------------------------------------------------------------------

/**
 * Build the POST body for sprite exec: env vars + blank line + prompt.
 * Credentials flow via stdin (POST body), never in URLs or on disk.
 */
function buildSpriteBody(
  clientToken: string | undefined,
  prompt: string,
  extraEnv?: Record<string, string>,
): string {
  const authEnv = { ...buildAuthEnv(clientToken), ...(extraEnv || {}) };
  const envLines: string[] = [];
  for (const [key, val] of Object.entries(authEnv)) {
    if (val) envLines.push(`${key}=${val}`);
  }
  return envLines.join("\n") + "\n\n" + prompt;
}

function buildSpriteExecUrl(spriteName: string, systemPrompt?: string): string {
  const config = getConfig();

  const params = new URLSearchParams();
  params.append("cmd", "/home/sprite/.claude-wrapper");
  params.append("cmd", "-p");
  params.append("cmd", "--max-turns");
  params.append("cmd", "1");
  params.append("cmd", "--output-format");
  params.append("cmd", "text");
  if (systemPrompt) {
    params.append("cmd", "--system-prompt");
    params.append("cmd", systemPrompt);
  }
  params.append("stdin", "true");
  return `${config.spriteApi}/v1/sprites/${encodeURIComponent(
    spriteName,
  )}/exec?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Buffered single-turn completion
// ---------------------------------------------------------------------------

export async function runClaudeOnSprite(
  prompt: string,
  systemPrompt: string | undefined,
  clientToken?: string | null,
): Promise<string> {
  const config = getConfig();
  const sprite = acquireSprite();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout);

  try {
    const url = buildSpriteExecUrl(sprite.name, systemPrompt);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.spriteToken}`,
        "Content-Type": "text/plain",
        Accept: "application/json",
      },
      body: buildSpriteBody(clientToken ?? undefined, prompt),
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

// ---------------------------------------------------------------------------
// Streaming single-turn completion
// ---------------------------------------------------------------------------

export async function runClaudeSpriteStreaming(
  prompt: string,
  systemPrompt: string | undefined,
  onChunk: (chunk: string) => void,
  clientToken?: string | null,
): Promise<string> {
  const config = getConfig();
  const sprite = acquireSprite();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout);

  try {
    const url = buildSpriteExecUrl(sprite.name, systemPrompt);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.spriteToken}`,
        "Content-Type": "text/plain",
        Accept: "application/json",
      },
      body: buildSpriteBody(clientToken ?? undefined, prompt),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errBody = await response.text();
      throw new Error(`Sprite exec failed (${response.status}): ${errBody}`);
    }

    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      // Buffered JSON response -- send as single chunk
      const result = await response.json();
      if (result.exit_code && result.exit_code !== 0) {
        throw new Error(
          result.stderr || `claude exited with code ${result.exit_code}`,
        );
      }
      const text = cleanChunk(result.stdout || "");
      if (text) onChunk(text);
    } else {
      // Plain text -- stream chunks as they arrive
      const reader = response.body!.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: false });

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = cleanChunk(decoder.decode(value, { stream: true }));
        if (text) onChunk(text);
      }
    }

    return "";
  } finally {
    clearTimeout(timer);
    releaseSprite(sprite);
  }
}

// ---------------------------------------------------------------------------
// Agent exec URL builder
// ---------------------------------------------------------------------------

function buildSpriteAgentExecUrl(
  spriteName: string,
  opts: AgentOpts,
  remoteCwd: string | null,
): string {
  const config = getConfig();
  const cliArgs = buildAgentCliArgs(opts);
  const params = new URLSearchParams();

  if (remoteCwd) {
    // Wrap in bash -c to cd into workspace directory first
    params.append("cmd", "bash");
    params.append("cmd", "-c");
    const escapedArgs = cliArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
    params.append("cmd", `cd ${remoteCwd} && /home/sprite/.claude-wrapper ${escapedArgs}`);
  } else {
    params.append("cmd", "/home/sprite/.claude-wrapper");
    for (const arg of cliArgs) {
      params.append("cmd", arg);
    }
  }
  params.append("stdin", "true");
  return `${config.spriteApi}/v1/sprites/${encodeURIComponent(spriteName)}/exec?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Multi-turn agent
// ---------------------------------------------------------------------------

export async function runAgentOnSprite(
  prompt: string,
  opts: AgentOpts,
  onEvent?: (event: AgentEvent) => void,
): Promise<void> {
  const config = getConfig();
  const state = getState();
  const CLI = getCliProvider(config.cli);

  // Workspace binding takes priority, then session affinity, then acquire
  let sprite: SpriteEntry;
  if (opts.workspaceId && state.workspaceToSprite.has(opts.workspaceId)) {
    const spriteName = state.workspaceToSprite.get(opts.workspaceId)!;
    const found = state.spritePool.find((s) => s.name === spriteName);
    if (!found) {
      sprite = acquireSprite();
    } else {
      sprite = found;
      sprite.busy++;
    }
  } else if (opts.sessionId && state.sessionToSprite.has(opts.sessionId)) {
    const spriteName = state.sessionToSprite.get(opts.sessionId)!;
    const found = state.spritePool.find((s) => s.name === spriteName);
    if (found) {
      sprite = found;
      sprite.busy++;
      state.sessionTimestamps.set(opts.sessionId, Date.now()); // refresh TTL
    } else {
      sprite = acquireSprite();
    }
  } else {
    sprite = acquireSprite();
  }

  const controller = new AbortController();
  const timeout = opts.timeoutMs || config.agentTimeout;
  const timer = setTimeout(() => controller.abort(), timeout);

  // Abort on client disconnect
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const remoteCwd = opts.workspaceCwd || null;
    const url = buildSpriteAgentExecUrl(sprite.name, opts, remoteCwd);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.spriteToken}`,
        "Content-Type": "text/plain",
        Accept: "application/json",
      },
      body: buildSpriteBody(opts.clientToken, prompt, CLI.buildMcpEnv(opts)),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Sprite agent exec failed (${response.status}): ${await response.text()}`);
    }

    const contentType = response.headers.get("content-type") || "";

    const trackSession = (event: AgentEvent) => {
      if (event.type === "system" && event.subtype === "init" && event.session_id) {
        state.sessionToSprite.set(event.session_id, sprite.name);
        state.sessionTimestamps.set(event.session_id, Date.now());
      }
    };

    if (contentType.includes("application/json")) {
      const result = await response.json();
      if (result.exit_code && result.exit_code !== 0) {
        throw new Error(result.stderr || `claude agent exited with code ${result.exit_code}`);
      }
      // Parse NDJSON from stdout
      const lines = ((result.stdout || "") as string).split("\n");
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as AgentEvent;
          trackSession(event);
          const sanitized = sanitizeEvent(event);
          if (sanitized && onEvent) onEvent(sanitized);
        } catch {}
      }
    } else {
      // Streamed binary -- sprite exec uses framing bytes (0x01=stdout, 0x02=stderr, 0x03=exit)
      // Strip framing before parsing NDJSON
      const reader = response.body!.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: false });
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const raw = decoder.decode(value, { stream: true });
        buffer += raw.replace(CONTROL_CHARS, "");
        buffer = parseNDJSONLines(buffer, (parsed) => {
          const event = parsed as unknown as AgentEvent;
          trackSession(event);
          const sanitized = sanitizeEvent(event);
          if (sanitized && onEvent) onEvent(sanitized);
        });
      }
    }
  } finally {
    clearTimeout(timer);
    releaseSprite(sprite);
  }
}
