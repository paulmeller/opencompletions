/**
 * One-time initialization for the OpenCompletions engine.
 *
 * Uses the ensureInitialized() pattern: the first call kicks off doInit(),
 * subsequent calls return the same promise.
 *
 * Initialization steps:
 *  - Populate sprite pool from config
 *  - Populate vercel pool (placeholder — actual sandbox creation lives in backends)
 *  - Start session cleanup interval (handled by state.ts lazily)
 *  - Register SIGINT/SIGTERM handlers for graceful shutdown
 */

import { getConfig } from "./config";
import { getState } from "./state";
import { shutdown } from "./shutdown";
import { registerBackends } from "./queue";
import { runClaudeLocal, runClaudeLocalStreaming, runAgentLocal } from "./backends/local";
import { runClaudeOnSprite, runClaudeSpriteStreaming, runAgentOnSprite } from "./backends/sprite";
import { runClaudeOnVercel, runClaudeVercelStreaming, runAgentOnVercel } from "./backends/vercel";
import * as files from "./files";

// ---------------------------------------------------------------------------
// Singleton promise (survives Next.js HMR in dev via globalThis)
// ---------------------------------------------------------------------------

const globalForInit = globalThis as typeof globalThis & {
  __ocInitPromise?: Promise<void>;
  __ocSignalHandlersRegistered?: boolean;
};

/**
 * Ensure the engine is initialized. Safe to call multiple times;
 * only the first invocation runs doInit().
 * If doInit() rejects, the promise is reset so the next request retries.
 */
export function ensureInitialized(): Promise<void> {
  const g = globalForInit;
  if (!g.__ocInitPromise) {
    g.__ocInitPromise = doInit().catch((err) => {
      g.__ocInitPromise = undefined; // allow retry
      throw err;
    });
  }
  return g.__ocInitPromise;
}

// ---------------------------------------------------------------------------
// Actual init
// ---------------------------------------------------------------------------

async function doInit(): Promise<void> {
  const config = getConfig();
  const state = getState();

  // --- Register backend functions with the queue ---
  registerBackends({
    runLocal: runClaudeLocal,
    runLocalStreaming: runClaudeLocalStreaming,
    runOnSprite: runClaudeOnSprite,
    runSpriteStreaming: runClaudeSpriteStreaming,
    runOnVercel: runClaudeOnVercel,
    runVercelStreaming: runClaudeVercelStreaming,
    runAgentLocal,
    runAgentOnSprite,
    runAgentOnVercel,
  });

  // --- Sprite pool ---
  if (config.spriteNames.length > 0 && config.spriteToken) {
    state.spritePool = config.spriteNames.map((name) => ({ name, busy: 0 }));
    console.log(`[oc/init] Sprite pool initialized: ${config.spriteNames.join(", ")}`);
  }

  // --- Vercel pool ---
  // Actual sandbox creation is deferred to the vercel backend module.
  // Here we just log readiness.
  if (config.vercelToken && config.vercelTeamId) {
    console.log("[oc/init] Vercel backend credentials present — sandboxes will be created on demand");
  }

  // --- Shutdown handlers (register only once) ---
  if (!globalForInit.__ocSignalHandlersRegistered) {
    globalForInit.__ocSignalHandlersRegistered = true;
    const handler = (signal: string) => shutdown(signal);
    process.on("SIGINT", () => handler("SIGINT"));
    process.on("SIGTERM", () => handler("SIGTERM"));
  }

  // --- Start workspace cleanup timer (every 15 minutes) ---
  const cleanupInterval = setInterval(() => {
    try {
      files.cleanupExpired(config.workspaceTtl);
    } catch {}
  }, 15 * 60 * 1000);
  cleanupInterval.unref();

  console.log(
    `[oc/init] Engine ready — backend=${config.backend}, cli=${config.cli}, ` +
    `concurrency=${config.concurrency}, timeout=${config.timeout}ms`,
  );
}
