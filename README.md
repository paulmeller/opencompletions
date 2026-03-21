# OpenCompletions

A lightweight, zero-dependency server that wraps AI coding CLIs as a completions API, exposing OpenAI-compatible, Anthropic-compatible, and multi-turn Agent endpoints with SSE streaming support.

Supports two CLI backends:
- **Claude Code** (`--cli claude`, default) — Anthropic's coding agent
- **OpenCode** (`--cli opencode`) — provider-agnostic agent supporting Anthropic, OpenAI, Google, Groq, and more

Supports three execution backends:
- **Local** — spawns the CLI as a subprocess on your machine
- **Sprite** — delegates execution to one or more [Sprites.dev](https://sprites.dev) VMs
- **Vercel** — delegates execution to [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) microVMs

Auth tokens flow per-request via the `x-api-key` header — no server-side secrets needed for LLM credentials.

## Prerequisites

- Node.js 22+
- **Local mode:** Claude Code CLI installed and authenticated
- **Sprite mode:** A Sprites.dev account with Claude Code installed on your Sprite(s)
- **Vercel mode:** A Vercel account with a snapshot containing Claude Code

## Quick Start

### Local mode

```bash
node server.js
```

### Sprite mode

```bash
node server.js \
  --backend sprite \
  --sprite-token "$SPRITE_TOKEN" \
  --sprite-name my-claude-sprite
```

### Vercel mode

```bash
node server.js \
  --backend vercel \
  --vercel-token "$VERCEL_TOKEN" \
  --vercel-team-id "$VERCEL_TEAM_ID" \
  --vercel-project-id "$VERCEL_PROJECT_ID" \
  --vercel-snapshot-id "$VERCEL_SNAPSHOT_ID"
```

### OpenCode mode

```bash
node server.js --cli opencode --api-key mysecret
```

### With authentication

```bash
node server.js --api-key "my-secret-key" ...
```

All endpoints will require `Authorization: Bearer my-secret-key`.

### Per-request LLM auth

Pass your Anthropic (or other provider) token via the `x-api-key` header. The server forwards it to the CLI backend:

```bash
curl http://localhost:3456/v1/chat/completions \
  -H "Authorization: Bearer my-secret-key" \
  -H "x-api-key: sk-ant-oat01-YOUR-TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello!"}]}'
```

`Authorization: Bearer` authenticates to the server. `x-api-key` is forwarded to the CLI for LLM auth. This works with all backends including sprites and Vercel sandboxes — no need to configure tokens on the server.

## Options

| Flag                | Default                        | Description                              |
|---------------------|--------------------------------|------------------------------------------|
| `--cli`             | `claude`                       | CLI backend: `claude` or `opencode`      |
| `--port`            | 3456                           | Port to listen on                        |
| `--concurrency`     | 3                              | Max simultaneous requests                |
| `--timeout`         | 120000                         | Per-request timeout in ms                |
| `--queue-depth`     | 100                            | Max queued requests before 503           |
| `--api-key`         | `$API_KEY`                     | Bearer token for all endpoints           |
| `--backend`         | local                          | `local`, `sprite`, or `vercel`           |
| `--anthropic-api-key`| `$ANTHROPIC_API_KEY`          | Anthropic API key (server-side fallback) |
| `--claude-token`    | `$CLAUDE_CODE_OAUTH_TOKEN`     | Claude OAuth token (server-side fallback)|
| `--sprite-token`    | `$SPRITE_TOKEN`               | Sprites.dev auth token                   |
| `--sprite-name`     | *(required for sprite mode)*   | Sprite name (repeat for pool)            |
| `--sprite-api`      | `https://api.sprites.dev`      | Sprites API base URL                     |
| `--vercel-token`    | `$VERCEL_TOKEN`                | Vercel API token                         |
| `--vercel-team-id`  | `$VERCEL_TEAM_ID`              | Vercel team ID                           |
| `--vercel-project-id`| `$VERCEL_PROJECT_ID`          | Vercel project ID                        |
| `--vercel-snapshot-id`| *(required for vercel mode)*  | Snapshot with Claude Code installed      |
| `--agent-max-turns`  | 10                             | Default max turns for agent requests     |
| `--agent-timeout`    | 600000                         | Agent timeout in ms (default 10 min)     |
| `--agent-mcp-config` | *(none)*                       | Operator-default MCP config JSON         |

## OpenCode Mode

The `--cli opencode` flag switches the CLI backend from Claude Code to [OpenCode](https://github.com/anomalyco/opencode), a provider-agnostic AI coding agent that supports Anthropic, OpenAI, Google, Groq, and more.

**Requirements:**
- OpenCode only works with `--backend local`. The sprite and vercel backends are Claude-only.

**Behavioral differences when using `--cli opencode`:**
- **Unsupported agent features** — `allowed_tools`, `disallowed_tools`, `max_budget_usd`, and `mcp_servers` return `400` errors.
- **`max_turns`** — Logged as a warning but allowed (OpenCode does not support it natively).
- **System prompts** — Prepended to the user prompt, since OpenCode has no `--system-prompt` flag.
- **Session resume** — Uses OpenCode's `--session` flag (equivalent to Claude's `--resume`).

## Endpoints

### OpenAI-Compatible

**POST /v1/chat/completions**

```bash
curl http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "claude-code",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "What is 2+2?"}
    ]
  }'
```

**POST /v1/chat/completions (streaming)**

```bash
curl -N http://localhost:3456/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "claude-code",
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

**POST /v1/completions**

```bash
curl http://localhost:3456/v1/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "claude-code",
    "prompt": "Explain quantum computing in one sentence."
  }'
```

**POST /v1/completions (fill-in-the-middle)**

```bash
curl http://localhost:3456/v1/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "claude-code",
    "prompt": "function add(a, b) {",
    "suffix": "}\nconsole.log(add(1, 2));"
  }'
```

**POST /v1/responses** (OpenAI Responses API)

```bash
curl http://localhost:3456/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "claude-code",
    "input": "What is 2+2?",
    "instructions": "Be concise."
  }'
```

**POST /v1/embeddings** (stub — hash-based, not semantic)

```bash
curl http://localhost:3456/v1/embeddings \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "claude-code",
    "input": "Hello world"
  }'
```

**GET /v1/models**

```bash
curl http://localhost:3456/v1/models \
  -H "Authorization: Bearer $API_KEY"
```

> All `/v1/` routes also work without the prefix (e.g., `/chat/completions`, `/embeddings`).

### Anthropic-Compatible

**POST /v1/messages**

```bash
curl http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "claude-code",
    "system": "You are a helpful assistant.",
    "messages": [{"role": "user", "content": "What is 2+2?"}]
  }'
```

**POST /v1/messages (streaming)**

```bash
curl -N http://localhost:3456/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "claude-code",
    "stream": true,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

**GET /v1/models/:id**

```bash
curl http://localhost:3456/v1/models/claude-code \
  -H "Authorization: Bearer $API_KEY"
```

**POST /v1/messages/count_tokens**

```bash
curl http://localhost:3456/v1/messages/count_tokens \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "model": "claude-code",
    "messages": [{"role": "user", "content": "What is 2+2?"}]
  }'
```

### Agent API

**POST /v1/agent** — Multi-turn agent with tool use (streaming by default)

```bash
curl -N http://localhost:3456/v1/agent \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "prompt": "Read server.js and list all HTTP endpoints",
    "max_turns": 5,
    "allowed_tools": ["Read", "Glob", "Grep"]
  }'
```

Response is SSE with events: `system` (init), `assistant`, `user` (tool results), `result`, `done`.

**Session resume:**

```bash
curl -N http://localhost:3456/v1/agent \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "prompt": "Now refactor the auth middleware",
    "session_id": "<session_id from previous response>"
  }'
```

**Non-streaming:**

```bash
curl http://localhost:3456/v1/agent \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "prompt": "What files are in this directory?",
    "stream": false,
    "max_turns": 3
  }'
```

**With MCP servers:**

```bash
curl -N http://localhost:3456/v1/agent \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "prompt": "Check recent Sentry errors for the auth service",
    "mcp_servers": {
      "sentry": {
        "type": "http",
        "url": "https://mcp.sentry.dev/mcp",
        "headers": { "Authorization": "Bearer sentry-token" }
      }
    }
  }'
```

**Request fields:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `prompt` | string | *(required)* | The task for the agent |
| `system_prompt` | string | null | System prompt |
| `session_id` | string | null | Resume a previous session |
| `max_turns` | number | 10 | Max agent turns |
| `max_budget_usd` | number | null | Cost cap in USD |
| `allowed_tools` | string[] | null | Whitelist of tools |
| `disallowed_tools` | string[] | null | Blacklist of tools |
| `model` | string | null | Override model |
| `cwd` | string | null | Working directory (local backend) |
| `stream` | boolean | true | SSE streaming vs buffered JSON |
| `include_partial_messages` | boolean | false | Include partial message events |
| `mcp_servers` | object | null | Per-request MCP server config |
| `timeout_ms` | number | 600000 | Per-request timeout override |

### Utility

| Endpoint           | Description                    |
|--------------------|--------------------------------|
| `GET /`            | Health check + server info     |
| `GET /openapi.json`| OpenAPI 3.1 specification      |
| `GET /docs`        | Interactive API docs (Scalar)  |
| `GET /v1/status`   | Queue depth + worker status    |

## Using with SDKs

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3456/v1",
    api_key="my-secret-key",
)

response = client.chat.completions.create(
    model="claude-code",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

### Python (Anthropic SDK)

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://localhost:3456",
    api_key="my-secret-key",
)

response = client.messages.create(
    model="claude-code",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.content[0].text)
```

### Agent API (Python)

```python
import requests
import json

url = "http://localhost:3456/v1/agent"
headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer my-secret-key",
}

# Streaming
response = requests.post(url, headers=headers, json={
    "prompt": "Read server.js and list all endpoints",
    "max_turns": 5,
    "allowed_tools": ["Read", "Glob", "Grep"],
}, stream=True)

for line in response.iter_lines():
    line = line.decode()
    if line.startswith("data: "):
        data = line[6:]
        if data == "[DONE]":
            break
        event = json.loads(data)
        print(f"[{event['type']}]", end=" ")
        if event["type"] == "result":
            print(event["result"])

# Non-streaming
response = requests.post(url, headers=headers, json={
    "prompt": "What files are here?",
    "stream": False,
    "max_turns": 3,
})
data = response.json()
print(data["result"])
print(f"Cost: ${data['total_cost_usd']:.4f}, Turns: {data['num_turns']}")
```

### Any OpenAI-compatible tool

```bash
export OPENAI_API_BASE=http://localhost:3456/v1
export OPENAI_API_KEY=my-secret-key
```

## Running with Docker

```bash
docker build -t opencompletions .

docker run -p 3456:3456 opencompletions \
  --backend sprite \
  --sprite-token "$SPRITE_TOKEN" \
  --sprite-name my-sprite \
  --api-key "$API_KEY"
```

## Running with Apple Containers

Requires Apple silicon and macOS 26+. Install via `brew install container`.

```bash
# Start the container service (once)
container system start

# Build
container build -t opencompletions .

# Run
container run -p 3456:3456 opencompletions \
  --backend sprite \
  --sprite-token "$SPRITE_TOKEN" \
  --sprite-name my-sprite \
  --api-key "$API_KEY"

# Run detached
container run -d --name claude-api -p 3456:3456 opencompletions \
  --backend sprite \
  --sprite-token "$SPRITE_TOKEN" \
  --sprite-name my-sprite \
  --api-key "$API_KEY"

# View logs / stop
container logs claude-api
container stop claude-api
```

You can also pass secrets via `--env-file`:

```bash
echo 'SPRITE_TOKEN=...' > .env
echo 'API_KEY=...' >> .env

container run -p 3456:3456 --env-file .env opencompletions \
  --backend sprite --sprite-name my-sprite
```

## Setting Up Sprites

### 1. Create a Sprite with Claude Code

```bash
# Install the Sprites CLI
curl https://sprites.dev/install.sh | bash
sprite login

# Create a sprite and install Claude Code
sprite create claude-worker-1
sprite exec -s claude-worker-1 -- npm install -g @anthropic-ai/claude-code

# Checkpoint so you don't have to reinstall
sprite checkpoint create -s claude-worker-1 -comment "Claude Code installed"
```

### 2. Create a worker pool

```bash
for i in 1 2 3; do
  sprite create claude-worker-$i
  sprite exec -s claude-worker-$i -- npm install -g @anthropic-ai/claude-code
  sprite checkpoint create -s claude-worker-$i -comment "Claude Code installed"
done
```

### 3. Run the server

```bash
node server.js \
  --backend sprite \
  --sprite-token "$SPRITE_TOKEN" \
  --sprite-name claude-worker-1 \
  --sprite-name claude-worker-2 \
  --sprite-name claude-worker-3 \
  --concurrency 3
```

## Setting Up Vercel Sandboxes

### 1. Create a snapshot with Claude Code

```bash
# Create a sandbox, install Claude Code, and snapshot it
npx sandbox create                                          # note the sandbox ID
npx sandbox exec <SANDBOX_ID> -- npm install -g @anthropic-ai/claude-code
npx sandbox snapshot <SANDBOX_ID> --stop                    # note the snapshot ID
```

### 2. Run the server

```bash
node server.js \
  --backend vercel \
  --vercel-token "$VERCEL_TOKEN" \
  --vercel-team-id "$VERCEL_TEAM_ID" \
  --vercel-project-id "$VERCEL_PROJECT_ID" \
  --vercel-snapshot-id "$SNAPSHOT_ID" \
  --concurrency 2
```

The server creates sandboxes from the snapshot on startup and stops them on shutdown. Auth tokens flow per-request via `x-api-key`.

## Architecture

```
                    ┌─────────────────────┐
                    │   Your app / tool    │
                    │  (OpenAI or Claude   │
                    │   SDK compatible)    │
                    └─────────┬───────────┘
                              │
                    ┌─────────▼───────────┐
                    │   Completions API    │
                    │   (this server)      │
                    │                      │
                    │  ┌──────────────┐    │
                    │  │ Request Queue│    │
                    │  └──────┬───────┘    │
                    └─────────┼────────────┘
                              │
              ┌───────────────┼───────────────┐
              │               │               │
     ┌────────▼──────┐ ┌─────▼───────┐ ┌─────▼───────┐
     │ Local / Sprite │ │ Local / Sprite│ │ Local / Sprite│
     │ / Vercel       │ │ / Vercel      │ │ / Vercel      │
     │ claude -p      │ │ claude -p     │ │ claude -p     │
     │ --max-turns 1  │ │ --max-turns 1 │ │ --max-turns 1 │
     │ (completions)  │ │ (completions) │ │ (completions) │
     │ --max-turns N  │ │ --max-turns N │ │ --max-turns N │
     │ (agent)        │ │ (agent)       │ │ (agent)       │
     └───────────────┘ └──────────────┘ └──────────────┘
```

## Limitations

- **Completions endpoints are single turn only** — multi-turn conversations are flattened into a single prompt string. Prior assistant responses lose their role context. Works well for single-turn use but degrades with long conversations. Use the Agent API (`POST /v1/agent`) for multi-turn interactions with tool use.
- **No token counting** — usage fields are always 0
- **Streaming granularity** — Sprite backend may deliver the full response as a single SSE chunk (HTTP POST buffering). Vercel and local backends stream incrementally.
- **Local mode:** ~200-500ms process spawn overhead per request
- **Sprite mode:** additional network latency; sprites may need to wake from cold sleep (~5-15s) on first request
- **Vercel mode:** sandboxes have a 5-minute default timeout; the server auto-replaces dead sandboxes
- **OpenCode mode:** local backend only; no support for `allowed_tools`, `disallowed_tools`, `max_budget_usd`, or `mcp_servers`; `max_turns` is accepted but not enforced
