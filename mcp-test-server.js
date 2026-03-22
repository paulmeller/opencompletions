#!/usr/bin/env node
// A minimal MCP (Model Context Protocol) server over stdio for testing.
// Exposes two tools: "echo" and "random_number".

const readline = require("readline");

const SERVER_INFO = {
  name: "test-mcp",
  version: "0.1.0",
};

const TOOLS = [
  {
    name: "echo",
    description: "Echoes back the provided message. Useful for testing.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "The message to echo back" },
      },
      required: ["message"],
    },
  },
  {
    name: "random_number",
    description: "Returns a random number between min and max (inclusive).",
    inputSchema: {
      type: "object",
      properties: {
        min: { type: "number", description: "Minimum value (default 1)" },
        max: { type: "number", description: "Maximum value (default 100)" },
      },
    },
  },
];

function handleRequest(msg) {
  const { method, params, id } = msg;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      };

    case "notifications/initialized":
      return null; // no response for notifications

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

    case "tools/call": {
      const toolName = params?.name;
      const args = params?.arguments || {};

      if (toolName === "echo") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: args.message || "(empty)" }],
          },
        };
      }

      if (toolName === "random_number") {
        const min = args.min ?? 1;
        const max = args.max ?? 100;
        const value = Math.floor(Math.random() * (max - min + 1)) + min;
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: String(value) }],
          },
        };
      }

      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown tool: ${toolName}` },
      };
    }

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// --- stdio transport ---
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    const response = handleRequest(msg);
    if (response) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  } catch (err) {
    const errResponse = {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    };
    process.stdout.write(JSON.stringify(errResponse) + "\n");
  }
});

process.stderr.write("test-mcp server started (stdio)\n");
