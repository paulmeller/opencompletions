#!/usr/bin/env node

/**
 * CLI entry point for agentskills-mcp-server.
 *
 * Usage:
 *   agentskills-mcp serve --provider fs --path ./my-skills
 *   agentskills-mcp serve --provider http --base-url https://skills.example.com
 */

import { parseArgs } from 'node:util';
import { SkillRegistry } from './registry.js';
import { LocalFileSystemProvider } from './providers/filesystem.js';
import { HttpProvider } from './providers/http.js';
import { createServer } from './server.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

function printUsage() {
  console.error(`Usage: agentskills-mcp serve [options]

Options:
  --provider <fs|http>   Skill provider type (required)
  --path <dir>           Path to skills directory (required for 'fs')
  --base-url <url>       Base URL for skills (required for 'http')
  --help                 Show this help message`);
}

async function main() {
  const args = process.argv.slice(2);

  // First positional arg should be the command
  const command = args[0];
  if (!command || command === '--help' || command === '-h') {
    printUsage();
    process.exit(command ? 0 : 1);
  }

  if (command !== 'serve') {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }

  const { values } = parseArgs({
    args: args.slice(1),
    options: {
      provider: { type: 'string' },
      path: { type: 'string' },
      'base-url': { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: true,
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  if (!values.provider) {
    console.error('Error: --provider is required');
    printUsage();
    process.exit(1);
  }

  const registry = new SkillRegistry();

  if (values.provider === 'fs') {
    if (!values.path) {
      console.error('Error: --path is required for the fs provider');
      process.exit(1);
    }
    registry.addProvider(new LocalFileSystemProvider(values.path));
  } else if (values.provider === 'http') {
    if (!values['base-url']) {
      console.error('Error: --base-url is required for the http provider');
      process.exit(1);
    }
    registry.addProvider(new HttpProvider(values['base-url']));
  } else {
    console.error(`Error: Unknown provider: ${values.provider}`);
    process.exit(1);
  }

  const server = createServer(registry);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('agentskills-mcp-server running on stdio');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
