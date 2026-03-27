/**
 * In-memory singleton state for the OpenCompletions engine.
 *
 * Manages:
 *  - Active worker count and job queue
 *  - Active child process set
 *  - Sprite and Vercel pool entries
 *  - Session-to-backend affinity maps
 *  - Workspace-to-backend binding maps
 *  - Session timestamp eviction
 *
 * Ported from server.js lines 150-179, 245-278.
 */

import type { SpriteEntry, VercelSandbox, QueueJob } from "./types";
import type { ChildProcess } from "child_process";

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface OcState {
  activeWorkers: number;
  queue: QueueJob[];
  activeProcesses: Set<ChildProcess>;

  // Backend pools
  spritePool: SpriteEntry[];
  vercelPool: VercelSandbox[];

  // Agent session affinity
  sessionToSprite: Map<string, string>;   // session_id -> sprite name
  sessionToSandbox: Map<string, string>;  // session_id -> sandbox id

  // Workspace-to-backend binding (eager allocation)
  workspaceToSprite: Map<string, string>;   // workspace_id -> sprite name
  workspaceToSandbox: Map<string, string>;  // workspace_id -> sandbox id

  // Session eviction timestamps
  sessionTimestamps: Map<string, number>;   // session_id -> last-access timestamp
}

// ---------------------------------------------------------------------------
// Singleton (survives Next.js HMR in dev via globalThis)
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

const globalForOc = globalThis as typeof globalThis & {
  __ocState?: OcState;
  __ocCleanupInterval?: ReturnType<typeof setInterval>;
};

/** Lazily initialize and return the singleton state. */
export function getState(): OcState {
  if (globalForOc.__ocState) return globalForOc.__ocState;

  const state: OcState = {
    activeWorkers: 0,
    queue: [],
    activeProcesses: new Set(),

    spritePool: [],
    vercelPool: [],

    sessionToSprite: new Map(),
    sessionToSandbox: new Map(),

    workspaceToSprite: new Map(),
    workspaceToSandbox: new Map(),

    sessionTimestamps: new Map(),
  };

  globalForOc.__ocState = state;

  // Evict stale session mappings every 30 minutes
  const cleanupInterval = setInterval(() => {
    const s = globalForOc.__ocState;
    if (!s) return;
    const now = Date.now();
    for (const [sid, ts] of s.sessionTimestamps) {
      if (now - ts > SESSION_TTL_MS) {
        s.sessionTimestamps.delete(sid);
        s.sessionToSprite.delete(sid);
        s.sessionToSandbox.delete(sid);
      }
    }
  }, 30 * 60 * 1000);

  // Allow the process to exit even if this interval is still running
  if (cleanupInterval && typeof cleanupInterval.unref === "function") {
    cleanupInterval.unref();
  }
  globalForOc.__ocCleanupInterval = cleanupInterval;

  return state;
}

// ---------------------------------------------------------------------------
// Pool helpers (shared pattern for sprite and vercel)
// ---------------------------------------------------------------------------

/**
 * Acquire the least-busy sprite from the pool.
 * Increments its busy counter and returns the entry.
 */
export function acquireSprite(): SpriteEntry {
  const { spritePool } = getState();
  if (spritePool.length === 0) {
    throw new Error("No sprites configured");
  }
  let sprite = spritePool[0];
  for (let i = 1; i < spritePool.length; i++) {
    if (spritePool[i].busy < sprite.busy) {
      sprite = spritePool[i];
    }
  }
  sprite.busy++;
  return sprite;
}

/** Decrement the busy counter for a sprite. */
export function releaseSprite(sprite: SpriteEntry): void {
  sprite.busy = Math.max(0, sprite.busy - 1);
}

/**
 * Acquire the least-busy healthy Vercel sandbox.
 * Skips sandboxes that are currently being replaced.
 */
export function acquireVercelSandbox(): VercelSandbox {
  const { vercelPool } = getState();
  let sandbox: VercelSandbox | null = null;
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

/** Decrement the busy counter for a Vercel sandbox. */
export function releaseVercelSandbox(sandbox: VercelSandbox): void {
  sandbox.busy = Math.max(0, sandbox.busy - 1);
}

/** Stop the session cleanup interval (used during shutdown). */
export function stopCleanupInterval(): void {
  if (globalForOc.__ocCleanupInterval) {
    clearInterval(globalForOc.__ocCleanupInterval);
    globalForOc.__ocCleanupInterval = undefined;
  }
}
