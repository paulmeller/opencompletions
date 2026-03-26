# Single-Token Credential Flow

## Why

Running an OpenCompletions deployment today requires juggling multiple secrets across multiple places:

- The **client** needs two tokens per request: a gateway token (`Authorization: Bearer`) to authenticate to the server, and an LLM token (`x-api-key`) to forward to the CLI for Anthropic API access.
- The **server operator** needs to configure backend infrastructure credentials (Sprite tokens, Vercel PATs) and server auth keys via CLI flags or env vars.
- **Rotating any credential** means touching env vars, restarting the server, or updating client config.

This is workable for a single developer, but doesn't scale to a multi-org deployment where the dashboard manages organizations and their API keys via WorkOS.

## Goal

A client sends **one token** — their WorkOS API key. Everything else is resolved server-side:

```
Client                         Server                         Dashboard
  |                              |                               |
  |-- Bearer <workos-key> ------>|                               |
  |                              |-- validate key --------------->| WorkOS
  |                              |<-- orgId, permissions ---------|
  |                              |                               |
  |                              |-- GET /api/credentials/org_X ->|
  |                              |<-- { anthropicApiKey: "..." } -|
  |                              |                               |
  |                              |   (backend creds already       |
  |                              |    configured at startup       |
  |                              |    by dashboard)               |
  |                              |                               |
  |                              |-- spawn CLI w/ ANTHROPIC_API_KEY
  |<---- response ---------------|
```

## Three Categories of Credentials

| Category | Examples | Who provides today | Who should provide |
|----------|---------|-------------------|-------------------|
| **LLM** | `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` | Client via `x-api-key` header, or server-wide fallback | Dashboard, per-org |
| **Backend** | `SPRITE_TOKEN`, `SPRITE_NAME`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`, `VERCEL_SNAPSHOT_ID` | Server operator via CLI flags | Dashboard, at server startup |
| **Server auth** | `API_KEY` (gateway), `WORKOS_API_KEY` (token validation) | Server operator via CLI flags | Dashboard, at server startup |

**LLM credentials** change per-org and rotate frequently. They must be resolved per-request.

**Backend and server auth credentials** are infrastructure config. They change rarely and apply to the whole server process. They're set at startup time.

---

## Changes: `opencompletions` (server)

### 1. New credential resolution in `buildAuthEnv` (server.js)

Today's resolution:

```
x-api-key header        → per-request, client-provided
  ↓ empty?
--anthropic-api-key     → server-wide fallback
  ↓ empty?
--claude-token          → server-wide OAuth fallback
```

New resolution (insert one step):

```
x-api-key header        → per-request override (power users, testing)
  ↓ empty?
credential store by org → per-org, fetched from dashboard       ← NEW
  ↓ empty?
--anthropic-api-key     → server-wide fallback
  ↓ empty?
--claude-token          → server-wide OAuth fallback
```

The function signature changes from `buildAuthEnv(clientToken)` to `buildAuthEnv(clientToken, authContext)`. When `clientToken` is empty and `authContext.orgId` is present, the server calls the dashboard's credential API to fetch the org's LLM key.

### 2. New `getCredentials` export in auth.js

```js
// auth.js — new export
async function getCredentials(orgId) → { anthropicApiKey?, claudeOauthToken? } | null
```

Two backing implementations (matching existing auth provider pattern):

- **config provider**: reads credentials from the same JSON config file, under `keys[].credentials`.
- **workos provider**: calls the dashboard API (`GET /api/credentials/:orgId`), cached with the same TTL as auth validation (60s fresh, 5min grace on outage).

### 3. Thread `authContext` through call sites

`authContext` is already available in the HTTP request handler. It needs to be passed through to every function that calls `buildAuthEnv`:

- `runClaudeLocal` / `runClaudeLocalStreaming` / `runAgentLocal`
- `buildSpriteBody` / `runClaudeOnSprite` / `runClaudeSpriteStreaming` / `runAgentOnSprite`
- `runClaudeOnVercel` / `runClaudeVercelStreaming` / `runAgentOnVercel`

This is mechanical — adding one parameter to each function and passing it through `enqueue()`.

### 4. New server flag: `--credentials-url`

```
node server.js \
  --auth-provider workos \
  --credentials-url https://dashboard.example.com/api/credentials \
  --credentials-key <shared-secret>
```

When set, `getCredentials(orgId)` calls `GET <credentials-url>/<orgId>` with the shared secret as a Bearer token.

### Scope

| File | Change | Size |
|------|--------|------|
| `server.js` | Add `authContext` param to `buildAuthEnv` + all call sites | ~20 lines |
| `auth.js` | Add `getCredentials()` with config + HTTP providers, caching | ~60 lines |

---

## Changes: `opencompletions-dashboard`

### 1. Credential storage (DB)

New table for encrypted credentials, scoped per org:

```sql
CREATE TABLE org_credentials (
  org_id          TEXT NOT NULL,
  key_name        TEXT NOT NULL,        -- e.g. 'anthropicApiKey', 'spriteToken'
  encrypted_value BLOB NOT NULL,        -- AES-256-GCM with server-side key
  updated_at      TIMESTAMP DEFAULT NOW(),
  updated_by      TEXT,                 -- user ID who last changed it
  PRIMARY KEY (org_id, key_name)
);

CREATE TABLE credential_audit_log (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL,
  key_name   TEXT NOT NULL,             -- which credential changed
  action     TEXT NOT NULL,             -- 'created', 'rotated', 'revoked'
  actor      TEXT NOT NULL,             -- user ID
  created_at TIMESTAMP DEFAULT NOW()
);
```

Encryption key comes from a `CREDENTIALS_ENCRYPTION_KEY` env var. All credential values are encrypted before storage and decrypted only when served to the OC server.

### 2. Server-to-server credential API

One endpoint, called by the OpenCompletions server on each request (cached):

```
GET /api/credentials/:orgId
Authorization: Bearer <shared-secret>

200 OK
{
  "anthropicApiKey": "sk-ant-api03-...",
  "claudeOauthToken": null
}
```

Only returns LLM credentials. Backend and server auth credentials are not served here — they're used at server startup (see section 4).

Auth: shared secret (`CREDENTIALS_API_KEY` env var on the dashboard, `--credentials-key` flag on the OC server). Timing-safe comparison.

Error responses:
- `401` — bad or missing shared secret
- `404` — org has no stored credentials (server falls through to its own fallback)

### 3. Dashboard CRUD API (for the UI)

```
GET    /api/orgs/:orgId/credentials              → all credentials (masked)
PUT    /api/orgs/:orgId/credentials/llm           → upsert LLM keys
PUT    /api/orgs/:orgId/credentials/backend       → upsert backend config
PUT    /api/orgs/:orgId/credentials/auth          → upsert server auth keys
DELETE /api/orgs/:orgId/credentials/:keyName      → revoke a specific credential
```

All responses mask credential values (show prefix + last 4 chars). Full values are never returned to the UI after initial save.

### 4. Server provisioning

The dashboard stores backend and server auth credentials, and uses them to configure the OC server process at startup. This means the dashboard generates the server's environment:

```json
{
  "backend": "sprite",
  "spriteToken": "...",
  "spriteNames": ["worker-1", "worker-2"],
  "apiKey": "...",
  "workosApiKey": "...",
  "credentialsUrl": "https://dashboard.example.com/api/credentials",
  "credentialsKey": "..."
}
```

This could be:
- An env file written to disk and used by the process manager
- Docker/container env vars set by the deployment pipeline
- A startup script generated by the dashboard

The exact mechanism depends on how the server is deployed. The point is: the dashboard is the source of truth for all credentials, and the operator doesn't manually configure them.

When backend or server auth credentials are rotated in the dashboard, the server needs a restart. LLM credentials (fetched per-request) do not require a restart.

### 5. Dashboard UI

Org settings page, three sections:

**LLM Credentials** (org admins can manage):
- Anthropic API Key — masked input, show `sk-ant-...XY4z` after save
- Claude OAuth Token — same masking
- "Test" button — validates against Anthropic's API
- Save / Revoke

**Backend Configuration** (platform admins):
- Backend type dropdown: local / sprite / vercel
- Conditional fields:
  - Sprite: token, sprite names (add/remove)
  - Vercel: token, team ID, project ID, snapshot ID
  - Local: no extra fields
- "Test connection" button

**Server Auth** (platform admins):
- Server API key — auto-generate or manual entry
- WorkOS API key
- These configure the OC server's auth layer

All sections show masked values and link to the audit log.

---

## The Contract Between Systems

```
┌──────────────────────────────────────────────────────────┐
│                    Dashboard                              │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ LLM creds   │  │ Backend creds│  │ Server auth    │  │
│  │ (per-org)   │  │ (per-server) │  │ (per-server)   │  │
│  └──────┬──────┘  └──────┬───────┘  └───────┬────────┘  │
│         │                │                   │           │
│         │          At startup time           │           │
│         │          (env vars / flags)        │           │
│         │                │                   │           │
└─────────┼────────────────┼───────────────────┼───────────┘
          │                │                   │
          │    ┌───────────▼───────────────────▼──────┐
          │    │      OpenCompletions Server           │
          │    │                                       │
          │    │  --backend sprite                     │
          │    │  --sprite-token <from dashboard>      │
          │    │  --api-key <from dashboard>           │
          │    │  --auth-provider workos               │
          │    │  --credentials-url <dashboard URL>    │
          │    │                                       │
          ▼    │                                       │
   Per-request │                                       │
   GET /api/   │  buildAuthEnv(clientToken, authCtx)   │
   credentials │    1. x-api-key header?               │
   /:orgId     │    2. dashboard credential store?  ◄──┼── this is the new step
               │    3. --anthropic-api-key fallback?   │
               │    4. --claude-token fallback?         │
               └───────────────────────────────────────┘
```

The **only runtime contract** between the two systems is:

```
GET /api/credentials/:orgId
Authorization: Bearer <shared-secret>
→ { "anthropicApiKey": "...", "claudeOauthToken": "..." }
```

Everything else (backend config, server auth) flows at deploy/startup time through environment variables or CLI flags that the dashboard generates.

---

## Backward Compatibility

All changes are additive:

- **No dashboard?** Server works exactly as today. `buildAuthEnv` skips the credential lookup and falls through to `--anthropic-api-key` / `--claude-token`.
- **No `--credentials-url`?** Same — no per-org lookup, server-wide fallback only.
- **Client sends `x-api-key`?** Still takes priority. Power users and testing workflows are unaffected.
- **No WorkOS?** The `--api-key` (shared secret) auth mode still works. The credential store also works with the `config` provider (JSON file) for dev/test.
