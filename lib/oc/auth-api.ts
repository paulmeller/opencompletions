/**
 * Authentication API for the OpenCompletions engine.
 *
 * Three validation strategies:
 *   - WorkOS API Keys (production) -- validates via WorkOS SDK with 60s cache and 5min grace period
 *   - Config provider (dev/test) -- JSON file with hot-reload and timing-safe comparison
 *   - Admin bypass -- simple bearer token match against config.apiKey
 *
 * Ported from auth.js (~150 lines).
 */

import { createHash, timingSafeEqual } from "crypto";
import fs from "fs";
import { getConfig } from "./config";
import type { AuthContext } from "./types";

// ---------------------------------------------------------------------------
// Config provider -- JSON file with hot-reload
// ---------------------------------------------------------------------------

let configCache: Record<string, unknown> | null = null;
let configMtime = 0;

interface ConfigKeyEntry {
  keyId?: string;
  orgId?: string;
  orgName?: string;
  permissions?: string[];
  metadata?: Record<string, unknown>;
  expiresAt?: number;
  rateLimit?: { maxRequests: number; windowMs: number };
}

function loadConfig(configPath: string): Record<string, unknown> | null {
  if (!configPath) return null;
  try {
    const stat = fs.statSync(configPath);
    if (stat.mtimeMs === configMtime && configCache) return configCache;
    configCache = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    configMtime = stat.mtimeMs;
    return configCache;
  } catch (err) {
    console.warn(`[auth] Failed to load config ${configPath}: ${(err as Error).message}`);
    return configCache; // return stale cache if available
  }
}

function validateConfig(bearerToken: string, configPath: string): AuthContext | null {
  const config = loadConfig(configPath) as { keys?: Record<string, ConfigKeyEntry> } | null;
  if (!config || !config.keys) return null;

  // Timing-safe lookup: iterate all keys, constant-time compare each
  const tokenBuf = Buffer.from(bearerToken);
  let match: ConfigKeyEntry | null = null;
  for (const [key, entry] of Object.entries(config.keys)) {
    const keyBuf = Buffer.from(key);
    if (tokenBuf.length === keyBuf.length && timingSafeEqual(tokenBuf, keyBuf)) {
      match = entry;
    }
  }
  if (!match) return null;

  return {
    keyId: match.keyId || bearerToken.slice(0, 12),
    orgId: match.orgId || undefined,
    orgName: match.orgName || undefined,
    permissions: match.permissions || [],
    metadata: match.metadata || {},
    expiresAt: match.expiresAt || undefined,
    rateLimit: match.rateLimit || undefined,
  };
}

// ---------------------------------------------------------------------------
// WorkOS provider -- validates via WorkOS API Keys SDK
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let workos: any = null;

function initWorkos(): unknown {
  if (workos) return workos;
  try {
    // Dynamic import for optional dependency
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { WorkOS } = require("@workos-inc/node");
    workos = new WorkOS(process.env.WORKOS_API_KEY);
    return workos;
  } catch (err) {
    console.error("[auth] WorkOS SDK not installed. Run: npm install @workos-inc/node");
    return null;
  }
}

// In-memory cache: hash -> { authContext, cachedAt }
const workosCache = new Map<string, { authContext: AuthContext; cachedAt: number }>();
const WORKOS_CACHE_TTL_MS = 60 * 1000; // 60 seconds
const WORKOS_GRACE_TTL_MS = 5 * 60 * 1000; // 5 min grace on outage

async function validateWorkos(bearerToken: string): Promise<AuthContext | null> {
  const hash = createHash("sha256").update(bearerToken).digest("hex");
  const cached = workosCache.get(hash);
  const now = Date.now();

  // Return from cache if fresh
  if (cached && now - cached.cachedAt < WORKOS_CACHE_TTL_MS) {
    return cached.authContext;
  }

  const sdk = initWorkos() as {
    apiKeys?: {
      validateApiKey(opts: { value: string }): Promise<{
        apiKey: {
          id: string;
          owner?: { id?: string };
          name?: string;
          permissions?: string[];
        } | null;
      }>;
    };
  } | null;
  if (!sdk) return null;

  try {
    // WorkOS SDK v8+: apiKeys.validateApiKey({ value: "..." })
    // Returns { apiKey: ApiKey | null }
    // ApiKey: { id, owner: { type, id }, name, permissions: string[], ... }
    const { apiKey } = await sdk.apiKeys!.validateApiKey({ value: bearerToken });
    if (!apiKey) {
      return null; // invalid -- do NOT cache failures
    }
    const authContext: AuthContext = {
      keyId: apiKey.id,
      orgId: apiKey.owner?.id || undefined,
      orgName: apiKey.name || undefined,
      permissions: apiKey.permissions || [],
      metadata: {},
      expiresAt: undefined,
      rateLimit: undefined,
    };
    workosCache.set(hash, { authContext, cachedAt: now });
    return authContext;
  } catch (err) {
    // WorkOS unreachable -- honor grace period
    if (cached && now - cached.cachedAt < WORKOS_GRACE_TTL_MS) {
      console.warn(
        `[auth] WorkOS unreachable, using cached auth for ${hash.slice(0, 8)}... (grace period)`,
      );
      return cached.authContext;
    }
    console.error(`[auth] WorkOS error: ${(err as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main validation entry point
// ---------------------------------------------------------------------------

/**
 * Validate an API key using the specified provider.
 * Returns an AuthContext on success, or null if invalid/unknown.
 */
export async function validateApiKey(
  bearerToken: string,
  provider: "config" | "workos",
  configPath?: string,
): Promise<AuthContext | null> {
  if (!bearerToken) return null;

  if (provider === "config") {
    return validateConfig(bearerToken, configPath || "");
  }

  if (provider === "workos") {
    return validateWorkos(bearerToken);
  }

  // Unknown provider
  return null;
}

// ---------------------------------------------------------------------------
// Unified request authentication
// ---------------------------------------------------------------------------

/**
 * Authenticate an incoming request. Checks in order:
 *   1. WorkOS API Key validation (if WORKOS_API_KEY env is set)
 *   2. Bearer token against config.apiKey (admin bypass)
 *   3. Falls back to null (unauthorized)
 *
 * Returns AuthContext | null.
 */
export async function authenticateRequest(
  request: Request,
): Promise<AuthContext | null> {
  const config = getConfig();

  // Extract Bearer token from Authorization header
  const authHeader = request.headers.get("authorization") || "";
  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : null;

  if (!bearerToken) return null;

  // 1. Try WorkOS if configured
  if (process.env.WORKOS_API_KEY) {
    const ctx = await validateWorkos(bearerToken);
    if (ctx) return ctx;
  }

  // 2. Admin bypass: check against config.apiKey (timing-safe)
  if (config.apiKey && bearerToken.length === config.apiKey.length && timingSafeEqual(Buffer.from(bearerToken), Buffer.from(config.apiKey))) {
    return {
      keyId: "admin",
      orgId: undefined,
      orgName: "admin",
      permissions: ["*"],
      metadata: {},
    };
  }

  // 3. Unauthorized
  return null;
}
