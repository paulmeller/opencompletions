# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

OpenCompletions is a zero-dependency Node.js server that wraps CLI coding agents (Claude Code or OpenCode) as a completions API. It exposes OpenAI-compatible, Anthropic-compatible, and multi-turn Agent endpoints with SSE streaming.

## Running

```bash
# Local backend (default)
node server.js

# With skills MCP server
node server.js --skills-path skills

# Sprite backend (remote VM)
node server.js --backend sprite --sprite-token $SPRITE_TOKEN --sprite-name my-sprite

# Vercel Sandbox backend (needs PAT, snapshot with Claude pre-installed)
node server.js --backend vercel --vercel-token $VERCEL_TOKEN --vercel-team-id $TEAM_ID \
  --vercel-project-id $PROJECT_ID --vercel-snapshot-id $SNAPSHOT_ID

# Common flags
node server.js --port 3456 --concurrency 3 --timeout 120000 --api-key mysecret
```

## Testing

No test framework — tests are standalone Node.js scripts using `assert`.

```bash
# Tier 1: File CRUD (no CLI needed, fast, deterministic)
node test/test-file-endpoints.js

# Tier 2: Full agent workflow (requires claude CLI + API key)
node test/test-file-agent-workflow.js

# Tier 2 on remote backends (reads tokens from .env)
TEST_BACKEND=sprite node test/test-file-agent-workflow.js
TEST_BACKEND=vercel node test/test-file-agent-workflow.js
```

Tests auto-detect `claude` CLI availability and skip gracefully if missing. Each test spawns its own server on a random port. The Tier 2 test loads credentials from `.env` automatically and prints real-time SSE events (`[system]`, `[assistant]`, `[tool_use]`, `[tool_result]`, `[result]`, `[done]`) as the agent works.

For local backend, the test uses the built-in Streamable HTTP MCP server for skill-based analysis. For remote backends (sprite/vercel), MCP is skipped (localhost unreachable) and the agent analyzes the contract directly.

## Architecture

### Three Files, No Framework

| File | Purpose |
|------|---------|
| `server.js` (~3200 lines) | HTTP server, all endpoints, CLI providers, three backend implementations |
| `files.js` (~720 lines) | Workspace file management — CRUD across local/sprite/vercel backends |
| `skills.js` (~270 lines) | Agent skills loaded from `skills/` dir, exposed as MCP tools |

### Three Execution Backends

All selected via `--backend` flag. Each implements `runClaude*()` (single-turn) and `runAgent*()` (multi-turn):

- **local** — spawns CLI as subprocess. Default. No extra config.
- **sprite** — delegates to Sprites.dev VMs via REST API. Requires `--sprite-token` + `--sprite-name`. Supports pool of multiple sprites with session affinity and workspace binding. Token can be found via `sprite api '/v1/sprites' -- -v` (look for Authorization header).
- **vercel** — delegates to Vercel Sandbox microVMs. Requires `--vercel-token` (PAT from vercel.com/account/tokens) + `--vercel-team-id` + `--vercel-project-id`. Needs `--vercel-snapshot-id` with Claude CLI pre-installed. Auto-creates sandbox pool on startup, replaces dead instances. Use `npx sandbox` CLI to manage snapshots.

### Two CLI Providers

Selected via `--cli` flag:

- **claude** (default) — Claude Code CLI. Prompt via stdin, MCP via `--mcp-config` flag, output as NDJSON.
- **opencode** — OpenCode CLI. Local backend only. Prompt as argument, MCP via `OPENCODE_CONFIG_CONTENT` env var.

### Request Flow

```
HTTP request → auth check → enqueue() → drain() → backend-specific execFn → response
```

Concurrency managed by a simple queue (`MAX_CONCURRENCY` default 3, `MAX_QUEUE_DEPTH` default 100).

### Authentication (Three Layers)

1. **Server auth** (`--api-key`): Optional Bearer token protecting all endpoints.
2. **Per-request LLM auth** (`x-api-key` header): Forwarded to CLI. Tokens starting with `sk-ant-oat` route to `CLAUDE_CODE_OAUTH_TOKEN`, others to `ANTHROPIC_API_KEY`.
3. **Server-side fallback** (`--anthropic-api-key` or `--claude-token`): Used when client doesn't provide `x-api-key`.

### Workspace System (files.js)

Workspaces are isolated temp directories with state machine: `created → running → completed | error`.

- **Local**: files in `$TMPDIR/oc-ws-<id>/`
- **Sprite**: files at `/home/sprite/ws-<id>/` on the sprite VM, with `.manifest.json` for existence checks
- **Vercel**: files at `/vercel/sandbox/ws-<id>/`, transferred via tar.gz

File manifest is auto-injected into the agent's system prompt so it knows what files are available.

### MCP Server (built-in)

`POST /mcp` serves a Streamable HTTP MCP server (JSON-RPC 2.0) with session management. Built-in tools: `echo`, `random_number`, `server_status`. When `--skills-path` is set, adds: `list_skills`, `activate_skill`, `read_resource`, `run_script`.

### Skills System (skills.js)

Skills are directories under `skills/` with a `SKILL.md` (YAML frontmatter + markdown body), optional `references/` and `scripts/` subdirs. Loaded at startup via `--skills-path` flag. Exposed as MCP tools that agents can discover and use at runtime.

## Key Endpoints

- `POST /v1/chat/completions` — OpenAI chat (streaming/buffered)
- `POST /v1/completions` — OpenAI legacy (with FIM support)
- `POST /v1/messages` — Anthropic messages
- `POST /v1/agent` — Multi-turn agent (SSE streaming, workspace binding, per-request MCP)
- `POST /v1/files/upload` — Upload to workspace (`X-Filename` header, `X-Workspace-Id` optional)
- `GET /v1/files/:id` — List workspace files
- `GET /v1/files/:id/:filename` — Download file
- `POST /mcp` — Built-in MCP server

## Environment & Credentials

Tokens are stored in `.env` (gitignored). The test harness loads `.env` automatically. Key variables:

- `SPRITE_TOKEN` / `SPRITE_NAME` — Sprite backend auth (primary sprite: `claude-completions`)
- `VERCEL_TOKEN` / `VERCEL_TEAM_ID` / `VERCEL_PROJECT_ID` / `VERCEL_SNAPSHOT_ID` — Vercel backend auth
- `CLAUDE_CODE_OAUTH_TOKEN` — OAuth token forwarded to remote CLIs (required for sprite/vercel)
- `ANTHROPIC_API_KEY` — API key forwarded to remote CLIs (alternative to OAuth)
- `API_KEY` — Server-level auth
- `TEST_BACKEND` — Set to `sprite` or `vercel` to run Tier 2 test on remote backends

## Known Quirks

- **Sprites API doesn't support HEAD** on `/fs/read` — `spriteWorkspaceExists()` in files.js uses GET instead and drains the body.
- **Vercel API returns stdout via `/logs` streaming**, not inline in the command response — `vercelListDir()` in files.js streams from `/cmd/{id}/logs` and parses NDJSON `{stream:"stdout", data:"..."}` events.
- **Vercel CLI session tokens** (`vca_*` from `~/Library/Application Support/com.vercel.cli/auth.json`) don't work with the REST API — need a PAT from vercel.com/account/tokens (starts with `vcp_`).
- **File upload stores as JSON Buffer** on remote backends — the contract file appears as `{"type":"Buffer","data":[...]}` and agents need to decode it.
- **MCP skills unreachable from remote backends** — the `/mcp` endpoint is localhost-only. Remote backends (sprite/vercel) can't reach it unless deployed to a public URL (e.g. `api.opencompletions.com`).
- **Vercel sandboxes need Claude pre-installed** — create a sandbox, install Claude, then `npx sandbox snapshot <id>`. Current snapshot: `snap_zIgzSdHIKt1w8OP8R2OtwPk625jf`.
- **No build step, no linter, no test framework** — everything is plain Node.js with zero external deps.
