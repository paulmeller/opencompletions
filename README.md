# OpenCompletions

A Next.js application that wraps CLI coding agents (Claude Code, OpenCode, Codex, Gemini) as a unified completions API with an integrated dashboard. Exposes OpenAI-compatible, Anthropic-compatible, and multi-turn Agent endpoints with SSE streaming.

## Quick Start

```bash
npm install
npm run dev    # Development on port 3000
```

## Environment Variables

Required:

- `SESSION_SECRET` — encrypts SQLite settings + internal MCP auth
- `WORKOS_CLIENT_ID` — WorkOS login
- `WORKOS_API_KEY` — WorkOS key management + validation
- `WORKOS_COOKIE_PASSWORD` — encrypts session cookie
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI` — OAuth callback URL

Backend config (sprite tokens, claude tokens, etc.) is managed via the Settings page in the dashboard.

## API Endpoints

All under `/api/v1/`. Auth via `Authorization: Bearer <key>` or `x-api-key` header.

### Completions (OpenAI-compatible)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/chat/completions` | Chat completion (streaming supported) |
| POST | `/api/v1/completions` | Text completion |
| POST | `/api/v1/embeddings` | Hash-based stub embeddings |
| POST | `/api/v1/responses` | OpenAI Responses API format |

### Completions (Anthropic-compatible)

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/messages` | Message creation (streaming supported) |
| POST | `/api/v1/messages/count_tokens` | Token estimation |

### Agent

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/agent` | Multi-turn agent with tool use, MCP servers, session resumption |

Agent request body:

```json
{
  "prompt": "Your task",
  "stream": true,
  "max_turns": 10,
  "workspace_id": "...",
  "allowed_tools": ["Read", "Write", "Bash"],
  "mcp_servers": {
    "my-server": { "type": "http", "url": "...", "headers": {} }
  },
  "session_id": "...",
  "max_budget_usd": 1.0,
  "model": "claude-sonnet-4-20250514"
}
```

### Files & Workspaces

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/v1/files/upload` | Upload file (returns workspace_id) |
| GET | `/api/v1/files/{workspace_id}` | List workspace files |
| GET | `/api/v1/files/{workspace_id}/{filename}` | Download file |
| DELETE | `/api/v1/files/{workspace_id}` | Delete workspace |

### Utility

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | Server status |
| GET | `/api/v1/models` | Available models |
| GET | `/api/v1/backends` | Available backends |
| GET | `/api/v1/status` | Queue depth and workers |
| GET | `/api/v1/runs` | Agent run history |
| POST | `/api/v1/setup` | Run setup commands (admin-only) |

## Backends

Three execution backends, selectable per-request or globally:

- **local** — spawns CLI as a subprocess on the same machine
- **sprite** — delegates to Sprites.dev cloud VMs with pool and session affinity
- **vercel** — delegates to Vercel Sandbox microVMs

## Setup Commands

One-time shell commands that run on each backend instance at startup (e.g. installing Claude Code plugins).

Configure via the dashboard Settings page or the `SETUP_COMMANDS` env var (comma or newline-separated). Commands are idempotent — a content-addressed sentinel prevents re-runs unless the list changes.

Example — installing the document-skills plugin:

```
claude plugin marketplace add anthropics/skills
claude plugin install document-skills@anthropic-agent-skills
```

Use the **"Run Setup Now"** button in Settings or `POST /api/v1/setup` with `{"force": true}` to re-run.

## Authentication

- **Browser**: WorkOS AuthKit session cookie
- **API**: WorkOS API keys (created on Keys page), sent as `Authorization: Bearer <key>`
- **Admin bypass**: `API_KEY` env var or `api_key` in settings DB
- **Internal MCP**: `SESSION_SECRET` as Bearer token (auto-injected)

## Architecture

```
app/(dashboard)/     Dashboard UI (playground, runs, keys, settings, skills)
app/api/v1/          External API routes
app/api/             Dashboard management routes
lib/oc/              Engine (config, state, queue, backends, streaming, files, auth, setup)
lib/oc/backends/     Execution backends (local, sprite, vercel)
lib/                 Shared utilities (db, auth)
components/          UI components (shadcn/ui)
```
