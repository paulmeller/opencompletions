# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a Replit environment configured specifically for running Claude Code. It's a minimal Node.js setup designed to provide a workspace for Claude Code interactions.

## Environment Configuration

**Important**: This repository uses a custom Claude configuration directory:
- Claude configuration is stored in `/home/runner/workspace/.claude-user`
- The `CLAUDE_CONFIG_DIR` environment variable should be set to `/home/runner/workspace/.claude-user`
- The `.claude-user` directory contains sensitive credentials and should NEVER be shared or committed

## Key Dependencies

- `@anthropic-ai/claude-code`: The Claude Code CLI package (v2.0.76+)
- `@types/node`: TypeScript definitions for Node.js

## Replit-Specific Configuration

This project runs on Replit with the following setup:
- **Runtime**: Node.js 22
- **Entry point**: `index.js` (currently non-existent - this is a template)

## Development Workflow

Since this is primarily a template/sandbox environment for Claude Code:

1. **No build process**: There's no build step configured
2. **No test suite**: No test framework is set up
3. **No linting**: No linting tools are configured

When developing actual code in this environment, you'll likely need to:
- Add appropriate scripts to `package.json` for your specific use case
- Install additional dependencies as needed
- Configure testing and linting tools based on your project requirements

## Git Configuration

This repository is **not** currently initialized as a Git repository. If version control is needed, initialize it with `git init`.
