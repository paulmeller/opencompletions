/**
 * Configuration module for the OpenCompletions engine.
 *
 * Reads settings from the dashboard SQLite DB (via getSetting/getAllSettingsDecrypted),
 * falls back to environment variables, then sensible defaults.
 * Cached for 30 seconds to avoid hitting the DB on every request.
 *
 * Ported from server.js lines 76-148.
 */

import { getSetting, getAllSettingsDecrypted } from "@/lib/db";
import type { OcConfig } from "./types";

// ---------------------------------------------------------------------------
// Cache (survives Next.js HMR in dev via globalThis)
// ---------------------------------------------------------------------------

const globalForConfig = globalThis as typeof globalThis & {
  __ocCachedConfig?: OcConfig | null;
  __ocCacheTimestamp?: number;
};

const CACHE_TTL_MS = 30_000; // 30 seconds

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(dbKey: string, envKey: string, fallback: string, all?: Record<string, string>): string {
  if (all && all[dbKey] !== undefined && all[dbKey] !== "") return all[dbKey];
  return process.env[envKey] || fallback;
}

function num(dbKey: string, envKey: string, fallback: number, all?: Record<string, string>): number {
  if (all && all[dbKey] !== undefined && all[dbKey] !== "") {
    const n = parseInt(all[dbKey], 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  const envVal = process.env[envKey];
  if (envVal) {
    const n = parseInt(envVal, 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return fallback;
}

function strList(dbKey: string, envKey: string, all?: Record<string, string>): string[] {
  const raw = (all && all[dbKey]) || process.env[envKey] || "";
  if (!raw) return [];
  // Support JSON array or comma-separated
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
    } catch { /* fall through */ }
  }
  // Split on newlines or commas
  return raw.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the current config, reading from DB + env + defaults.
 * Results are cached for 30 seconds.
 */
export function getConfig(): OcConfig {
  const now = Date.now();
  const cachedConfig = globalForConfig.__ocCachedConfig;
  const cacheTimestamp = globalForConfig.__ocCacheTimestamp ?? 0;
  if (cachedConfig && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedConfig;
  }

  let all: Record<string, string>;
  try {
    all = getAllSettingsDecrypted();
  } catch {
    // DB may not be available yet (e.g. during build)
    all = {};
  }

  const config: OcConfig = {
    backend: str("backend", "BACKEND", "local", all) as OcConfig["backend"],
    cli: str("cli", "CLI_NAME", "claude", all),
    concurrency: num("concurrency", "MAX_CONCURRENCY", 3, all),
    timeout: num("timeout", "TIMEOUT_MS", 120_000, all),
    queueDepth: num("queue_depth", "MAX_QUEUE_DEPTH", 100, all),
    agentMaxTurns: num("agent_max_turns", "AGENT_MAX_TURNS", 10, all),
    agentTimeout: num("agent_timeout", "AGENT_TIMEOUT_MS", 600_000, all),
    apiKey: str("api_key", "API_KEY", "", all),

    // Sprite
    spriteToken: str("sprite_token", "SPRITE_TOKEN", "", all),
    spriteNames: strList("sprite_names", "SPRITE_NAMES", all),
    spriteApi: str("sprite_api", "SPRITE_API", "https://api.sprites.dev", all),

    // Vercel Sandbox
    vercelToken: str("vercel_token", "VERCEL_TOKEN", "", all),
    vercelTeamId: str("vercel_team_id", "VERCEL_TEAM_ID", "", all),
    vercelProjectId: str("vercel_project_id", "VERCEL_PROJECT_ID", "", all),
    vercelSnapshotId: str("vercel_snapshot_id", "VERCEL_SNAPSHOT_ID", "", all),

    // Cloudflare Sandbox
    cloudflareAccountId: str("cloudflare_account_id", "CLOUDFLARE_ACCOUNT_ID", "", all),
    cloudflareApiToken: str("cloudflare_api_token", "CLOUDFLARE_API_TOKEN", "", all),
    cloudflareApiUrl: str("cloudflare_api_url", "CLOUDFLARE_API_URL", "", all),

    // LLM credentials
    anthropicApiKey: str("llm_key_claude_api", "ANTHROPIC_API_KEY", "", all),
    claudeToken: str("llm_key_claude_oauth", "CLAUDE_CODE_OAUTH_TOKEN", "", all),
    openaiApiKey: str("llm_key_openai", "OPENAI_API_KEY", "", all),
    geminiApiKey: str("llm_key_gemini", "GEMINI_API_KEY", "", all),

    // File limits
    maxFileSize: num("max_file_size", "MAX_FILE_SIZE", 50 * 1024 * 1024, all),
    maxWorkspaceSize: num("max_workspace_size", "MAX_WORKSPACE_SIZE", 200 * 1024 * 1024, all),
    workspaceTtl: num("workspace_ttl", "WORKSPACE_TTL_MS", 3_600_000, all),

    // Setup commands (run once per backend instance)
    setupCommands: strList("setup_commands", "SETUP_COMMANDS", all),

    // Custom environment variables
    customEnv: (() => {
      try {
        const raw = (all && all.custom_env) || process.env.CUSTOM_ENV || "{}";
        return JSON.parse(raw) as Record<string, string>;
      } catch {
        return {};
      }
    })(),
  };

  globalForConfig.__ocCachedConfig = config;
  globalForConfig.__ocCacheTimestamp = now;
  return config;
}

/** Force the next getConfig() call to re-read from the DB. */
export function invalidateConfigCache(): void {
  globalForConfig.__ocCachedConfig = null;
  globalForConfig.__ocCacheTimestamp = 0;
}
