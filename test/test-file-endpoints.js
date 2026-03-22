#!/usr/bin/env node
/**
 * Tier 1: Deterministic file CRUD tests (no claude CLI needed).
 *
 * Zero deps — uses only Node.js builtins: http, child_process, path, assert.
 * Spawns server.js, runs tests, shuts down.
 *
 * Usage: node test/test-file-endpoints.js
 */

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const assert = require("assert");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SERVER_JS = path.join(__dirname, "..", "server.js");
const PORT = 10000 + Math.floor(Math.random() * 50000);
const BASE = `http://localhost:${PORT}`;

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
      req.write(body);
    }
    req.end();
  });
}

function waitForServer(timeoutMs = 10000) {
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
      setTimeout(check, 200);
    };
    check();
  });
}

let passed = 0;
let failed = 0;

function ok(name) {
  passed++;
  console.log(`  ✓ ${name}`);
}

function fail(name, err) {
  failed++;
  console.log(`  ✗ ${name}`);
  console.log(`    ${err.message || err}`);
}

async function test(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run() {
  console.log(`\nStarting server on port ${PORT}...\n`);
  const server = spawn("node", [SERVER_JS, "--backend", "local", "--port", String(PORT)], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined },
  });

  // Capture stderr for debugging
  let serverStderr = "";
  server.stderr.on("data", (d) => { serverStderr += d.toString(); });

  try {
    await waitForServer();
    console.log("Server ready.\n");

    // State shared across tests
    let workspaceId;
    const fileContent = "Hello, this is test content for file upload.";
    const fileContent2 = "Second file content.";

    // 1. Upload creates workspace
    await test("1. Upload creates workspace", async () => {
      const res = await request("POST", "/v1/files/upload", {
        headers: { "X-Filename": "test-doc.txt", "Content-Type": "application/octet-stream" },
        body: fileContent,
      });
      assert.strictEqual(res.status, 200);
      assert.ok(res.json.workspace_id, "should return workspace_id");
      assert.ok(res.json.file, "should return file");
      assert.strictEqual(res.json.file.name, "test-doc.txt");
      assert.strictEqual(res.json.file.size, Buffer.byteLength(fileContent));
      workspaceId = res.json.workspace_id;
    });

    // 2. Upload second file to same workspace
    await test("2. Upload second file to same workspace via X-Workspace-Id", async () => {
      const res = await request("POST", "/v1/files/upload", {
        headers: {
          "X-Filename": "notes.txt",
          "X-Workspace-Id": workspaceId,
          "Content-Type": "application/octet-stream",
        },
        body: fileContent2,
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.workspace_id, workspaceId);
      assert.strictEqual(res.json.file.name, "notes.txt");
    });

    // 3. List files — both present, both type: "input"
    await test("3. List files — both present with type input", async () => {
      const res = await request("GET", `/v1/files/${workspaceId}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.workspace_id, workspaceId);
      const names = res.json.files.map((f) => f.name).sort();
      assert.deepStrictEqual(names, ["notes.txt", "test-doc.txt"]);
      for (const f of res.json.files) {
        assert.strictEqual(f.type, "input");
      }
    });

    // 4. Download — body matches uploaded content, correct Content-Type
    await test("4. Download returns correct content and Content-Type", async () => {
      const res = await request("GET", `/v1/files/${workspaceId}/test-doc.txt`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.raw.toString(), fileContent);
      assert.ok(res.headers["content-type"].includes("text/plain"), `expected text/plain, got ${res.headers["content-type"]}`);
    });

    // 5. Download URL-encoded filename
    await test("5. Download URL-encoded filename", async () => {
      // Upload a file with special chars
      const specialName = "my report (v2).txt";
      const encodedName = encodeURIComponent(specialName);
      const res1 = await request("POST", "/v1/files/upload", {
        headers: {
          "X-Filename": encodedName,
          "X-Workspace-Id": workspaceId,
          "Content-Type": "application/octet-stream",
        },
        body: "special file content",
      });
      assert.strictEqual(res1.status, 200);
      assert.strictEqual(res1.json.file.name, specialName);

      // Download with URL-encoded path
      const res2 = await request("GET", `/v1/files/${workspaceId}/${encodedName}`);
      assert.strictEqual(res2.status, 200);
      assert.strictEqual(res2.raw.toString(), "special file content");
    });

    // 6. Missing X-Filename header → 400
    await test("6. Missing X-Filename header returns 400", async () => {
      const res = await request("POST", "/v1/files/upload", {
        headers: { "Content-Type": "application/octet-stream" },
        body: "some content",
      });
      assert.strictEqual(res.status, 400);
      assert.ok(res.json.error.message.includes("X-Filename"), res.json.error.message);
    });

    // 7. Empty body → 400
    await test("7. Empty body returns 400", async () => {
      const res = await request("POST", "/v1/files/upload", {
        headers: { "X-Filename": "empty.txt", "Content-Type": "application/octet-stream" },
        body: "",
      });
      assert.strictEqual(res.status, 400);
    });

    // 8. Nonexistent workspace on upload → 404
    await test("8. Nonexistent workspace on upload returns 404", async () => {
      const res = await request("POST", "/v1/files/upload", {
        headers: {
          "X-Filename": "test.txt",
          "X-Workspace-Id": "nonexistent-workspace-id",
          "Content-Type": "application/octet-stream",
        },
        body: "content",
      });
      assert.strictEqual(res.status, 404);
    });

    // 9. Nonexistent workspace on list → 404
    await test("9. Nonexistent workspace on list returns 404", async () => {
      const res = await request("GET", "/v1/files/nonexistent-workspace-id");
      assert.strictEqual(res.status, 404);
    });

    // 10. Nonexistent file on download → 404
    await test("10. Nonexistent file on download returns 404", async () => {
      const res = await request("GET", `/v1/files/${workspaceId}/does-not-exist.txt`);
      assert.strictEqual(res.status, 404);
    });

    // 11. Delete workspace → 200
    await test("11. Delete workspace returns 200", async () => {
      const res = await request("DELETE", `/v1/files/${workspaceId}`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.deleted, true);
      assert.strictEqual(res.json.workspace_id, workspaceId);
    });

    // 12. Post-delete list → 404
    await test("12. Post-delete list returns 404", async () => {
      const res = await request("GET", `/v1/files/${workspaceId}`);
      assert.strictEqual(res.status, 404);
    });

    // 13. Path traversal filename → safe (basename extraction)
    await test("13. Path traversal filename is safely handled", async () => {
      const res = await request("POST", "/v1/files/upload", {
        headers: {
          "X-Filename": encodeURIComponent("../../../etc/passwd"),
          "Content-Type": "application/octet-stream",
        },
        body: "traversal attempt",
      });
      // Should either strip to basename "passwd" (200) or reject (400)
      if (res.status === 200) {
        assert.strictEqual(res.json.file.name, "passwd");
      } else {
        assert.strictEqual(res.status, 400);
      }
    });

    // 14. workspace_id + cwd both on agent → 400
    await test("14. workspace_id + cwd both on agent returns 400", async () => {
      // Create a workspace first
      const upload = await request("POST", "/v1/files/upload", {
        headers: { "X-Filename": "dummy.txt", "Content-Type": "application/octet-stream" },
        body: "dummy",
      });
      assert.strictEqual(upload.status, 200);
      const wsId = upload.json.workspace_id;

      const res = await request("POST", "/v1/agent", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: "test",
          workspace_id: wsId,
          cwd: "/tmp",
          stream: false,
        }),
      });
      assert.strictEqual(res.status, 400);
      assert.ok(res.json.error.message.includes("mutually exclusive"), res.json.error.message);

      // Cleanup
      await request("DELETE", `/v1/files/${wsId}`);
    });

    // Summary
    console.log(`\n${"─".repeat(40)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  } catch (err) {
    console.error("\nFatal error:", err);
    process.exitCode = 1;
  } finally {
    server.kill("SIGTERM");
    // Give it a moment to shut down gracefully
    await new Promise((r) => setTimeout(r, 500));
    if (!server.killed) server.kill("SIGKILL");
  }
}

run();
