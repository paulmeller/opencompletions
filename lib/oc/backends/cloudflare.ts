/**
 * Cloudflare Sandbox backend for the OpenCompletions engine.
 *
 * IMPORTANT LIMITATION: Cloudflare Sandbox is a Durable Objects-based SDK
 * (@cloudflare/sandbox) that only works within Cloudflare Workers. It does NOT
 * expose a public REST API callable from external Node.js servers.
 *
 * Architecture:
 *  - Sandbox containers are managed via Durable Object bindings in wrangler.toml
 *  - Communication uses HTTP or WebSocket transport between Worker <-> Container
 *  - The SDK methods (exec, readFile, writeFile, etc.) are only available inside
 *    a Cloudflare Worker context with env.Sandbox binding
 *
 * This backend is a placeholder that:
 *  1. Documents the limitation clearly
 *  2. Implements the full backend interface so it can be selected in config
 *  3. Returns descriptive errors if someone tries to use it without a Worker proxy
 *  4. Will be updated when Cloudflare provides a public REST API or when we
 *     implement a Worker-based proxy that bridges the gap
 *
 * To make this backend functional, you would need to:
 *  - Deploy a Cloudflare Worker that wraps the Sandbox SDK as a REST API
 *  - Set cloudflareApiToken to authenticate with that Worker
 *  - Set cloudflareAccountId to your Cloudflare account
 *  - Point the CLOUDFLARE_API_URL to your Worker's URL
 *
 * SDK reference: https://developers.cloudflare.com/sandbox/
 */

import {
  getState,
  acquireCloudflareSandbox,
  releaseCloudflareSandbox,
} from "../state";
import { getConfig } from "../config";
import {
  buildAuthEnv,
  buildCustomEnv,
  buildAgentCliArgs,
  cleanOutput,
  cleanChunk,
  sanitizeEvent,
  parseNDJSONLines,
} from "../helpers";
import { getCliProvider } from "../cli-providers";
import * as files from "../files";
import type { AgentOpts, AgentEvent, CloudflareSandbox } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Base URL for the Cloudflare Sandbox proxy API.
 * This would be a Cloudflare Worker you deploy that wraps the Sandbox SDK.
 *
 * TODO: Update when Cloudflare provides a public REST API for Sandbox.
 */
function getCloudflareApiUrl(): string {
  const config = getConfig();
  // Default to Cloudflare API base; in practice this would be your Worker proxy URL
  return config.cloudflareApiUrl || `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}`;
}

function cloudflareHeaders(): Record<string, string> {
  const config = getConfig();
  return {
    Authorization: `Bearer ${config.cloudflareApiToken}`,
    "Content-Type": "application/json",
  };
}

function assertConfigured(): void {
  const config = getConfig();
  if (!config.cloudflareAccountId || !config.cloudflareApiToken) {
    throw new Error(
      "Cloudflare Sandbox backend is not configured. " +
      "Set cloudflare_account_id and cloudflare_api_token in settings. " +
      "NOTE: Cloudflare Sandbox currently requires a Cloudflare Worker proxy — " +
      "see lib/oc/backends/cloudflare.ts for details.",
    );
  }
}

// ---------------------------------------------------------------------------
// Sandbox lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a new Cloudflare Sandbox container.
 *
 * TODO: Implement when REST API or Worker proxy is available.
 * The Cloudflare Sandbox SDK creates containers via:
 *   const sandbox = await getSandbox(env.Sandbox, sandboxId, { ... });
 * This is only available inside a Cloudflare Worker.
 */
export async function createCloudflareSandbox(): Promise<{ id: string }> {
  assertConfigured();
  const apiUrl = getCloudflareApiUrl();

  const res = await fetch(`${apiUrl}/sandboxes`, {
    method: "POST",
    headers: cloudflareHeaders(),
    body: JSON.stringify({
      // TODO: Add sandbox configuration options when API is available
      // The SDK supports: keepAlive, environment variables, container image
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(
      `Failed to create Cloudflare Sandbox: ${errText}. ` +
      "NOTE: If you see a 404 or auth error, you likely need to deploy a Cloudflare Worker " +
      "proxy that wraps the Sandbox SDK as a REST API.",
    );
  }

  const data = await res.json() as { id?: string; sandbox?: { id: string } };
  return { id: (data.sandbox?.id || data.id)! };
}

/**
 * Stop and destroy a Cloudflare Sandbox container.
 *
 * TODO: The SDK equivalent is sandbox.destroy() which terminates the container
 * and deletes all state (files, processes, sessions, network connections).
 */
export async function stopCloudflareSandbox(sandboxId: string): Promise<void> {
  const apiUrl = getCloudflareApiUrl();
  await fetch(`${apiUrl}/sandboxes/${sandboxId}`, {
    method: "DELETE",
    headers: cloudflareHeaders(),
  }).catch(() => {});
}

/**
 * Initialize the Cloudflare Sandbox pool.
 * Creates `concurrency` sandbox containers on startup.
 */
export async function initCloudflarePool(): Promise<void> {
  const config = getConfig();
  const state = getState();

  console.log(`Creating ${config.concurrency} Cloudflare Sandbox(es)...`);
  const results = await Promise.all(
    Array.from({ length: config.concurrency }, () => createCloudflareSandbox()),
  );
  for (const sbx of results) {
    state.cloudflarePool.push({ id: sbx.id, busy: 0 });
  }
  console.log(
    `Cloudflare Sandboxes ready: ${state.cloudflarePool.map((s) => s.id).join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// Command execution helpers
// ---------------------------------------------------------------------------

/**
 * Build CLI args for Claude single-turn completion on Cloudflare.
 */
function buildCloudflareClaudeArgs(prompt: string, systemPrompt?: string): string[] {
  const cmdArgs = ["-p", "--max-turns", "1", "--output-format", "text"];
  if (systemPrompt) cmdArgs.push("--system-prompt", systemPrompt);
  cmdArgs.push("--", prompt);
  return cmdArgs;
}

/**
 * Execute a command on a Cloudflare Sandbox.
 *
 * TODO: The SDK equivalent is:
 *   const result = await sandbox.exec(command, { env, stdin });
 *   // result.stdout, result.stderr, result.exitCode
 */
export async function cloudflareExec(
  sandboxId: string,
  cmdArgs: string[],
  env: Record<string, string>,
  command = "claude",
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const apiUrl = getCloudflareApiUrl();

  const res = await fetch(`${apiUrl}/sandboxes/${sandboxId}/exec`, {
    method: "POST",
    headers: cloudflareHeaders(),
    body: JSON.stringify({ command, args: cmdArgs, env }),
  });

  if (!res.ok) throw new Error(`Cloudflare exec failed: ${await res.text()}`);
  const data = await res.json() as {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    success?: boolean;
  };
  return {
    stdout: data.stdout || "",
    stderr: data.stderr || "",
    exitCode: data.exitCode ?? (data.success ? 0 : 1),
  };
}

/**
 * Execute a command and stream output from a Cloudflare Sandbox.
 *
 * TODO: The SDK equivalent is:
 *   const stream = await sandbox.execStream(command);
 *   // Emits SSE events: start, stdout, stderr, complete, error
 *   // Use parseSSEStream() to consume
 */
export async function cloudflareStreamExec(
  sandboxId: string,
  cmdArgs: string[],
  env: Record<string, string>,
  onStdout?: (data: string) => void,
  onStderr?: (data: string) => void,
  timeoutMs?: number,
  command = "claude",
): Promise<number> {
  const config = getConfig();
  const apiUrl = getCloudflareApiUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? config.timeout);

  try {
    const res = await fetch(`${apiUrl}/sandboxes/${sandboxId}/exec/stream`, {
      method: "POST",
      headers: cloudflareHeaders(),
      body: JSON.stringify({ command, args: cmdArgs, env }),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`Cloudflare stream exec failed: ${await res.text()}`);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let exitCode = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          // SSE format: "data: {...}" or "event: type\ndata: {...}"
          const dataMatch = line.match(/^data:\s*(.+)/);
          if (dataMatch) {
            try {
              event = JSON.parse(dataMatch[1]);
            } catch {
              continue;
            }
          } else {
            continue;
          }
        }

        // Handle Cloudflare Sandbox SSE event types:
        // start, stdout, stderr, complete, error
        const eventType = (event.type || event.event || event.stream) as string | undefined;
        if ((eventType === "stdout" || event.stream === "stdout") && onStdout) {
          onStdout((event.data as string) || "");
        } else if ((eventType === "stderr" || event.stream === "stderr") && onStderr) {
          onStderr((event.data as string) || "");
        } else if (eventType === "complete") {
          exitCode = (event.exitCode as number) ?? 0;
        } else if (eventType === "error") {
          throw new Error((event.message as string) || (event.data as string) || "Stream error");
        }
      }
    }

    return exitCode;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Sandbox replacement (self-healing pool)
// ---------------------------------------------------------------------------

export async function replaceCloudflareSandbox(sandbox: CloudflareSandbox): Promise<void> {
  const state = getState();

  // Mutex: if already being replaced, wait for the existing replacement
  if (sandbox.replacing) {
    await sandbox._replacePromise;
    if (sandbox.dead) throw new Error("Sandbox replacement failed permanently");
    return;
  }

  const oldId = sandbox.id;
  sandbox.replacing = true;
  sandbox._replacePromise = (async () => {
    console.log(`Replacing dead Cloudflare Sandbox ${oldId}...`);
    // Mark any bound workspaces as error
    for (const [wsId, sbxId] of state.workspaceToCloudflare) {
      if (sbxId === oldId) {
        files.setWorkspaceState(wsId, "error");
        state.workspaceToCloudflare.delete(wsId);
      }
    }
    await stopCloudflareSandbox(oldId);
    try {
      const newSbx = await createCloudflareSandbox();
      sandbox.id = newSbx.id;
      sandbox.dead = false;
      console.log(`Replaced with ${newSbx.id}`);
    } catch (err) {
      sandbox.dead = true;
      console.error(`Failed to replace Cloudflare Sandbox: ${(err as Error).message}`);
      throw err;
    } finally {
      sandbox.replacing = false;
      sandbox._replacePromise = null;
    }
  })();
  await sandbox._replacePromise;
}

// ---------------------------------------------------------------------------
// Buffered single-turn completion
// ---------------------------------------------------------------------------

export async function runClaudeOnCloudflare(
  prompt: string,
  systemPrompt: string | undefined,
  clientToken?: string | null,
): Promise<string> {
  assertConfigured();
  const sandbox = acquireCloudflareSandbox();
  try {
    const cmdArgs = buildCloudflareClaudeArgs(prompt, systemPrompt);
    const env = { ...buildCustomEnv({}), ...buildAuthEnv(clientToken ?? undefined) };

    let result: { stdout: string; stderr: string; exitCode: number };
    try {
      result = await cloudflareExec(sandbox.id, cmdArgs, env);
    } catch (err) {
      if (
        (err as Error).message.includes("not found") ||
        (err as Error).message.includes("stopped") ||
        (err as Error).message.includes("destroyed")
      ) {
        await replaceCloudflareSandbox(sandbox);
        result = await cloudflareExec(sandbox.id, cmdArgs, env);
      } else {
        throw err;
      }
    }

    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `claude exited with code ${result.exitCode}`);
    }
    return cleanOutput(result.stdout);
  } finally {
    releaseCloudflareSandbox(sandbox);
  }
}

// ---------------------------------------------------------------------------
// Streaming single-turn completion
// ---------------------------------------------------------------------------

export async function runCloudflareStreaming(
  prompt: string,
  systemPrompt: string | undefined,
  onChunk: (chunk: string) => void,
  clientToken?: string | null,
): Promise<string> {
  assertConfigured();
  const sandbox = acquireCloudflareSandbox();
  try {
    const cmdArgs = buildCloudflareClaudeArgs(prompt, systemPrompt);
    const env = { ...buildCustomEnv({}), ...buildAuthEnv(clientToken ?? undefined) };

    let exitCode: number;
    let stderr = "";
    try {
      exitCode = await cloudflareStreamExec(
        sandbox.id,
        cmdArgs,
        env,
        (data) => {
          const cleaned = cleanChunk(data);
          if (cleaned) onChunk(cleaned);
        },
        (data) => { stderr += data; },
      );
    } catch (err) {
      if (
        (err as Error).message.includes("not found") ||
        (err as Error).message.includes("stopped") ||
        (err as Error).message.includes("destroyed")
      ) {
        await replaceCloudflareSandbox(sandbox);
        stderr = "";
        exitCode = await cloudflareStreamExec(
          sandbox.id,
          cmdArgs,
          env,
          (data) => {
            const cleaned = cleanChunk(data);
            if (cleaned) onChunk(cleaned);
          },
          (data) => { stderr += data; },
        );
      } else {
        throw err;
      }
    }

    if (exitCode !== 0) {
      throw new Error(stderr || `claude exited with code ${exitCode}`);
    }
    return "";
  } finally {
    releaseCloudflareSandbox(sandbox);
  }
}

// ---------------------------------------------------------------------------
// Multi-turn agent
// ---------------------------------------------------------------------------

export async function runAgentOnCloudflare(
  prompt: string,
  opts: AgentOpts,
  onEvent?: (event: AgentEvent) => void,
): Promise<void> {
  assertConfigured();
  const config = getConfig();
  const state = getState();
  const CLI = getCliProvider(config.cli);

  // Workspace binding takes priority, then session affinity, then acquire
  let sandbox: CloudflareSandbox;
  if (opts.workspaceId && state.workspaceToCloudflare.has(opts.workspaceId)) {
    const sandboxId = state.workspaceToCloudflare.get(opts.workspaceId)!;
    const found = state.cloudflarePool.find((s) => s.id === sandboxId && !s.replacing);
    if (!found) {
      sandbox = acquireCloudflareSandbox();
    } else {
      sandbox = found;
      sandbox.busy++;
    }
  } else if (opts.sessionId && state.sessionToCloudflare.has(opts.sessionId)) {
    const sandboxId = state.sessionToCloudflare.get(opts.sessionId)!;
    const found = state.cloudflarePool.find((s) => s.id === sandboxId && !s.replacing);
    if (found) {
      sandbox = found;
      sandbox.busy++;
      state.sessionTimestamps.set(opts.sessionId, Date.now());
    } else {
      state.sessionToCloudflare.delete(opts.sessionId);
      sandbox = acquireCloudflareSandbox();
    }
  } else {
    sandbox = acquireCloudflareSandbox();
  }

  try {
    const cliArgs = buildAgentCliArgs(opts);
    cliArgs.push("--", prompt);
    const env = { ...buildCustomEnv(opts), ...buildAuthEnv(opts.clientToken), ...CLI.buildMcpEnv(opts) };

    // If workspace cwd, wrap in bash -c with cd
    let execCommand = "claude";
    let execArgs = cliArgs;
    if (opts.workspaceCwd) {
      const escapedArgs = cliArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
      execCommand = "bash";
      execArgs = ["-c", `cd /workspace/${opts.workspaceCwd} && claude ${escapedArgs}`];
    }

    const timeout = opts.timeoutMs || config.agentTimeout;
    let buffer = "";
    const trackSession = (event: AgentEvent) => {
      if (event.type === "system" && event.subtype === "init" && event.session_id) {
        state.sessionToCloudflare.set(event.session_id, sandbox.id);
        state.sessionTimestamps.set(event.session_id, Date.now());
      }
    };

    let exitCode: number;
    try {
      exitCode = await cloudflareStreamExec(
        sandbox.id,
        execArgs,
        env,
        (data) => {
          buffer += data;
          buffer = parseNDJSONLines(buffer, (parsed) => {
            const event = parsed as unknown as AgentEvent;
            trackSession(event);
            const sanitized = sanitizeEvent(event);
            if (sanitized && onEvent) onEvent(sanitized);
          });
        },
        (_data) => {
          // stderr -- could log for debugging
        },
        timeout,
        execCommand,
      );
    } catch (err) {
      if (
        (err as Error).message.includes("not found") ||
        (err as Error).message.includes("stopped") ||
        (err as Error).message.includes("destroyed")
      ) {
        // Clear stale session mappings for this sandbox
        for (const [sid, sbxId] of state.sessionToCloudflare) {
          if (sbxId === sandbox.id) state.sessionToCloudflare.delete(sid);
        }
        await replaceCloudflareSandbox(sandbox);
        buffer = "";
        exitCode = await cloudflareStreamExec(
          sandbox.id,
          execArgs,
          env,
          (data) => {
            buffer += data;
            buffer = parseNDJSONLines(buffer, (parsed) => {
              const event = parsed as unknown as AgentEvent;
              trackSession(event);
              const sanitized = sanitizeEvent(event);
              if (sanitized && onEvent) onEvent(sanitized);
            });
          },
          (_data) => {},
          timeout,
          execCommand,
        );
      } else {
        throw err;
      }
    }

    if (exitCode !== 0) {
      throw new Error(`claude agent exited with code ${exitCode}`);
    }
  } finally {
    releaseCloudflareSandbox(sandbox);
  }
}
