/**
 * Data access layer for dashboard pages.
 * Reads directly from local DB and in-memory state (no more HTTP proxy).
 */

import { listRuns as dbListRuns, getRun as dbGetRun, getRunStats as dbGetRunStats } from "@/lib/db";
import type { AgentRun } from "@/lib/db";

export type Run = AgentRun;

export interface Stats {
  total_runs: number;
  completed: number | null;
  errors: number | null;
  running: number | null;
  total_cost_usd: number | null;
  total_turns: number | null;
  avg_cost_usd: number | null;
  avg_turns: number | null;
  active_workers: number;
  queued: number;
  max_concurrency: number;
  backend: string;
}

export interface Skill {
  name: string;
  display_name: string;
  description: string;
  instructions: string;
  resources: { file_name: string; content: string }[];
  created_at: string;
  updated_at: string;
}

export function getRuns(params?: { limit?: number; offset?: number; status?: string }) {
  return dbListRuns({
    limit: params?.limit,
    offset: params?.offset,
    status: params?.status,
  });
}

export function getRun(id: string) {
  return dbGetRun(id);
}

export function getStats(since?: number): Stats {
  const dbStats = dbGetRunStats({ since }) || {};

  // Try to get live state, but don't fail if not initialized
  let activeWorkers = 0;
  let queued = 0;
  let maxConcurrency = 3;
  let backend = "local";

  try {
    const { getState } = require("@/lib/oc/state");
    const { getConfig } = require("@/lib/oc/config");
    const state = getState();
    const config = getConfig();
    activeWorkers = state.activeWorkers;
    queued = state.queue.length;
    maxConcurrency = config.concurrency;
    backend = config.backend;
  } catch {}

  return {
    total_runs: (dbStats as Record<string, unknown>).total_runs as number || 0,
    completed: (dbStats as Record<string, unknown>).completed as number | null,
    errors: (dbStats as Record<string, unknown>).errors as number | null,
    running: (dbStats as Record<string, unknown>).running as number | null,
    total_cost_usd: (dbStats as Record<string, unknown>).total_cost_usd as number | null,
    total_turns: (dbStats as Record<string, unknown>).total_turns as number | null,
    avg_cost_usd: (dbStats as Record<string, unknown>).avg_cost_usd as number | null,
    avg_turns: (dbStats as Record<string, unknown>).avg_turns as number | null,
    active_workers: activeWorkers,
    queued,
    max_concurrency: maxConcurrency,
    backend,
  };
}

export { listSkills as getSkills } from "@/lib/db";

export function getServerStatus(): Record<string, unknown> {
  let activeWorkers = 0;
  let queued = 0;
  let maxConcurrency = 3;
  let backend = "local";
  let cli = "claude";

  try {
    const { getState } = require("@/lib/oc/state");
    const { getConfig } = require("@/lib/oc/config");
    const state = getState();
    const config = getConfig();
    activeWorkers = state.activeWorkers;
    queued = state.queue.length;
    maxConcurrency = config.concurrency;
    backend = config.backend;
    cli = config.cli;
  } catch {}

  return {
    name: "opencompletions",
    status: "ok",
    cli,
    backend,
    active_workers: activeWorkers,
    queued,
    max_concurrency: maxConcurrency,
  };
}
