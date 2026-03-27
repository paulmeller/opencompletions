/**
 * Vercel Sandbox backend for the OpenCompletions engine.
 *
 * Delegates execution to Vercel Sandbox microVMs via REST API.
 * Auto-creates sandbox pool on startup, replaces dead instances.
 *
 * Ported from server.js lines 1556-1896.
 */

import {
  getState,
  acquireVercelSandbox,
  releaseVercelSandbox,
} from "../state";
import { getConfig } from "../config";
import {
  buildAuthEnv,
  buildAgentCliArgs,
  cleanOutput,
  cleanChunk,
  sanitizeEvent,
  parseNDJSONLines,
} from "../helpers";
import { getCliProvider } from "../cli-providers";
import * as files from "../files";
import type { AgentOpts, AgentEvent, VercelSandbox } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VERCEL_API = "https://api.vercel.com";

function vercelHeaders(): Record<string, string> {
  const config = getConfig();
  return {
    Authorization: `Bearer ${config.vercelToken}`,
    "Content-Type": "application/json",
  };
}

function vercelUrl(urlPath: string): string {
  const config = getConfig();
  const sep = urlPath.includes("?") ? "&" : "?";
  return `${VERCEL_API}${urlPath}${sep}teamId=${encodeURIComponent(config.vercelTeamId)}`;
}

// ---------------------------------------------------------------------------
// Sandbox lifecycle
// ---------------------------------------------------------------------------

export async function createVercelSandbox(): Promise<{ id: string }> {
  const config = getConfig();

  const body: Record<string, unknown> = { runtime: "node24" };
  if (config.vercelSnapshotId) {
    body.source = { type: "snapshot", snapshotId: config.vercelSnapshotId };
  }
  if (config.vercelProjectId) {
    body.projectId = config.vercelProjectId;
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

export async function stopVercelSandbox(sandboxId: string): Promise<void> {
  await fetch(vercelUrl(`/v1/sandboxes/${sandboxId}/stop`), {
    method: "POST",
    headers: vercelHeaders(),
  }).catch(() => {});
}

export async function initVercelPool(): Promise<void> {
  const config = getConfig();
  const state = getState();

  console.log(`Creating ${config.concurrency} Vercel sandbox(es)...`);
  const results = await Promise.all(
    Array.from({ length: config.concurrency }, () => createVercelSandbox()),
  );
  for (const sbx of results) {
    state.vercelPool.push({ id: sbx.id, busy: 0 });
  }
  console.log(
    `Vercel sandboxes ready: ${state.vercelPool.map((s) => s.id).join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// Command execution helpers
// ---------------------------------------------------------------------------

function buildVercelClaudeArgs(prompt: string, systemPrompt?: string): string[] {
  const cmdArgs = ["-p", "--max-turns", "1", "--output-format", "text"];
  if (systemPrompt) cmdArgs.push("--system-prompt", systemPrompt);
  cmdArgs.push("--", prompt); // -- prevents prompt from being parsed as a flag
  return cmdArgs;
}

export async function vercelExec(
  sandboxId: string,
  cmdArgs: string[],
  env: Record<string, string>,
  command = "claude",
): Promise<string> {
  const res = await fetch(vercelUrl(`/v1/sandboxes/${sandboxId}/cmd`), {
    method: "POST",
    headers: vercelHeaders(),
    body: JSON.stringify({ command, args: cmdArgs, env }),
  });

  if (!res.ok) throw new Error(`Vercel exec failed: ${await res.text()}`);
  const data = await res.json();
  return data.command.id;
}

export async function vercelStreamLogs(
  sandboxId: string,
  cmdId: string,
  onStdout?: (data: string) => void,
  onStderr?: (data: string) => void,
  timeoutMs?: number,
): Promise<void> {
  const config = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs ?? config.timeout);

  try {
    const res = await fetch(
      vercelUrl(`/v1/sandboxes/${sandboxId}/cmd/${cmdId}/logs`),
      {
        headers: { Authorization: `Bearer ${config.vercelToken}` },
        signal: controller.signal,
      },
    );

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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
          console.warn(`Skipping non-JSON log line: ${line.slice(0, 100)}`);
          continue;
        }
        if (event.stream === "stdout" && onStdout) onStdout(event.data as string);
        else if (event.stream === "stderr" && onStderr) onStderr(event.data as string);
        else if (event.stream === "error") {
          const errData = event.data as Record<string, unknown> | undefined;
          throw new Error((errData?.message as string) || "Stream error");
        }
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function vercelExitCode(sandboxId: string, cmdId: string): Promise<number> {
  const config = getConfig();
  const res = await fetch(
    vercelUrl(`/v1/sandboxes/${sandboxId}/cmd/${cmdId}?wait=true`),
    { headers: { Authorization: `Bearer ${config.vercelToken}` } },
  );
  const data = await res.json();
  return data.command.exitCode;
}

// ---------------------------------------------------------------------------
// Sandbox replacement (self-healing pool)
// ---------------------------------------------------------------------------

export async function replaceVercelSandbox(sandbox: VercelSandbox): Promise<void> {
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
    console.log(`Replacing dead sandbox ${oldId}...`);
    // Mark any bound workspaces as error
    for (const [wsId, sbxId] of state.workspaceToSandbox) {
      if (sbxId === oldId) {
        files.setWorkspaceState(wsId, "error");
        state.workspaceToSandbox.delete(wsId);
      }
    }
    await stopVercelSandbox(oldId);
    try {
      const newSbx = await createVercelSandbox();
      sandbox.id = newSbx.id;
      sandbox.dead = false;
      console.log(`Replaced with ${newSbx.id}`);
    } catch (err) {
      sandbox.dead = true;
      console.error(`Failed to replace sandbox: ${(err as Error).message}`);
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

export async function runClaudeOnVercel(
  prompt: string,
  systemPrompt: string | undefined,
  clientToken?: string | null,
): Promise<string> {
  const sandbox = acquireVercelSandbox();
  try {
    const cmdArgs = buildVercelClaudeArgs(prompt, systemPrompt);
    const env = buildAuthEnv(clientToken ?? undefined);
    let cmdId: string;
    try {
      cmdId = await vercelExec(sandbox.id, cmdArgs, env);
    } catch (err) {
      if (
        (err as Error).message.includes("sandbox_stopped") ||
        (err as Error).message.includes("not found")
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
      (data) => { stdout += data; },
      (data) => { stderr += data; },
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

// ---------------------------------------------------------------------------
// Streaming single-turn completion
// ---------------------------------------------------------------------------

export async function runClaudeVercelStreaming(
  prompt: string,
  systemPrompt: string | undefined,
  onChunk: (chunk: string) => void,
  clientToken?: string | null,
): Promise<string> {
  const sandbox = acquireVercelSandbox();
  try {
    const cmdArgs = buildVercelClaudeArgs(prompt, systemPrompt);
    const env = buildAuthEnv(clientToken ?? undefined);
    let cmdId: string;
    try {
      cmdId = await vercelExec(sandbox.id, cmdArgs, env);
    } catch (err) {
      if (
        (err as Error).message.includes("sandbox_stopped") ||
        (err as Error).message.includes("not found")
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
      (data) => { stderr += data; },
    );

    const code = await vercelExitCode(sandbox.id, cmdId);
    if (code !== 0) {
      throw new Error(stderr || `claude exited with code ${code}`);
    }
    return "";
  } finally {
    releaseVercelSandbox(sandbox);
  }
}

// ---------------------------------------------------------------------------
// Multi-turn agent
// ---------------------------------------------------------------------------

export async function runAgentOnVercel(
  prompt: string,
  opts: AgentOpts,
  onEvent?: (event: AgentEvent) => void,
): Promise<void> {
  const config = getConfig();
  const state = getState();
  const CLI = getCliProvider(config.cli);

  // Workspace binding takes priority, then session affinity, then acquire
  let sandbox: VercelSandbox;
  if (opts.workspaceId && state.workspaceToSandbox.has(opts.workspaceId)) {
    const sandboxId = state.workspaceToSandbox.get(opts.workspaceId)!;
    const found = state.vercelPool.find((s) => s.id === sandboxId && !s.replacing);
    if (!found) {
      sandbox = acquireVercelSandbox();
    } else {
      sandbox = found;
      sandbox.busy++;
    }
  } else if (opts.sessionId && state.sessionToSandbox.has(opts.sessionId)) {
    const sandboxId = state.sessionToSandbox.get(opts.sessionId)!;
    const found = state.vercelPool.find((s) => s.id === sandboxId && !s.replacing);
    if (found) {
      sandbox = found;
      sandbox.busy++;
      state.sessionTimestamps.set(opts.sessionId, Date.now()); // refresh TTL
    } else {
      state.sessionToSandbox.delete(opts.sessionId);
      sandbox = acquireVercelSandbox();
    }
  } else {
    sandbox = acquireVercelSandbox();
  }

  try {
    const cliArgs = buildAgentCliArgs(opts);
    cliArgs.push("--", prompt); // -- prevents prompt from being parsed as a flag
    const env = { ...buildAuthEnv(opts.clientToken), ...CLI.buildMcpEnv(opts) };

    // If workspace cwd, wrap in bash -c with cd
    let execCommand = "claude";
    let execArgs = cliArgs;
    if (opts.workspaceCwd) {
      const escapedArgs = cliArgs.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
      execCommand = "bash";
      execArgs = ["-c", `cd /vercel/sandbox/${opts.workspaceCwd} && claude ${escapedArgs}`];
    }

    let cmdId: string;
    try {
      cmdId = await vercelExec(sandbox.id, execArgs, env, execCommand);
    } catch (err) {
      if (
        (err as Error).message.includes("sandbox_stopped") ||
        (err as Error).message.includes("not found")
      ) {
        // Clear stale session mappings for this sandbox
        for (const [sid, sbxId] of state.sessionToSandbox) {
          if (sbxId === sandbox.id) state.sessionToSandbox.delete(sid);
        }
        await replaceVercelSandbox(sandbox);
        cmdId = await vercelExec(sandbox.id, execArgs, env, execCommand);
      } else {
        throw err;
      }
    }

    const timeout = opts.timeoutMs || config.agentTimeout;
    let buffer = "";
    const trackSession = (event: AgentEvent) => {
      if (event.type === "system" && event.subtype === "init" && event.session_id) {
        state.sessionToSandbox.set(event.session_id, sandbox.id);
        state.sessionTimestamps.set(event.session_id, Date.now());
      }
    };

    await vercelStreamLogs(
      sandbox.id,
      cmdId,
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
    );

    const code = await vercelExitCode(sandbox.id, cmdId);
    if (code !== 0) {
      throw new Error(`claude agent exited with code ${code}`);
    }
  } finally {
    releaseVercelSandbox(sandbox);
  }
}
