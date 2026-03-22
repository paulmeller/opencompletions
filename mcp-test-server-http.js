#!/usr/bin/env node
// A minimal MCP server using Streamable HTTP transport for testing.
// Exposes two tools: "echo" and "random_number".

const http = require("http");

const PORT = parseInt(process.argv[2] || "8808", 10);

const SERVER_INFO = {
  name: "test-mcp-http",
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

// Track sessions
const sessions = new Map();

function handleJsonRpc(msg) {
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
      return null;

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

function generateSessionId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id");
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Only accept POST on /mcp
  if (req.url !== "/mcp") {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
    return;
  }

  if (req.method === "GET") {
    // SSE endpoint for server-initiated messages (not used in this simple server)
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "SSE not supported on this server" }));
    return;
  }

  if (req.method === "DELETE") {
    // Session termination
    const sessionId = req.headers["mcp-session-id"];
    if (sessionId) sessions.delete(sessionId);
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  // Collect body
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        })
      );
      return;
    }

    // Handle batch requests
    const isBatch = Array.isArray(msg);
    const messages = isBatch ? msg : [msg];
    const responses = [];

    // Assign or validate session
    let sessionId = req.headers["mcp-session-id"];
    const isInit = messages.some((m) => m.method === "initialize");

    if (isInit) {
      sessionId = generateSessionId();
      sessions.set(sessionId, { created: Date.now() });
    } else if (sessionId && !sessions.has(sessionId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "Invalid session" },
        })
      );
      return;
    }

    for (const m of messages) {
      const response = handleJsonRpc(m);
      if (response) responses.push(response);
    }

    if (responses.length === 0) {
      // All notifications, no response needed
      res.writeHead(204, {
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      });
      res.end();
      return;
    }

    const result = isBatch ? responses : responses[0];
    res.writeHead(200, {
      "Content-Type": "application/json",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    });
    res.end(JSON.stringify(result));
  });
});

server.listen(PORT, () => {
  console.log(`test-mcp-http server listening on http://localhost:${PORT}/mcp`);
});
