# Credential Flow: Single-Token Auth

## Problem

Today, clients need up to two tokens per request:

1. **Gateway token** (`Authorization: Bearer`) — authenticates the caller to the server (WorkOS API key or shared `--api-key`)
2. **LLM token** (`x-api-key` header) — forwarded to the CLI as `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`

Backend credentials (sprite/vercel) are always server-side config and not client-facing.

The goal: a client sends **only their WorkOS API key**. The server resolves the LLM credential from the dashboard's credential store, so the client never needs to know or manage an Anthropic key.

## Current Token Resolution (server.js `buildAuthEnv`)

```
x-api-key header          (per-request, client-provided)
  | empty?
--anthropic-api-key        (server-wide fallback)
  | empty?
--claude-token             (server-wide OAuth fallback)
```

This works for single-tenant deployments where one Anthropic key serves everyone. It does not support per-org keys.

## Proposed Token Resolution

```
x-api-key header                (per-request override — power users, testing)
  | empty?
credential store lookup by org  (per-org, stored in dashboard)
  | empty?
--anthropic-api-key             (server-wide fallback)
  | empty?
--claude-token                  (server-wide OAuth fallback)
```

## Changes: OpenCompletions Server

### 1. Add credential store interface (`auth.js`)

New export: `getCredentials(orgId) -> { anthropicApiKey?, claudeOauthToken? } | null`

The store backing is pluggable (same pattern as auth providers):

- **config provider**: credentials live in the same JSON config file under each key's entry:
  ```json
  {
    "keys": {
      "key_abc123": {
        "keyId": "key_abc123",
        "orgId": "org_456",
        "permissions": ["*"],
        "credentials": {
          "anthropicApiKey": "sk-ant-api03-...",
        }
      }
    }
  }
  ```

- **workos provider**: credentials fetched from dashboard API (see Dashboard changes below). Cached with the same TTL as auth validation (60s fresh, 5min grace).

### 2. Wire `authContext` into `buildAuthEnv` (`server.js`)

Current signature:
```js
function buildAuthEnv(clientToken)
```

New signature:
```js
function buildAuthEnv(clientToken, authContext)
```

Implementation:
```js
function buildAuthEnv(clientToken, authContext) {
  const env = { ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" };

  // Priority 1: per-request client token (x-api-key header)
  const token = clientToken || null;
  if (token) {
    if (token.startsWith("sk-ant-oat")) {
      env.CLAUDE_CODE_OAUTH_TOKEN = token;
    } else {
      env.ANTHROPIC_API_KEY = token;
    }
    return env;
  }

  // Priority 2: per-org credentials from dashboard store
  if (authContext?.orgId && authModule?.getCredentials) {
    const creds = authModule.getCredentials(authContext.orgId);
    if (creds?.anthropicApiKey) {
      env.ANTHROPIC_API_KEY = creds.anthropicApiKey;
      return env;
    }
    if (creds?.claudeOauthToken) {
      env.CLAUDE_CODE_OAUTH_TOKEN = creds.claudeOauthToken;
      return env;
    }
  }

  // Priority 3: server-wide fallback
  if (CONFIGURED_API_KEY) {
    env.ANTHROPIC_API_KEY = CONFIGURED_API_KEY;
  } else if (CONFIGURED_OAUTH_TOKEN) {
    env.CLAUDE_CODE_OAUTH_TOKEN = CONFIGURED_OAUTH_TOKEN;
  }
  return env;
}
```

### 3. Pass `authContext` through call sites

Every place that calls `buildAuthEnv(clientToken)` needs the auth context passed through:

- `runClaudeLocal` / `runClaudeLocalStreaming` / `runAgentLocal`
- `buildSpriteBody` / `runClaudeOnSprite` / `runClaudeSpriteStreaming` / `runAgentOnSprite`
- `runClaudeOnVercel` / `runClaudeVercelStreaming` / `runAgentOnVercel`

The `authContext` is already available in the request handler and passed to `enqueue()` — it just needs to be threaded into the exec functions.

### 4. Credential store cache

For the WorkOS provider, credential lookups should be cached alongside the auth validation to avoid an extra API call per request. The `workosCache` already stores `authContext` — extend it to include the resolved credentials:

```js
workosCache: hash -> { authContext, credentials, cachedAt }
```

## Changes: Dashboard

### 1. Credential storage

The dashboard needs a secure store for **three categories** of credentials per org:

| Category | Keys | What they do |
|----------|------|-------------|
| **LLM credentials** | `anthropicApiKey`, `claudeOauthToken` | Forwarded to the CLI as `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` to authenticate with the LLM provider |
| **Backend credentials** | `spriteToken`, `spriteNames[]`, `vercelToken`, `vercelTeamId`, `vercelProjectId`, `vercelSnapshotId` | Infrastructure keys that tell the server how to reach the execution backend (Sprite VMs or Vercel sandboxes) |
| **Server auth** | `apiKey` (the `--api-key` value), `workosApiKey` (server-side `WORKOS_API_KEY` for validating client tokens) | Keys that configure the server's own auth layer |

All three categories are required for a fully functional deployment. Today they're all passed as CLI flags or env vars by whoever operates the server. The dashboard should own and provision all of them so that spinning up a new org or rotating a key doesn't require redeploying the server.

Requirements:

- Encrypted at rest (not plaintext in a database)
- Scoped per `orgId`
- CRUD via the dashboard UI (org admins can manage their own; platform admins can manage backend/server keys)
- Audit log for every credential change

Schema (conceptual):
```
org_credentials:
  orgId              TEXT PRIMARY KEY

  -- LLM credentials
  anthropicApiKey    TEXT ENCRYPTED
  claudeOauthToken   TEXT ENCRYPTED

  -- Backend credentials
  backend            TEXT ("local" | "sprite" | "vercel")
  spriteToken        TEXT ENCRYPTED
  spriteNames        TEXT (JSON array, e.g. ["worker-1", "worker-2"])
  vercelToken        TEXT ENCRYPTED
  vercelTeamId       TEXT
  vercelProjectId    TEXT
  vercelSnapshotId   TEXT

  -- Server auth
  serverApiKey       TEXT ENCRYPTED  (the --api-key value for this org's server)
  workosApiKey       TEXT ENCRYPTED  (WORKOS_API_KEY for token validation)

  -- Metadata
  updatedAt          TIMESTAMP
  updatedBy          TEXT (user who last changed it)
```

Note: Not every org needs every field. A local-backend org only needs LLM + server auth credentials. A sprite-backend org additionally needs `spriteToken` + `spriteNames`. The dashboard UI should show/hide fields based on the selected backend.

### 2. Credential API endpoint

The OpenCompletions server needs to fetch credentials after validating a WorkOS token. Two options:

**Option A: Pull model** — server calls dashboard API to fetch credentials by orgId.

```
GET /api/credentials/:orgId
Authorization: Bearer <server-to-server-key>
→ {
    "llm": { "anthropicApiKey": "sk-ant-...", "claudeOauthToken": null },
    "backend": { "type": "sprite", "spriteToken": "...", "spriteNames": ["w-1", "w-2"] },
    "auth": { "serverApiKey": "...", "workosApiKey": "..." }
  }
```

Pros: simple, stateless server. Cons: extra network hop per request (mitigated by caching).

**Option B: Push model** — dashboard syncs credentials to the server on change.

The dashboard calls a new admin endpoint on the server to upsert credentials:
```
PUT /v1/admin/credentials/:orgId
Authorization: Bearer <admin-key>
{ "llm": { "anthropicApiKey": "sk-ant-..." }, "backend": { ... } }
```

Server stores in-memory (or in the SQLite DB if `--db` is configured). No per-request lookup needed.

Pros: zero latency. Cons: server needs state, sync can drift.

**Recommendation: Option A (pull) with aggressive caching.** The auth validation already makes a per-request call to WorkOS (cached 60s). Piggyback the credential lookup onto the same cache entry. The dashboard API is a simple authenticated read.

### 3. Server provisioning

Backend and server auth credentials raise a bigger question: **who starts the server?**

Today the server is started manually with CLI flags. For the dashboard to fully own credentials, there are two models:

**Model 1: Dashboard provisions the server process.** The dashboard starts/restarts the OpenCompletions server with the right `--backend`, `--sprite-token`, `--vercel-token`, etc. flags from the credential store. Credential rotation = server restart. This is the simplest model for single-org deployments.

**Model 2: Server pulls all config at runtime.** The server starts with minimal config (just `--auth-provider workos` and a dashboard URL). On first request for an org, it fetches backend config + LLM credentials from the dashboard. This supports multi-org on one server but requires the server to dynamically switch backends per request — a larger refactor.

For now, **Model 1 is simpler** and aligns with how things work today. The dashboard stores the credentials and uses them to generate the server's startup command / environment. Backend credentials change rarely (unlike LLM keys), so restart-on-change is acceptable.

LLM credentials (which rotate more often) still use the pull-per-request model from the previous section.

### 4. Dashboard UI

Org settings page needs three sections:

**LLM Credentials:**
- Input fields for Anthropic API key and/or OAuth token
- Key is masked after save (show last 4 chars only)
- "Test" button that validates the key against Anthropic's API
- Rotation support: save a new key, old one is immediately replaced

**Backend Configuration:**
- Backend type selector (local / sprite / vercel)
- Conditional fields based on backend:
  - Sprite: token, sprite names (add/remove from pool)
  - Vercel: token, team ID, project ID, snapshot ID
  - Local: no extra fields
- "Test connection" button that validates the backend is reachable

**Server Auth:**
- Server API key (the `--api-key` value)
- WorkOS API key (for the server's `WORKOS_API_KEY`)
- Auto-generate option for the server API key

All sections:
- Audit log: who changed what credential and when
- Masked display (show last 4 chars only)

### 5. Dashboard-to-server auth

The credential API endpoint needs its own authentication. Options:

- Shared secret (`DASHBOARD_API_KEY` env var on both sides)
- mTLS between dashboard and server
- WorkOS service account key

The simplest starting point is a shared secret configured on both the dashboard and the OpenCompletions server.

## Migration / Backward Compatibility

All changes are additive. Existing deployments continue to work:

- No `authContext`? → `buildAuthEnv` skips the credential lookup, falls through to existing behavior
- No credential store configured? → same as today
- Client sends `x-api-key`? → still takes priority (power users, testing, gradual migration)

The `x-api-key` header remains the escape hatch for clients that want to manage their own keys.

## Summary

| Component | Change | Scope |
|-----------|--------|-------|
| **server.js** | Thread `authContext` into `buildAuthEnv`, add credential lookup step | ~20 lines changed across call sites |
| **auth.js** | Add `getCredentials(orgId)` with cache, config + workos providers | ~50 lines new |
| **Dashboard API** | New `GET /api/credentials/:orgId` endpoint (LLM, backend, auth) | New route + controller |
| **Dashboard DB** | `org_credentials` table with encryption (3 credential categories) | New migration |
| **Dashboard UI** | Org settings: LLM credentials, backend config, server auth | 3 new UI sections |
| **Dashboard provisioning** | Use stored backend + auth credentials to start/configure server | Startup script / deploy pipeline |
