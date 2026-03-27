/**
 * Request queue with concurrency control.
 *
 * Manages enqueue/drain for both completion and agent jobs,
 * dispatching to the appropriate backend execution function.
 *
 * Ported from server.js lines 280-375.
 */

import { getState } from "./state";
import { getConfig } from "./config";
import type { QueueJob, AgentOpts, AgentEvent } from "./types";

// ---------------------------------------------------------------------------
// Backend function type signatures
// ---------------------------------------------------------------------------

type CompletionFn = (prompt: string, systemPrompt: string | undefined, clientToken?: string | null) => Promise<string>;
type StreamingCompletionFn = (prompt: string, systemPrompt: string | undefined, onChunk: (chunk: string) => void, clientToken?: string | null) => Promise<string>;
type AgentFn = (prompt: string, opts: AgentOpts, onEvent?: (event: AgentEvent) => void) => Promise<void>;

export interface BackendFunctions {
  runLocal: CompletionFn;
  runLocalStreaming: StreamingCompletionFn;
  runOnSprite: CompletionFn;
  runSpriteStreaming: StreamingCompletionFn;
  runOnVercel: CompletionFn;
  runVercelStreaming: StreamingCompletionFn;
  runOnCloudflare: CompletionFn;
  runCloudflareStreaming: StreamingCompletionFn;
  runAgentLocal: AgentFn;
  runAgentOnSprite: AgentFn;
  runAgentOnVercel: AgentFn;
  runAgentOnCloudflare: AgentFn;
}

const globalForQueue = globalThis as typeof globalThis & { __ocBackendFns?: BackendFunctions };

/** Register backend functions. Must be called before enqueue/drain. */
export function registerBackends(fns: BackendFunctions): void {
  globalForQueue.__ocBackendFns = fns;
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/**
 * Enqueue a single-turn completion job.
 * Returns a promise that resolves with the completion text.
 */
export function enqueue(
  prompt: string,
  systemPrompt: string | undefined,
  opts: { token?: string | null; onChunk?: ((chunk: string) => void) | null } = {},
): Promise<string> {
  const { queueDepth } = getConfig();
  const state = getState();
  const { token = null, onChunk = null } = opts;

  if (state.queue.length >= queueDepth) {
    return Promise.reject(new Error("Server too busy"));
  }

  return new Promise<string>((resolve, reject) => {
    state.queue.push({
      resolve: resolve as (value: unknown) => void,
      reject,
      prompt,
      systemPrompt,
      token,
      onChunk,
    });
    drain();
  });
}

/**
 * Enqueue a multi-turn agent job.
 * Returns a promise that resolves when the agent run completes.
 */
export function enqueueAgent(
  prompt: string,
  opts: AgentOpts = { prompt: "" },
): Promise<void> {
  const { queueDepth } = getConfig();
  const state = getState();

  if (state.queue.length >= queueDepth) {
    return Promise.reject(new Error("Server too busy"));
  }

  return new Promise<void>((resolve, reject) => {
    state.queue.push({
      resolve: resolve as (value: unknown) => void,
      reject,
      prompt,
      isAgent: true,
      agentOpts: opts,
      onEvent: opts.onEvent,
    });
    drain();
  });
}

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------

export function drain(): void {
  const backendFns = globalForQueue.__ocBackendFns;
  if (!backendFns) {
    throw new Error("Backend functions not registered — call registerBackends() first");
  }

  const config = getConfig();
  const state = getState();

  while (state.activeWorkers < config.concurrency && state.queue.length > 0) {
    const job = state.queue.shift()!;
    state.activeWorkers++;

    if (job.isAgent) {
      // Agent jobs — no queue-level retry (backend functions retry internally before first event)
      const agentFns: Record<string, AgentFn> = {
        local: backendFns.runAgentLocal,
        sprite: backendFns.runAgentOnSprite,
        vercel: backendFns.runAgentOnVercel,
        cloudflare: backendFns.runAgentOnCloudflare,
      };
      const agentFn = agentFns[job.agentOpts?.backend || config.backend];

      const run = async () => {
        try {
          await agentFn(job.prompt, job.agentOpts!, job.onEvent);
          job.resolve(undefined);
        } catch (err) {
          job.reject(err);
        } finally {
          state.activeWorkers--;
          drain();
        }
      };
      run();
    } else {
      // Completion jobs
      const streaming = !!job.onChunk;
      const execFns: Record<string, CompletionFn | StreamingCompletionFn> = {
        local: streaming ? backendFns.runLocalStreaming : backendFns.runLocal,
        sprite: streaming ? backendFns.runSpriteStreaming : backendFns.runOnSprite,
        vercel: streaming ? backendFns.runVercelStreaming : backendFns.runOnVercel,
        cloudflare: streaming ? backendFns.runCloudflareStreaming : backendFns.runOnCloudflare,
      };
      const execFn = execFns[config.backend];

      const canRetry = !streaming && config.backend !== "local";

      const run = async () => {
        try {
          const result = streaming
            ? await (execFn as StreamingCompletionFn)(job.prompt, job.systemPrompt, job.onChunk!, job.token)
            : await (execFn as CompletionFn)(job.prompt, job.systemPrompt, job.token);
          job.resolve(result);
        } catch (err) {
          if (canRetry && !job.retried) {
            job.retried = true;
            console.log(`Retrying after error: ${(err as Error).message}`);
            await new Promise((r) => setTimeout(r, 1000));
            try {
              const result = streaming
                ? await (execFn as StreamingCompletionFn)(job.prompt, job.systemPrompt, job.onChunk!, job.token)
                : await (execFn as CompletionFn)(job.prompt, job.systemPrompt, job.token);
              job.resolve(result);
            } catch (retryErr) {
              job.reject(retryErr);
            }
          } else {
            job.reject(err);
          }
        } finally {
          state.activeWorkers--;
          drain();
        }
      };
      run();
    }
  }
}
