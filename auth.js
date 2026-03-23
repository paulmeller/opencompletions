/**
 * Pluggable auth for OpenCompletions.
 *
 * Three providers:
 *   - none:   single shared --api-key (handled in server.js, this module not loaded)
 *   - config: JSON file mapping keys to permissions (dev/test)
 *   - workos: WorkOS API Keys validation (production)
 *
 * validateKey() returns an auth context or null:
 *   { keyId, orgId, orgName, permissions, metadata, expiresAt, rateLimit }
 */

const { createHash, timingSafeEqual } = require("crypto");
const fs = require("fs");

// ---------------------------------------------------------------------------
// Config provider — JSON file with hot-reload
// ---------------------------------------------------------------------------

let configCache = null;
let configMtime = 0;

function loadConfig(configPath) {
  if (!configPath) return null;
  try {
    const stat = fs.statSync(configPath);
    if (stat.mtimeMs === configMtime && configCache) return configCache;
    configCache = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    configMtime = stat.mtimeMs;
    return configCache;
  } catch (err) {
    console.warn(`[auth] Failed to load config ${configPath}: ${err.message}`);
    return configCache; // return stale cache if available
  }
}

function validateConfig(bearerToken, configPath) {
  const config = loadConfig(configPath);
  if (!config || !config.keys) return null;

  // Timing-safe lookup: iterate all keys, constant-time compare each
  const tokenBuf = Buffer.from(bearerToken);
  let match = null;
  for (const [key, entry] of Object.entries(config.keys)) {
    const keyBuf = Buffer.from(key);
    if (tokenBuf.length === keyBuf.length && timingSafeEqual(tokenBuf, keyBuf)) {
      match = entry;
    }
  }
  if (!match) return null;

  return {
    keyId: match.keyId || bearerToken.slice(0, 12),
    orgId: match.orgId || null,
    orgName: match.orgName || null,
    permissions: match.permissions || [],
    metadata: match.metadata || {},
    expiresAt: match.expiresAt || null,
    rateLimit: match.rateLimit || null,
  };
}

// ---------------------------------------------------------------------------
// WorkOS provider — validates via WorkOS API Keys SDK
// ---------------------------------------------------------------------------

let workos = null;

function initWorkos() {
  if (workos) return workos;
  try {
    const WorkOS = require("@workos-inc/node").WorkOS;
    workos = new WorkOS(process.env.WORKOS_API_KEY);
    return workos;
  } catch (err) {
    console.error("[auth] WorkOS SDK not installed. Run: npm install @workos-inc/node@7.5.0");
    return null;
  }
}

// In-memory cache: hash → { authContext, cachedAt }
const workosCache = new Map();
const WORKOS_CACHE_TTL_MS = 60 * 1000; // 60 seconds
const WORKOS_GRACE_TTL_MS = 5 * 60 * 1000; // 5 min grace on outage

async function validateWorkos(bearerToken) {
  const hash = createHash("sha256").update(bearerToken).digest("hex");
  const cached = workosCache.get(hash);
  const now = Date.now();

  // Return from cache if fresh
  if (cached && now - cached.cachedAt < WORKOS_CACHE_TTL_MS) {
    return cached.authContext;
  }

  const sdk = initWorkos();
  if (!sdk) return null;

  try {
    const { apiKey } = await sdk.apiKeys.validateApiKey({ apiKey: bearerToken });
    if (!apiKey) {
      // Key invalid — do NOT cache failures
      return null;
    }
    const authContext = {
      keyId: apiKey.id,
      orgId: apiKey.organizationId || null,
      orgName: null,
      permissions: (apiKey.permissions || []).map((p) => p.slug || p),
      metadata: apiKey.metadata || {},
      expiresAt: apiKey.expiresAt ? new Date(apiKey.expiresAt).getTime() : null,
      rateLimit: null,
    };
    workosCache.set(hash, { authContext, cachedAt: now });
    return authContext;
  } catch (err) {
    // WorkOS unreachable — honor grace period
    if (cached && now - cached.cachedAt < WORKOS_GRACE_TTL_MS) {
      console.warn(`[auth] WorkOS unreachable, using cached auth for ${hash.slice(0, 8)}... (grace period)`);
      return cached.authContext;
    }
    console.error(`[auth] WorkOS error: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function validateKey(bearerToken, provider, configPath) {
  if (!bearerToken) return null;

  if (provider === "config") {
    return validateConfig(bearerToken, configPath);
  }

  if (provider === "workos") {
    return validateWorkos(bearerToken);
  }

  // Unknown provider
  return null;
}

module.exports = { validateKey };
