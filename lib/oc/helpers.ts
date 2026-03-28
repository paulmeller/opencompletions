/**
 * Utility functions for the OpenCompletions engine.
 *
 * Ported from server.js: buildAuthEnv, cleanOutput, cleanChunk,
 * buildAgentCliArgs, mergeAgentMcpConfig, mcpConfigToOpenCode,
 * sanitizeEvent, parseNDJSONLines, getFirstJson,
 * normalizeResponseFormat, applyJsonFormat.
 */

import { getConfig } from "./config";
import type { AgentOpts, AgentEvent, McpServerConfig } from "./types";

// ---------------------------------------------------------------------------
// Custom env validation and merging
// ---------------------------------------------------------------------------

const ENV_BLOCKLIST = new Set([
  "PATH", "HOME", "USER", "SHELL", "TERM", "TMPDIR", "TEMP", "TMP",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS", "NODE_PATH",
  "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY",
  "OPENCODE_CONFIG_CONTENT", "CODEX_API_KEY", "GEMINI_API_KEY",
]);

const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const MAX_ENV_VARS = 50;
const MAX_ENV_SIZE = 64 * 1024;

export function validateCustomEnv(env: Record<string, string>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const entries = Object.entries(env);

  if (entries.length > MAX_ENV_VARS) {
    errors.push(`Too many env vars (${entries.length}, max ${MAX_ENV_VARS})`);
  }

  let totalSize = 0;
  for (const [key, value] of entries) {
    if (!ENV_KEY_RE.test(key)) {
      errors.push(`Invalid env var name: "${key}" (must be uppercase with underscores)`);
    }
    if (ENV_BLOCKLIST.has(key)) {
      errors.push(`Blocked env var: "${key}"`);
    }
    totalSize += key.length + String(value).length;
  }

  if (totalSize > MAX_ENV_SIZE) {
    errors.push(`Env vars too large (${totalSize} bytes, max ${MAX_ENV_SIZE})`);
  }

  return { valid: errors.length === 0, errors };
}

export function buildCustomEnv(opts: { env?: Record<string, string> }): Record<string, string> {
  const config = getConfig();
  const serverEnv = config.customEnv || {};
  const requestEnv = opts.env || {};

  // Merge: per-request overrides server defaults
  const merged = { ...serverEnv, ...requestEnv };

  // Strip blocklisted vars
  for (const key of ENV_BLOCKLIST) {
    delete merged[key];
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Regex for stripping terminal artifacts
// ---------------------------------------------------------------------------

const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;
const ANSI_ESCAPES = /\x1B\[[0-9;]*[a-zA-Z]/g;

// ---------------------------------------------------------------------------
// Auth env helper
// ---------------------------------------------------------------------------

/**
 * Resolve per-request token with server-configured fallback.
 * OAuth tokens (sk-ant-oat*) go to CLAUDE_CODE_OAUTH_TOKEN;
 * everything else goes to ANTHROPIC_API_KEY.
 *
 * Ported from server.js lines 380-395.
 */
export function buildAuthEnv(clientToken?: string): Record<string, string> {
  const config = getConfig();
  // Start clean — only set the auth vars we intend, inheriting nothing
  const env: Record<string, string> = {
    ANTHROPIC_API_KEY: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
  };

  const token = clientToken || config.anthropicApiKey;
  if (token) {
    // OAuth tokens (sk-ant-oat*) must go to CLAUDE_CODE_OAUTH_TOKEN
    if (token.startsWith("sk-ant-oat")) {
      env.CLAUDE_CODE_OAUTH_TOKEN = token;
    } else {
      env.ANTHROPIC_API_KEY = token;
    }
  } else if (config.claudeToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = config.claudeToken;
  }

  return env;
}

// ---------------------------------------------------------------------------
// Output cleaning
// ---------------------------------------------------------------------------

/** Strip ANSI escapes and control characters, then trim. (server.js lines 400-402) */
export function cleanOutput(text: string): string {
  return text.replace(ANSI_ESCAPES, "").replace(CONTROL_CHARS, "").trim();
}

/** Strip ANSI escapes and control characters (no trim). (server.js lines 404-406) */
export function cleanChunk(text: string): string {
  return text.replace(ANSI_ESCAPES, "").replace(CONTROL_CHARS, "");
}

// ---------------------------------------------------------------------------
// Agent CLI args builder
// ---------------------------------------------------------------------------

/**
 * Build Claude CLI args for a multi-turn agent run.
 * Ported from server.js lines 411-449.
 */
export function buildAgentCliArgs(opts: AgentOpts): string[] {
  const config = getConfig();

  const cliArgs: string[] = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--max-turns", String(opts.maxTurns || config.agentMaxTurns),
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

  // MCP config: merge operator defaults with per-request (Claude uses --mcp-config flag)
  const mcpConfig = mergeAgentMcpConfig(opts);
  if (Object.keys(mcpConfig).length > 0) {
    cliArgs.push("--mcp-config", JSON.stringify({ mcpServers: mcpConfig }));
  }

  return cliArgs;
}

// ---------------------------------------------------------------------------
// MCP config merging
// ---------------------------------------------------------------------------

/**
 * Merge operator-default and per-request MCP server configs.
 * Returns a plain object of server definitions (keyed by server name).
 *
 * Ported from server.js lines 455-468.
 */
export function mergeAgentMcpConfig(opts: AgentOpts): Record<string, McpServerConfig> {
  const mcpConfig: Record<string, McpServerConfig> = {};

  // Note: in the dashboard, operator-default MCP config could be stored as a
  // setting in the future. For now we only merge per-request config.
  if (opts.mcpServers && typeof opts.mcpServers === "object") {
    Object.assign(mcpConfig, opts.mcpServers);
  }

  return mcpConfig;
}

/**
 * Convert a merged MCP config object to OpenCode's format for OPENCODE_CONFIG_CONTENT.
 * Maps: "stdio" -> "local", "http"/"sse" -> "remote", preserving other fields.
 *
 * Ported from server.js lines 474-492.
 */
export function mcpConfigToOpenCode(mcpConfig: Record<string, McpServerConfig>): Record<string, McpServerConfig> {
  const mcp: Record<string, McpServerConfig> = {};

  for (const [name, server] of Object.entries(mcpConfig)) {
    const entry: McpServerConfig = { ...server };

    // Map transport types: Claude -> OpenCode
    if (entry.type === "stdio") {
      entry.type = "local";
      // stdio uses "command" (string) + "args" (array) -> opencode uses "command" (array)
      if (typeof entry.command === "string") {
        entry.command = [entry.command, ...(entry.args || [])];
      }
      delete entry.args;
    } else if (entry.type === "http" || entry.type === "sse") {
      entry.type = "remote";
    }

    mcp[name] = entry;
  }

  return mcp;
}

// ---------------------------------------------------------------------------
// Agent event sanitizer
// ---------------------------------------------------------------------------

/**
 * Strip sensitive / verbose fields from agent events before sending to clients.
 * Ported from server.js lines 497-526.
 */
export function sanitizeEvent(event: AgentEvent | null): AgentEvent | null {
  if (!event || typeof event !== "object") return event;

  if (event.type === "system" && event.subtype === "init") {
    const sanitized: AgentEvent = { ...event };

    // Keep tool names only, strip install paths
    if (sanitized.tools) {
      sanitized.tools = (sanitized.tools as Array<string | { name: string; type?: string }>).map((t) =>
        typeof t === "string" ? t : { name: t.name, type: t.type },
      );
    }

    // Keep MCP server names only
    if (sanitized.mcp_servers && typeof sanitized.mcp_servers === "object" && !Array.isArray(sanitized.mcp_servers)) {
      sanitized.mcp_servers = Object.keys(sanitized.mcp_servers);
    }

    // Strip local paths and sensitive fields
    delete sanitized.cwd;
    delete sanitized.plugin_paths;
    delete sanitized.uuid;

    // Strip plugin install paths, keep names only
    if (Array.isArray((sanitized as Record<string, unknown>).plugins)) {
      (sanitized as Record<string, unknown>).plugins = (
        (sanitized as Record<string, unknown>).plugins as Array<string | { name: string }>
      ).map((p) => (typeof p === "string" ? p : { name: p.name }));
    }

    return sanitized;
  }

  return event;
}

// ---------------------------------------------------------------------------
// NDJSON line parser
// ---------------------------------------------------------------------------

/**
 * Split a buffer of NDJSON lines, parse each, call onLine for valid JSON objects.
 * Returns the incomplete trailing portion (for buffering).
 *
 * Ported from server.js lines 531-543.
 */
export function parseNDJSONLines(
  buffer: string,
  onLine: (parsed: Record<string, unknown>) => void,
): string {
  const lines = buffer.split("\n");
  const remainder = lines.pop()!; // keep incomplete line
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
// JSON response format utilities
// ---------------------------------------------------------------------------

/**
 * Extract the first valid JSON object or array from a string.
 * Handles markdown fences, surrounding prose, nested braces.
 * Returns { json, raw } or null.
 *
 * Ported from server.js lines 554-609.
 */
export function getFirstJson(text: string): { json: Record<string, unknown> | unknown[]; raw: string } | null {
  if (!text || typeof text !== "string") return null;

  // 1. Try markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (typeof parsed === "object" && parsed !== null) {
        return { json: parsed, raw: fenceMatch[1].trim() };
      }
    } catch { /* fall through */ }
  }

  // 2. Try the entire string
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) {
      return { json: parsed, raw: trimmed };
    }
  } catch { /* fall through */ }

  // 3. Scan for first { or [ and match its closing counterpart
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch !== "{" && ch !== "[") continue;
    const close = ch === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let j = i; j < trimmed.length; j++) {
      const c = trimmed[j];
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === ch) depth++;
      if (c === close) {
        depth--;
        if (depth === 0) {
          const candidate = trimmed.slice(i, j + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (typeof parsed === "object" && parsed !== null) {
              return { json: parsed, raw: candidate };
            }
          } catch { /* fall through */ }
          break;
        }
      }
    }
  }

  return null;
}

/**
 * Normalize a response_format value (string or object) to "text" or "json".
 * Ported from server.js lines 611-616.
 */
export function normalizeResponseFormat(
  responseFormat?: string | { type: string } | null,
): "text" | "json" {
  if (!responseFormat) return "text";
  if (typeof responseFormat === "string") return responseFormat === "json" ? "json" : "text";
  if (typeof responseFormat === "object" && responseFormat.type === "json_object") return "json";
  return "text";
}

/**
 * If the response format is JSON, try to extract valid JSON from the result text.
 * Returns { result, json_error? }.
 *
 * Ported from server.js lines 618-623.
 */
export function applyJsonFormat(resultText: string): { result: string; json_error?: string } {
  if (!resultText) return { result: resultText, json_error: "Empty response" };
  const extracted = getFirstJson(resultText);
  if (extracted) return { result: JSON.stringify(extracted.json) };
  return { result: resultText, json_error: "Could not extract valid JSON from agent response" };
}
