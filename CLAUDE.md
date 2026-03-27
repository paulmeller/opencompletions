# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

OpenCompletions is a Next.js application that wraps CLI coding agents (Claude Code, OpenCode, Codex, Gemini) as a completions API with an integrated dashboard. It exposes OpenAI-compatible, Anthropic-compatible, and multi-turn Agent endpoints with SSE streaming.

## Running

```bash
npm run dev    # Development on port 3000
npm run build  # Production build
npm start      # Production server
```

## Environment Variables

Only 5 environment variables are needed:

- `SESSION_SECRET` — encrypts SQLite settings + internal MCP auth
- `WORKOS_CLIENT_ID` — WorkOS login
- `WORKOS_API_KEY` — WorkOS key management + validation
- `WORKOS_COOKIE_PASSWORD` — encrypts session cookie
- `NEXT_PUBLIC_WORKOS_REDIRECT_URI` — OAuth callback URL

Backend config (sprite tokens, claude tokens, etc.) is managed via the Settings page in the UI.

## Architecture

Single Next.js app with:

- **Dashboard UI** (shadcn/ui + WorkOS AuthKit) under `app/(dashboard)/`
- **API routes** under `app/api/v1/` (completions, agent, models, runs, files, etc.)
- **Engine modules** under `lib/oc/` (config, state, queue, CLI providers, backends, streaming, files, auth)
- **SQLite database** (better-sqlite3) with settings, skills, agent_runs, user_keys tables
- **4 CLI providers**: claude, opencode, codex, gemini
- **3+ execution backends**: local (subprocess), sprite (Sprites.dev VMs), vercel (Vercel Sandbox), cloudflare (coming)

## Key Endpoints

All under `/api/v1/`:

- `POST /api/v1/chat/completions` — OpenAI chat
- `POST /api/v1/completions` — OpenAI legacy
- `POST /api/v1/messages` — Anthropic messages
- `POST /api/v1/agent` — Multi-turn agent (SSE streaming)
- `GET /api/v1/models` — Model list
- `GET /api/v1/backends` — Available backends
- `GET /api/v1/runs` — Agent run history
- `POST /api/v1/files/upload` — Upload to workspace
- `POST /api/mcp` — Skills MCP server (JSON-RPC 2.0)

## Authentication

- **Browser**: WorkOS AuthKit session cookie (automatic on login)
- **External API**: WorkOS API keys (created on Keys page, sent as Bearer token)
- **Internal MCP**: SESSION_SECRET as Bearer token (injected by agent route)
- Every user gets a Default API key auto-created on first login

## Database

Single SQLite file with 5 tables:

- `settings` — encrypted key-value config
- `skills` / `skill_resources` — MCP skills with reference files
- `agent_runs` — execution history
- `user_keys` — per-user API keys (encrypted)

## Testing

```bash
# Build check
npm run build

# Test endpoints
curl http://localhost:3000/api/v1/models
curl http://localhost:3000/api/health
```

## Key Directories

- `app/(dashboard)/` — Dashboard pages (playground, runs, keys, settings, skills)
- `app/api/v1/` — External API routes
- `app/api/` — Dashboard management routes (keys, settings, skills, mcp)
- `lib/oc/` — Engine modules (config, state, queue, backends, streaming, etc.)
- `lib/oc/backends/` — Execution backends (local, sprite, vercel)
- `lib/` — Shared utilities (db, auth, utils)
- `components/` — UI components (shadcn/ui)
- `public/` — Static assets (openapi.json)
