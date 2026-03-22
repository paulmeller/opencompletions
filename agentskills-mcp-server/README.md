# agentskills-mcp-server

A bridge between Agent Skills and the Model Context Protocol.

Exposes any Agent Skills registry as a set of MCP tools and resources. Any MCP-compatible client — Claude Code, Cursor, VS Code Copilot, Cline, or your own agent — can discover, activate, and execute skills over the wire without bundling them locally.

## What it does

- Serves skill metadata (name + description) as MCP resources so clients see what's available at connection time
- Exposes `list_skills`, `activate_skill`, and `read_resource` as MCP tools for progressive disclosure
- Supports any registered SkillProvider — local filesystem, HTTP/CDN, S3, or custom backends
- Handles resource retrieval and streams content back as tool responses

## Quick start

```bash
# Install dependencies
cd agentskills-mcp-server && npm install

# Serve skills from a local directory
node src/cli.js serve --provider fs --path ./examples/my-skills

# Connect from Claude Code
claude mcp add skills-server -- node src/cli.js serve --provider fs --path ./my-skills
```

## Architecture

```
Agent (any MCP client)
├── connects to ──▶  agentskills-mcp-server
│                    │
│                    ├── SkillRegistry
│                    │     ├── LocalFileSystemProvider
│                    │     ├── HttpProvider (S3, CDN, GitHub Pages)
│                    │     └── CustomProvider (extend SkillProvider)
│                    │
│  ◀── skill catalog ┤  (lightweight metadata at connection time)
│                    │
│  ── activate_skill ▶ │  (full SKILL.md content on demand)
│                    │
│  ── read_resource ─▶ │  (references, templates, scripts)
│                    │
│  ◀── tool response ──┘  (content returned to agent)
```

## Skill directory layout

```
my-skills/
├── deploy/
│   ├── SKILL.md          # Required — first non-heading line is the description
│   └── resources/        # Optional
│       ├── template.yaml
│       └── script.sh
└── review/
    └── SKILL.md
```

## Providers

### Local filesystem (`--provider fs`)
Reads skills from a local directory. Good for development and single-developer setups.

### HTTP (`--provider http`)
Fetches skills from a remote endpoint. Expects:
- `GET {base-url}/index.json` — skill catalog
- `GET {base-url}/{name}/SKILL.md` — skill content
- `GET {base-url}/{name}/resources.json` — optional resource index

### Custom providers
Extend the `SkillProvider` base class:

```js
import { SkillProvider } from 'agentskills-mcp-server';

class DatabaseProvider extends SkillProvider {
  async listSkills() { /* ... */ }
  async getSkill(name) { /* ... */ }
  async getResource(skillName, resourceUri) { /* ... */ }
}
```

## Testing

```bash
npm test
```

## API

### Programmatic usage

```js
import { SkillRegistry, LocalFileSystemProvider, createServer } from 'agentskills-mcp-server';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const registry = new SkillRegistry();
registry.addProvider(new LocalFileSystemProvider('./my-skills'));

const server = createServer(registry);
const transport = new StdioServerTransport();
await server.connect(transport);
```
