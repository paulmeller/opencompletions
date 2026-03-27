/**
 * Graceful shutdown for the OpenCompletions engine.
 *
 * - Kill active child processes (SIGTERM, then SIGKILL after 5s)
 * - Reject all queued jobs
 * - Stop session cleanup interval
 *
 * Ported from server.js lines 3750-3807.
 *
 * Note: sprite auth cleanup and vercel sandbox teardown are omitted here
 * because those operations live in the backend modules. When backends are
 * registered, they can hook into this via the onShutdown callback.
 */

import { getState, stopCleanupInterval } from "./state";

// ---------------------------------------------------------------------------
// Shutdown hooks — backends register cleanup functions here
// ---------------------------------------------------------------------------

type ShutdownHook = () => void | Promise<void>;
const shutdownHooks: ShutdownHook[] = [];

/** Register a function to be called during shutdown (e.g. sprite cleanup, vercel stop). */
export function onShutdown(hook: ShutdownHook): void {
  shutdownHooks.push(hook);
}

// ---------------------------------------------------------------------------
// Main shutdown
// ---------------------------------------------------------------------------

let shuttingDown = false;

export function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n[oc/shutdown] Received ${signal}, shutting down...`);

  const state = getState();

  // Reject all queued jobs
  while (state.queue.length > 0) {
    const job = state.queue.shift()!;
    job.reject(new Error("Server shutting down"));
  }

  // Kill active child processes (SIGTERM, then SIGKILL after 5s)
  for (const proc of state.activeProcesses) {
    proc.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (state.activeProcesses.has(proc)) {
        console.warn("[oc/shutdown] Process did not exit after SIGTERM, sending SIGKILL");
        proc.kill("SIGKILL");
      }
    }, 5000);
    if (typeof killTimer.unref === "function") {
      killTimer.unref();
    }
  }

  // Stop session eviction interval
  stopCleanupInterval();

  // Run backend-registered shutdown hooks
  for (const hook of shutdownHooks) {
    try {
      hook();
    } catch (err) {
      console.warn("[oc/shutdown] Hook error:", err);
    }
  }

  // Force exit after 10s if workers don't finish
  const deadline = setTimeout(() => {
    console.error("[oc/shutdown] Force exit after timeout");
    process.exit(1);
  }, 10_000);
  if (typeof deadline.unref === "function") {
    deadline.unref();
  }

  // Poll until all workers are done, then exit
  const check = setInterval(() => {
    if (state.activeWorkers === 0) {
      clearInterval(check);
      clearTimeout(deadline);
      process.exit(0);
    }
  }, 200);
}
