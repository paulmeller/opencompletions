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

Optional for persistent storage (survives Replit redeploys):
- `TURSO_DATABASE_URL` — Turso database URL (e.g. `libsql://your-db.turso.io`)
- `TURSO_AUTH_TOKEN` — Turso auth token

Without these, uses local SQLite at `data/skills.db` (data lost on redeploy).

## Architecture

Single Next.js app with:

- **Dashboard UI** (shadcn/ui + WorkOS AuthKit) under `app/(dashboard)/`
- **API routes** under `app/api/v1/` (completions, agent, models, runs, files, etc.)
- **Engine modules** under `lib/oc/` (config, state, queue, CLI providers, backends, streaming, files, auth)
- **SQLite database** (Turso/libsql with embedded replicas, falls back to local SQLite) with settings, skills, agent_runs, user_keys tables
- **4 CLI providers**: claude, opencode, codex, gemini
- **3+ execution backends**: local (subprocess), sprite (Sprites.dev VMs), vercel (Vercel Sandbox), cloudflare (coming)

## Key Endpoints

All completion endpoints route through the **agent pipeline** with full MCP tool use and skill support.

**Completion endpoints** (all POST, all route through agent pipeline, all support `skill_filter` + `preload_skills`):
- `/api/v1/chat/completions` — OpenAI chat format (streams `delta.content` chunks, returns `ChatCompletionResponse`)
- `/api/v1/completions` — OpenAI legacy format (streams `choices[].text` chunks, returns `CompletionResponse`)
- `/api/v1/messages` — Anthropic messages format (streams `content_block_delta` events, returns Anthropic `Message`)
- `/api/v1/responses` — OpenAI responses format (streams `output_text.delta` events, returns `Response`)
- `/api/v1/agent` — Native agent format (streams raw agent events: `system`, `assistant`, `tool_use`, `result`)

All endpoints use `enqueueAgent()` internally with MCP tool use. The first four translate agent events into SDK-compatible response formats. The agent endpoint returns raw events for full control.

**Management endpoints**:
- `POST /api/v1/setup` — Run setup commands on backends (admin-only)
- `GET /api/v1/models` — Model list
- `GET /api/v1/backends` — Available backends
- `GET /api/v1/runs` — Agent run history
- `POST /api/v1/files/upload` — Upload to workspace
- `POST /api/mcp` — Skills MCP server (JSON-RPC 2.0)

**Skills management**:
- `GET/POST /api/skills` — List/create skills
- `POST /api/skills/import` — Import from SKILL.md format (single or bulk, upsert)
- `GET /api/skills/{name}/export` — Export as SKILL.md format

## Skills

Skills are domain-specific instructions + reference files that agents can use. Stored in SQLite, served via MCP.

**Loading skills in requests** (all completion endpoints support these fields):
- `skill_filter: {names?, tags?}` — whitelist which DB skills the MCP exposes
- `preload_skills: [{name?} | {instructions?, resources?}]` — inject skill content directly into system prompt (no MCP round-trip, 100KB cap)

**Modes**:
1. No skill params → all DB skills available via MCP (default)
2. `skill_filter` only → MCP exposes filtered subset, agent discovers via tool use
3. `preload_skills` only → instructions injected into prompt, MCP skipped
4. Both → preloaded in prompt + filtered MCP for additional discovery

**Import/Export**:
- `POST /api/skills/import` — accepts SKILL.md format (YAML frontmatter + markdown body + resources map), supports bulk and upsert
- `GET /api/skills/{name}/export` — returns SKILL.md + resources for round-trip editing

**SKILL.md format**:
```
---
name: Contract Risk Analyzer
description: Analyzes contracts for risk
tags: [legal, contracts]
---

# Instructions
When activated, analyze the contract...
```

## Authentication

- **Browser**: WorkOS AuthKit session cookie (automatic on login)
- **External API**: WorkOS API keys (created on Keys page, sent as Bearer token)
- **Internal MCP**: SESSION_SECRET as Bearer token (injected by agent route)
- Every user gets a Default API key auto-created on first login

## Setup Commands

One-time shell commands that run on each backend instance at startup (e.g. installing Claude Code plugins). Configured via:

- **Dashboard**: Settings → "Setup Commands" textarea (one command per line)
- **Database**: `setup_commands` key in settings table (newline or comma-separated)
- **Environment**: `SETUP_COMMANDS` env var

Commands are idempotent via a content-addressed sentinel hash (`~/.opencompletions/.setup-done` on local, `/root/.oc-setup-done` on sprites). They only re-run when the command list changes. Use `POST /api/v1/setup` with `{"force": true}` or the dashboard "Run Setup Now" button to bypass the sentinel.

Example for document-skills plugin (two commands, marketplace must be added first):
```
claude plugin marketplace add anthropics/skills
claude plugin install document-skills@anthropic-agent-skills
```

Implementation: `lib/oc/setup.ts` (runLocalSetup, runSpriteSetup), called from `lib/oc/init.ts` during startup.

## Database

Single SQLite file with 5 tables:

- `settings` — encrypted key-value config
- `skills` / `skill_resources` — MCP skills with reference files
- `agent_runs` — execution history
- `user_keys` — per-user API keys (encrypted)

## Testing

```bash
npm test              # Unit tests (helpers + DB, 70 tests)
npm run test:helpers  # Helper function tests only
npm run test:db       # Database operation tests only
npm run test:endpoints # Integration tests (requires running server)
npm run build         # Type check + build

# Manual endpoint tests
curl http://localhost:3000/api/health
curl http://localhost:3000/api/v1/models
curl -H "Authorization: Bearer $KEY" http://localhost:3000/api/v1/backends
```

## Key Directories

- `app/(dashboard)/` — Dashboard pages (playground, runs, keys, settings, skills)
- `app/api/v1/` — External API routes
- `app/api/` — Dashboard management routes (keys, settings, skills, mcp)
- `lib/oc/` — Engine modules (config, state, queue, backends, streaming, etc.)
- `lib/oc/backends/` — Execution backends (local, sprite, vercel, cloudflare)
- `lib/oc/skill-loader.ts` — Shared skill resolution (filter + preload) for all routes
- `lib/` — Shared utilities (db, auth, utils)
- `components/` — UI components (shadcn/ui)
- `public/` — Static assets (openapi.json)
