#!/usr/bin/env node
/**
 * Tier 2: Full upload → agent + MCP skills → download workflow.
 *
 * Requires `claude` CLI and an API key to be available.
 * Pre-flight checks for `claude --version`; skips with exit 0 if missing.
 *
 * Usage: node test/test-file-agent-workflow.js
 */

const http = require("http");
const { spawn, execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const assert = require("assert");

// Load .env file if present (no external dependencies)
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

// ---------------------------------------------------------------------------
// Pre-flight: check claude CLI
// ---------------------------------------------------------------------------

try {
  const ver = execSync("claude --version", { encoding: "utf-8", timeout: 5000 }).trim();
  console.log(`claude CLI found: ${ver}`);
} catch {
  console.log("claude CLI not found — skipping Tier 2 test.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SERVER_JS = path.join(__dirname, "..", "server.js");
const SKILLS_PATH = path.join(__dirname, "..", "skills");
const FIXTURE = path.join(__dirname, "fixtures", "sample-contract.txt");
const PORT = 10000 + Math.floor(Math.random() * 50000);
const BASE = `http://localhost:${PORT}`;

// Backend config from environment (default: local)
const BACKEND = process.env.TEST_BACKEND || "local";
const MASTER_TIMEOUT_MS = BACKEND === "local" ? 180000 : 300000; // 3 min local, 5 min remote

function buildServerArgs() {
  const args = [SERVER_JS, "--backend", BACKEND, "--port", String(PORT), "--skills-path", SKILLS_PATH];
  if (BACKEND === "vercel") {
    const token = process.env.VERCEL_TOKEN
      || (() => { try {
          return JSON.parse(fs.readFileSync(
            path.join(process.env.HOME, "Library/Application Support/com.vercel.cli/auth.json"), "utf8"
          )).token;
        } catch { return ""; }
      })();
    if (!token) { console.error("VERCEL_TOKEN not found"); process.exit(1); }
    const teamId = process.env.VERCEL_TEAM_ID || "";
    if (!teamId) { console.error("VERCEL_TEAM_ID required"); process.exit(1); }
    args.push("--vercel-token", token, "--vercel-team-id", teamId);
    if (process.env.VERCEL_PROJECT_ID) args.push("--vercel-project-id", process.env.VERCEL_PROJECT_ID);
    if (process.env.VERCEL_SNAPSHOT_ID) args.push("--vercel-snapshot-id", process.env.VERCEL_SNAPSHOT_ID);
  } else if (BACKEND === "sprite") {
    const token = process.env.SPRITE_TOKEN || process.env.SPRITES_TOKEN || "";
    if (!token) { console.error("SPRITE_TOKEN required"); process.exit(1); }
    args.push("--sprite-token", token);
    const name = process.env.SPRITE_NAME || "";
    if (!name) { console.error("SPRITE_NAME required"); process.exit(1); }
    args.push("--sprite-name", name);
  }
  return args;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function request(method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers,
    };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        let json;
        try {
          json = JSON.parse(raw.toString());
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on("error", reject);
    if (body !== null) {
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Print SSE events in real-time as they arrive.
 */
function printEvent(eventName, data) {
  if (eventName === "system") {
    const sid = data?.session_id || "";
    process.stdout.write(`[system]      Session ${sid.slice(0, 12)}...\n`);
  } else if (eventName === "assistant" && data?.message?.content) {
    for (const block of data.message.content) {
      if (block.type === "text" && block.text) {
        const preview = block.text.length > 300
          ? block.text.slice(0, 300) + "… (truncated)"
          : block.text;
        process.stdout.write(`[assistant]   ${preview}\n`);
      } else if (block.type === "tool_use") {
        const args = JSON.stringify(block.input || {});
        process.stdout.write(`[tool_use]    ${block.name} ${args}\n`);
      }
    }
  } else if (eventName === "user" && data?.message?.content) {
    for (const block of data.message.content) {
      if (block.type === "tool_result") {
        const text = typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content || "");
        const preview = text.length > 200
          ? text.slice(0, 200) + "… (truncated)"
          : text;
        process.stdout.write(`[tool_result] ${preview}\n`);
      }
    }
  } else if (eventName === "result" && data) {
    const t = data.num_turns ?? "?";
    const c = data.total_cost_usd != null ? `$${data.total_cost_usd.toFixed(4)}` : "?";
    const ws = data.workspace_id || "";
    process.stdout.write(`[result]      turns=${t} cost=${c} workspace=${ws.slice(0, 12)}\n`);
  } else if (eventName === "error" && data) {
    process.stdout.write(`[error]       ${data.error?.message || JSON.stringify(data)}\n`);
  } else if (eventName === "done") {
    process.stdout.write(`[done]        Stream complete\n`);
  }
}

/**
 * POST with SSE streaming — returns parsed events.
 */
function requestSSE(urlPath, body, timeoutMs = MASTER_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const events = [];
    const url = new URL(urlPath, BASE);
    const jsonBody = JSON.stringify(body);

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`SSE request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(jsonBody),
      },
    };

    const req = http.request(opts, (res) => {
      let buffer = "";

      res.on("data", (chunk) => {
        buffer += chunk.toString();
        // Parse complete SSE messages
        const parts = buffer.split("\n\n");
        buffer = parts.pop(); // keep incomplete part

        for (const part of parts) {
          if (!part.trim()) continue;

          // Skip keepalive pings
          if (part.trim() === ":ping") continue;

          // Parse SSE fields
          let eventName = null;
          let data = null;

          for (const line of part.split("\n")) {
            if (line.startsWith("event: ")) {
              eventName = line.slice(7).trim();
            } else if (line.startsWith("data: ")) {
              const raw = line.slice(6);
              if (raw === "[DONE]") {
                eventName = "done";
                data = null;
              } else {
                try {
                  data = JSON.parse(raw);
                } catch {
                  data = raw;
                }
              }
            }
          }

          if (eventName || data !== null) {
            events.push({ event: eventName, data });
            printEvent(eventName, data);
          }
        }
      });

      res.on("end", () => {
        clearTimeout(timer);
        resolve({ status: res.statusCode, events });
      });

      res.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    req.write(jsonBody);
    req.end();
  });
}

function waitForServer(timeoutMs = BACKEND === "local" ? 15000 : 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      request("GET", "/")
        .then((r) => {
          if (r.status === 200) return resolve();
          retry();
        })
        .catch(retry);
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) return reject(new Error("Server did not start"));
      setTimeout(check, 300);
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// Main workflow
// ---------------------------------------------------------------------------

async function run() {
  const masterTimer = setTimeout(() => {
    console.error(`\nMaster timeout (${MASTER_TIMEOUT_MS / 1000}s) exceeded — aborting.`);
    process.exit(1);
  }, MASTER_TIMEOUT_MS);

  console.log(`\nStarting server on port ${PORT} (backend=${BACKEND}) with --skills-path ${SKILLS_PATH}...\n`);

  const serverArgs = buildServerArgs();
  const server = spawn("node", serverArgs, { stdio: ["ignore", "pipe", "pipe"] });

  let serverStderr = "";
  server.stderr.on("data", (d) => { serverStderr += d.toString(); });
  server.stdout.on("data", (d) => { /* drain stdout */ });

  let workspaceId;

  try {
    await waitForServer();
    console.log("Server ready.\n");

    // -----------------------------------------------------------------------
    // Step 1: Upload sample-contract.txt
    // -----------------------------------------------------------------------
    console.log("Step 1: Uploading sample-contract.txt...");
    const contractContent = fs.readFileSync(FIXTURE);
    const uploadRes = await request("POST", "/v1/files/upload", {
      headers: {
        "X-Filename": "sample-contract.txt",
        "Content-Type": "application/octet-stream",
      },
      body: contractContent,
    });
    assert.strictEqual(uploadRes.status, 200, `Upload failed: ${JSON.stringify(uploadRes.json)}`);
    workspaceId = uploadRes.json.workspace_id;
    console.log(`  Workspace: ${workspaceId}`);
    console.log(`  File: ${uploadRes.json.file.name} (${uploadRes.json.file.size} bytes)\n`);

    // -----------------------------------------------------------------------
    // Step 2: Verify workspace lists the file
    // -----------------------------------------------------------------------
    console.log("Step 2: Verifying workspace file listing...");
    const listRes = await request("GET", `/v1/files/${workspaceId}`);
    assert.strictEqual(listRes.status, 200);
    const uploadedFiles = listRes.json.files;
    assert.ok(uploadedFiles.some((f) => f.name === "sample-contract.txt"), "sample-contract.txt not in listing");
    console.log(`  Files: ${uploadedFiles.map((f) => `${f.name} (${f.type})`).join(", ")}\n`);

    // -----------------------------------------------------------------------
    // Step 3: POST /v1/agent with MCP skills
    // -----------------------------------------------------------------------
    // MCP skills server is only reachable from localhost — include it for local backend only
    const useMcp = BACKEND === "local";
    console.log(`Step 3: Running agent ${useMcp ? "with MCP skills" : "(no MCP — remote backend)"}...`);
    console.log("  (This may take 1-2 minutes)\n");

    const agentBody = {
      prompt: useMcp
        ? "Use the list_skills MCP tool to find available skills. " +
          "Activate the contract-risk-analyzer skill and read its risk rubric. " +
          "Then read the contract file in your working directory and write a risk assessment " +
          "to risk-assessment.md following the skill's output format."
        : "Read the contract file in your working directory. Analyze each clause for legal risk " +
          "(high, medium, or low) and write a structured risk assessment to risk-assessment.md.",
      workspace_id: workspaceId,
      system_prompt: useMcp
        ? "You are a legal risk analyst. You have MCP tools available to discover and use analysis skills. " +
          "Always start by listing available skills, then activate the relevant one and read its reference " +
          "materials before analyzing."
        : "You are a legal risk analyst. Analyze contracts clause by clause and produce structured risk assessments.",
      stream: true,
      max_turns: 10,
    };

    if (useMcp) {
      agentBody.mcp_servers = {
        skills: {
          type: "http",
          url: `http://localhost:${PORT}/mcp`,
        },
      };
    }

    const sseResult = await requestSSE("/v1/agent", agentBody);
    assert.strictEqual(sseResult.status, 200, `Agent returned ${sseResult.status}`);

    // -----------------------------------------------------------------------
    // Step 4: Parse and verify SSE events
    // -----------------------------------------------------------------------
    console.log("\nStep 4: Verifying SSE events...");

    // Check for init/system event
    const hasInit = sseResult.events.some(
      (e) => e.event === "system" || (e.data && e.data.type === "system"),
    );
    assert.ok(hasInit, "Expected a system/init event");

    // MCP skill tool assertions only for local backend
    if (useMcp) {
      const allEventText = JSON.stringify(sseResult.events);
      assert.ok(allEventText.includes("list_skills"), "Expected list_skills tool call");
      assert.ok(allEventText.includes("activate_skill"), "Expected activate_skill tool call");
      assert.ok(allEventText.includes("read_resource"), "Expected read_resource tool call");
    }

    // Check for result event with workspace_id
    const resultEvent = sseResult.events.find(
      (e) => e.event === "result" || (e.data && e.data.type === "result"),
    );
    assert.ok(resultEvent, "Expected a result event");

    console.log("  SSE event assertions passed.\n");

    // -----------------------------------------------------------------------
    // Step 5: List files after completion — verify risk-assessment.md
    // -----------------------------------------------------------------------
    console.log("Step 5: Checking for risk-assessment.md...");
    const postList = await request("GET", `/v1/files/${workspaceId}`);
    assert.strictEqual(postList.status, 200, "Failed to list files post-agent");

    const allFiles = postList.json.files;
    console.log(`  Files: ${allFiles.map((f) => `${f.name} (${f.type})`).join(", ")}`);

    const riskFile = allFiles.find((f) => f.name === "risk-assessment.md");
    assert.ok(riskFile, "risk-assessment.md not found in workspace after agent run");
    assert.strictEqual(riskFile.type, "output", "risk-assessment.md should be type 'output'");
    console.log(`  risk-assessment.md: ${riskFile.size} bytes, type=${riskFile.type}\n`);

    // -----------------------------------------------------------------------
    // Step 6: Download and print the risk assessment
    // -----------------------------------------------------------------------
    console.log("Step 6: Downloading risk-assessment.md...\n");
    const downloadRes = await request("GET", `/v1/files/${workspaceId}/risk-assessment.md`);
    assert.strictEqual(downloadRes.status, 200, "Failed to download risk-assessment.md");

    const assessment = downloadRes.raw.toString();
    console.log("═".repeat(60));
    console.log("RISK ASSESSMENT OUTPUT");
    console.log("═".repeat(60));
    console.log(assessment);
    console.log("═".repeat(60));

    // Basic content validation
    assert.ok(assessment.length > 100, `Assessment too short (${assessment.length} chars)`);
    console.log(`\n  Assessment length: ${assessment.length} chars`);
    console.log("  Content validation: OK\n");

    // -----------------------------------------------------------------------
    // Step 7: Cleanup
    // -----------------------------------------------------------------------
    console.log("Step 7: Cleaning up...");
    const delRes = await request("DELETE", `/v1/files/${workspaceId}`);
    assert.strictEqual(delRes.status, 200, "Failed to delete workspace");
    console.log("  Workspace deleted.\n");

    console.log("─".repeat(40));
    console.log("All Tier 2 tests passed.");

  } catch (err) {
    console.error(`\nTest failed: ${err.message}`);
    if (serverStderr) {
      console.error("\nServer stderr (last 500 chars):");
      console.error(serverStderr.slice(-500));
    }
    process.exitCode = 1;

    // Cleanup on failure
    if (workspaceId) {
      try {
        await request("DELETE", `/v1/files/${workspaceId}`);
      } catch {}
    }
  } finally {
    clearTimeout(masterTimer);
    server.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    if (!server.killed) server.kill("SIGKILL");
  }
}

run();
