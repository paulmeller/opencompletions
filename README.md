# OpenCompletions

A lightweight, zero-dependency server that wraps `claude -p --max-turns 1` as a local completions API, exposing both OpenAI-compatible and Anthropic-compatible endpoints with SSE streaming support.

Supports three backends:
- **Local** — spawns `claude` as a subprocess on your machine
- **Sprite** — delegates execution to one or more [Sprites.dev](https://sprites.dev) VMs
- **Vercel** — delegates execution to [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) microVMs

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
  --sprite-token "$SPRITES_TOKEN" \
  --sprite-name my-claude-sprite \
  --claude-token "$CLAUDE_CODE_OAUTH_TOKEN"
```

### Vercel mode

```bash
node server.js \
  --backend vercel \
  --vercel-token "$VERCEL_TOKEN" \
  --vercel-team-id "$VERCEL_TEAM_ID" \
  --vercel-snapshot-id "$VERCEL_SNAPSHOT_ID" \
  --claude-token "$CLAUDE_CODE_OAUTH_TOKEN"
```

### With authentication

```bash
node server.js --api-key "my-secret-key" ...
```

All endpoints will require `Authorization: Bearer my-secret-key`.

## Options

| Flag                | Default                        | Description                              |
|---------------------|--------------------------------|------------------------------------------|
| `--port`            | 3456                           | Port to listen on                        |
| `--concurrency`     | 3                              | Max simultaneous requests                |
| `--timeout`         | 120000                         | Per-request timeout in ms                |
| `--queue-depth`     | 100                            | Max queued requests before 503           |
| `--api-key`         | `$API_KEY`                     | Bearer token for all endpoints           |
| `--backend`         | local                          | `local`, `sprite`, or `vercel`           |
| `--claude-token`    | `$CLAUDE_CODE_OAUTH_TOKEN`     | Claude Code OAuth token                  |
| `--sprite-token`    | `$SPRITES_TOKEN`               | Sprites.dev auth token                   |
| `--sprite-name`     | *(required for sprite mode)*   | Sprite name (repeat for pool)            |
| `--sprite-api`      | `https://api.sprites.dev`      | Sprites API base URL                     |
| `--vercel-token`    | `$VERCEL_TOKEN`                | Vercel API token                         |
| `--vercel-team-id`  | `$VERCEL_TEAM_ID`              | Vercel team ID                           |
| `--vercel-project-id`| `$VERCEL_PROJECT_ID`          | Vercel project ID                        |
| `--vercel-snapshot-id`| *(required for vercel mode)*  | Snapshot with Claude Code installed      |

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

**GET /v1/models**

```bash
curl http://localhost:3456/v1/models \
  -H "Authorization: Bearer $API_KEY"
```

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

### Utility

| Endpoint        | Description                    |
|-----------------|--------------------------------|
| `GET /`         | Health check + server info     |
| `GET /v1/status`| Queue depth + worker status    |

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
  --sprite-token "$SPRITES_TOKEN" \
  --sprite-name my-sprite \
  --claude-token "$CLAUDE_CODE_OAUTH_TOKEN" \
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
  --sprite-token "$SPRITES_TOKEN" \
  --sprite-name my-sprite \
  --claude-token "$CLAUDE_CODE_OAUTH_TOKEN" \
  --api-key "$API_KEY"

# Run detached
container run -d --name claude-api -p 3456:3456 opencompletions \
  --backend sprite \
  --sprite-token "$SPRITES_TOKEN" \
  --sprite-name my-sprite \
  --claude-token "$CLAUDE_CODE_OAUTH_TOKEN" \
  --api-key "$API_KEY"

# View logs / stop
container logs claude-api
container stop claude-api
```

You can also pass secrets via `--env-file`:

```bash
echo 'SPRITES_TOKEN=...' > .env
echo 'CLAUDE_CODE_OAUTH_TOKEN=...' >> .env
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
  --sprite-token "$SPRITES_TOKEN" \
  --sprite-name claude-worker-1 \
  --sprite-name claude-worker-2 \
  --sprite-name claude-worker-3 \
  --claude-token "$CLAUDE_CODE_OAUTH_TOKEN" \
  --concurrency 3
```

## Setting Up Vercel Sandboxes

### 1. Create a project and snapshot

```bash
# Install Vercel CLI
npm install -g vercel
vercel login

# Create a project for sandboxes
curl -s -X POST "https://api.vercel.com/v10/projects?teamId=$VERCEL_TEAM_ID" \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"claude-sandboxes"}'

# Create a sandbox, install Claude Code, and snapshot it
SANDBOX_ID=$(curl -s -X POST "https://api.vercel.com/v1/sandboxes?teamId=$VERCEL_TEAM_ID" \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"runtime\":\"node24\",\"projectId\":\"$VERCEL_PROJECT_ID\"}" | jq -r '.sandbox.id')

curl -s -X POST "https://api.vercel.com/v1/sandboxes/$SANDBOX_ID/cmd?teamId=$VERCEL_TEAM_ID" \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"command":"npm","args":["install","-g","@anthropic-ai/claude-code"],"sudo":true,"wait":true}'

SNAPSHOT_ID=$(curl -s -X POST "https://api.vercel.com/v1/sandboxes/$SANDBOX_ID/snapshot?teamId=$VERCEL_TEAM_ID" \
  -H "Authorization: Bearer $VERCEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}' | jq -r '.snapshot.id')

echo "Snapshot: $SNAPSHOT_ID"
```

### 2. Run the server

```bash
node server.js \
  --backend vercel \
  --vercel-token "$VERCEL_TOKEN" \
  --vercel-team-id "$VERCEL_TEAM_ID" \
  --vercel-project-id "$VERCEL_PROJECT_ID" \
  --vercel-snapshot-id "$SNAPSHOT_ID" \
  --claude-token "$CLAUDE_CODE_OAUTH_TOKEN" \
  --concurrency 2
```

The server creates sandboxes from the snapshot on startup and stops them on shutdown.

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
     └───────────────┘ └──────────────┘ └──────────────┘
```

## Limitations

- **Single turn only** — multi-turn conversations are flattened into a single prompt string. Prior assistant responses lose their role context. Works well for single-turn use but degrades with long conversations.
- **No token counting** — usage fields are always 0
- **Streaming granularity** — Sprite backend may deliver the full response as a single SSE chunk (HTTP POST buffering). Vercel and local backends stream incrementally.
- **Local mode:** ~200-500ms process spawn overhead per request
- **Sprite mode:** additional network latency; sprites may need to wake from cold sleep (~5-15s) on first request
- **Vercel mode:** sandboxes have a 5-minute default timeout; the server auto-replaces dead sandboxes
