/**
 * Local subprocess backend for the OpenCompletions engine.
 *
 * Spawns CLI coding agents as child processes on the same machine.
 * Supports buffered single-turn, streaming single-turn, and multi-turn agent runs.
 *
 * Ported from server.js lines 1006-1238.
 */

import { spawn } from "child_process";
import type { ChildProcess } from "child_process";
import { getState } from "../state";
import { getConfig } from "../config";
import {
  buildAuthEnv,
  cleanOutput,
  cleanChunk,
  parseNDJSONLines,
} from "../helpers";
import { getCliProvider } from "../cli-providers";
import type { AgentOpts, AgentEvent, CliProvider } from "../types";

// ---------------------------------------------------------------------------
// Buffered single-turn completion
// ---------------------------------------------------------------------------

export function runClaudeLocal(
  prompt: string,
  systemPrompt: string | undefined,
  clientToken?: string | null,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const config = getConfig();
    const CLI = getCliProvider(config.cli);
    const state = getState();

    const cliArgs = CLI.buildCompletionArgs(systemPrompt);
    if (!CLI.promptViaStdin) {
      const w = CLI.wrapPrompt(prompt, systemPrompt);
      if (CLI.promptArgPrefix) {
        cliArgs.push(CLI.promptArgPrefix, w);
      } else {
        cliArgs.push(w);
      }
    }

    const env = { ...process.env, ...CLI.buildAuthEnv(clientToken ?? undefined) };

    const proc = spawn(CLI.command, cliArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    state.activeProcesses.add(proc);
    let settled = false;
    let stdout = "";
    let stderr = "";

    proc.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGTERM");
      reject(new Error(`Timed out after ${config.timeout}ms`));
    }, config.timeout);

    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      state.activeProcesses.delete(proc);
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve(CLI.extractResult ? CLI.extractResult(stdout) : cleanOutput(stdout));
      } else {
        reject(new Error(stderr || `${CLI.errorLabel} exited with code ${code}`));
      }
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      state.activeProcesses.delete(proc);
      if (settled) return;
      settled = true;
      reject(err);
    });

    if (CLI.promptViaStdin) proc.stdin!.write(prompt);
    proc.stdin!.end();
  });
}

// ---------------------------------------------------------------------------
// Streaming single-turn completion
// ---------------------------------------------------------------------------

export function runClaudeLocalStreaming(
  prompt: string,
  systemPrompt: string | undefined,
  onChunk: (chunk: string) => void,
  clientToken?: string | null,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const config = getConfig();
    const CLI = getCliProvider(config.cli);
    const state = getState();

    const cliArgs = CLI.buildCompletionArgs(systemPrompt);
    if (!CLI.promptViaStdin) {
      const w = CLI.wrapPrompt(prompt, systemPrompt);
      if (CLI.promptArgPrefix) {
        cliArgs.push(CLI.promptArgPrefix, w);
      } else {
        cliArgs.push(w);
      }
    }

    const env = { ...process.env, ...CLI.buildAuthEnv(clientToken ?? undefined) };

    const proc = spawn(CLI.command, cliArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    state.activeProcesses.add(proc);
    let settled = false;
    let stderr = "";
    const decoder = new TextDecoder("utf-8", { fatal: false });

    proc.stdout!.on("data", (chunk: Buffer) => {
      const text = cleanChunk(decoder.decode(chunk, { stream: true }));
      if (text) onChunk(text);
    });
    proc.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill("SIGTERM");
      reject(new Error(`Timed out after ${config.timeout}ms`));
    }, config.timeout);

    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      state.activeProcesses.delete(proc);
      if (settled) return;
      settled = true;
      if (code === 0) resolve("");
      else reject(new Error(stderr || `${CLI.errorLabel} exited with code ${code}`));
    });

    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      state.activeProcesses.delete(proc);
      if (settled) return;
      settled = true;
      reject(err);
    });

    if (CLI.promptViaStdin) proc.stdin!.write(prompt);
    proc.stdin!.end();
  });
}

// ---------------------------------------------------------------------------
// Multi-turn agent subprocess
// ---------------------------------------------------------------------------

export function runAgentLocal(
  prompt: string,
  opts: AgentOpts,
  onEvent?: (event: AgentEvent) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const config = getConfig();
    const state = getState();

    let eventsEmitted = 0;
    let retried = false;
    const wrappedOnEvent = (event: AgentEvent) => {
      eventsEmitted++;
      if (onEvent) onEvent(event);
    };

    const attempt = () => {
      const cli: CliProvider = opts.cliProvider || getCliProvider(config.cli);
      const cliArgs = cli.buildAgentArgs(opts);
      if (!cli.promptViaStdin) {
        const w = cli.wrapPrompt(prompt, opts.systemPrompt);
        if (cli.promptArgPrefix) {
          cliArgs.push(cli.promptArgPrefix, w);
        } else {
          cliArgs.push(w);
        }
      }

      const env = {
        ...process.env,
        ...cli.buildAuthEnv(opts.clientToken),
        ...cli.buildMcpEnv(opts),
      };
      const spawnOpts: { stdio: ["pipe", "pipe", "pipe"]; env: NodeJS.ProcessEnv; cwd?: string } = {
        stdio: ["pipe", "pipe", "pipe"],
        env: env as NodeJS.ProcessEnv,
      };
      if (opts.workspaceCwd) {
        spawnOpts.cwd = opts.workspaceCwd;
      } else if (opts.cwd) {
        spawnOpts.cwd = opts.cwd;
      }

      const proc = spawn(cli.command, cliArgs, spawnOpts);
      state.activeProcesses.add(proc);

      let settled = false;
      let stderr = "";
      let buffer = "";
      const timeout = opts.timeoutMs || config.agentTimeout;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill("SIGTERM");
        reject(new Error(`Agent timed out after ${timeout}ms`));
      }, timeout);

      // Abort on client disconnect
      let abortKillTimer: ReturnType<typeof setTimeout> | null = null;
      if (opts.abortSignal) {
        const onAbort = () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            proc.kill("SIGTERM");
            // Escalate to SIGKILL after 3s if process doesn't exit
            abortKillTimer = setTimeout(() => {
              try { proc.kill("SIGKILL"); } catch {}
            }, 3000);
            if (typeof abortKillTimer.unref === "function") {
              abortKillTimer.unref();
            }
            state.activeProcesses.delete(proc);
            reject(new Error("Agent aborted by client"));
          }
        };
        if (opts.abortSignal.aborted) {
          onAbort();
          return;
        }
        opts.abortSignal.addEventListener("abort", onAbort, { once: true });
      }

      const translate = cli.createEventTranslator();

      proc.stdout!.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        buffer = parseNDJSONLines(buffer, (event) => {
          const translated = translate(event);
          if (Array.isArray(translated)) {
            translated.forEach((e) => wrappedOnEvent(e));
          } else if (translated) {
            wrappedOnEvent(translated);
          }
        });
      });

      proc.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("close", (code: number | null) => {
        clearTimeout(timer);
        if (abortKillTimer) clearTimeout(abortKillTimer);
        state.activeProcesses.delete(proc);
        if (settled) return;

        // Flush remaining buffer
        if (buffer.trim()) {
          try {
            const translated = translate(JSON.parse(buffer.trim()));
            if (Array.isArray(translated)) {
              translated.forEach((e) => wrappedOnEvent(e));
            } else if (translated) {
              wrappedOnEvent(translated);
            }
          } catch {}
        }

        if (translate.finalize) {
          const final = translate.finalize();
          if (final) wrappedOnEvent(final);
        }

        settled = true;
        if (code === 0) return resolve();

        // Bootstrap retry: if process failed before emitting any events, retry once
        if (code !== 0 && eventsEmitted === 0 && !retried) {
          retried = true;
          const isSessionError = stderr.toLowerCase().includes("session");
          if (isSessionError) {
            return reject(
              new Error(
                JSON.stringify({
                  type: "session_expired",
                  message: stderr.trim() || "Session expired or not found",
                }),
              ),
            );
          }
          console.log(
            `[retry] ${cli.errorLabel} exited with code ${code} before any events, retrying in 1s...`,
          );
          setTimeout(() => attempt(), 1000);
          return;
        }
        reject(new Error(stderr || `${cli.errorLabel} agent exited with code ${code}`));
      });

      proc.on("error", (err: Error) => {
        clearTimeout(timer);
        state.activeProcesses.delete(proc);
        if (settled) return;
        settled = true;
        reject(err);
      });

      if (cli.promptViaStdin) proc.stdin!.write(cli.wrapPrompt(prompt, opts.systemPrompt));
      proc.stdin!.end();
    }; // end attempt()

    attempt();
  });
}
