#!/usr/bin/env node
/**
 * test-endpoints.js — Integration tests for OpenCompletions Next.js API routes.
 *
 * Tests all API endpoints against a running server.
 * No test framework — uses Node.js assert + fetch.
 *
 * Usage:
 *   # Against a running server (default http://localhost:3000)
 *   node test/test-endpoints.js
 *
 *   # Custom server URL
 *   SERVER_URL=http://localhost:4000 node test/test-endpoints.js
 *
 *   # With API key for authenticated endpoints
 *   API_KEY=mysecret node test/test-endpoints.js
 */

const assert = require("assert");

const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
const API_KEY = process.env.API_KEY || "";

let passed = 0;
let failed = 0;
let skipped = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function skip(name, reason) {
  skipped++;
  console.log(`  SKIP  ${name} — ${reason}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function url(path) {
  return `${SERVER_URL}${path}`;
}

function authHeaders() {
  return API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {};
}

// ---------------------------------------------------------------------------
// Unauthenticated endpoint tests
// ---------------------------------------------------------------------------

async function testHealthEndpoint() {
  await test("GET /api/health — returns 200 with status ok", async () => {
    const res = await fetch(url("/api/health"));
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert.strictEqual(body.status, "ok", `Expected status "ok", got "${body.status}"`);
    assert.ok(body.name === "opencompletions", `Expected name "opencompletions", got "${body.name}"`);
    assert.ok(typeof body.active_workers === "number", "active_workers should be a number");
    assert.ok(typeof body.queued === "number", "queued should be a number");
    assert.ok(typeof body.max_concurrency === "number", "max_concurrency should be a number");
    assert.ok(body.endpoints && typeof body.endpoints === "object", "endpoints should be an object");
  });
}

async function testModelsEndpoint() {
  await test("GET /api/v1/models — returns 200 with model list", async () => {
    const res = await fetch(url("/api/v1/models"));
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert.strictEqual(body.object, "list", `Expected object "list", got "${body.object}"`);
    assert.ok(Array.isArray(body.data), "data should be an array");
    assert.ok(body.data.length > 0, "data should have at least one model");
    const model = body.data[0];
    assert.strictEqual(model.id, "claude-code", `Expected model id "claude-code", got "${model.id}"`);
    assert.strictEqual(model.object, "model", `Expected object "model", got "${model.object}"`);
  });
}

async function testModelDetailEndpoint() {
  await test("GET /api/v1/models/claude-code — returns 200 with model detail", async () => {
    const res = await fetch(url("/api/v1/models/claude-code"));
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert.strictEqual(body.id, "claude-code", `Expected id "claude-code", got "${body.id}"`);
    assert.strictEqual(body.object, "model", `Expected object "model", got "${body.object}"`);
    assert.ok(typeof body.created === "number", "created should be a number");
    assert.ok(body.capabilities && typeof body.capabilities === "object", "capabilities should be an object");
  });
}

async function testModelNotFound() {
  await test("GET /api/v1/models/nonexistent — returns 404", async () => {
    const res = await fetch(url("/api/v1/models/nonexistent"));
    assert.strictEqual(res.status, 404, `Expected 404, got ${res.status}`);
    const body = await res.json();
    assert.ok(body.error, "response should have an error object");
    assert.ok(body.error.message.includes("does not exist"), `Error message should mention "does not exist", got "${body.error.message}"`);
  });
}

async function testStatusEndpoint() {
  await test("GET /api/v1/status — returns 200 with status fields", async () => {
    const res = await fetch(url("/api/v1/status"));
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert.strictEqual(body.status, "ok", `Expected status "ok", got "${body.status}"`);
    assert.ok(typeof body.active_workers === "number", "active_workers should be a number");
    assert.ok(typeof body.queued === "number", "queued should be a number");
    assert.ok(typeof body.max_concurrency === "number", "max_concurrency should be a number");
    assert.ok(typeof body.backend === "string", "backend should be a string");
  });
}

// ---------------------------------------------------------------------------
// Auth-required endpoint tests (should return 401 without auth)
// ---------------------------------------------------------------------------

async function testBackendsRequiresAuth() {
  await test("GET /api/v1/backends — returns 401 without auth", async () => {
    const res = await fetch(url("/api/v1/backends"));
    assert.strictEqual(res.status, 401, `Expected 401, got ${res.status}`);
    const body = await res.json();
    assert.ok(body.error, "response should have an error object");
    assert.strictEqual(body.error.code, 401, `Expected error code 401, got ${body.error.code}`);
  });
}

async function testChatCompletionsRequiresAuth() {
  await test("POST /api/v1/chat/completions — returns 401 without auth", async () => {
    const res = await fetch(url("/api/v1/chat/completions"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-code",
        messages: [{ role: "user", content: "Hello" }],
      }),
    });
    assert.strictEqual(res.status, 401, `Expected 401, got ${res.status}`);
    const body = await res.json();
    assert.ok(body.error, "response should have an error object");
  });
}

async function testEmbeddingsRequiresAuth() {
  await test("POST /api/v1/embeddings — returns 401 without auth", async () => {
    const res = await fetch(url("/api/v1/embeddings"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "Hello world", model: "text-embedding-ada-002" }),
    });
    assert.strictEqual(res.status, 401, `Expected 401, got ${res.status}`);
    const body = await res.json();
    assert.ok(body.error, "response should have an error object");
  });
}

async function testAgentRequiresAuth() {
  await test("POST /api/v1/agent — returns 401 without auth", async () => {
    const res = await fetch(url("/api/v1/agent"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "Hello" }),
    });
    assert.strictEqual(res.status, 401, `Expected 401, got ${res.status}`);
    const body = await res.json();
    assert.ok(body.error, "response should have an error object");
  });
}

async function testRunsRequiresAuth() {
  await test("GET /api/v1/runs — returns 401 without auth", async () => {
    const res = await fetch(url("/api/v1/runs"));
    assert.strictEqual(res.status, 401, `Expected 401, got ${res.status}`);
    const body = await res.json();
    assert.ok(body.error, "response should have an error object");
  });
}

// ---------------------------------------------------------------------------
// Authenticated endpoint tests (only run if API_KEY is set)
// ---------------------------------------------------------------------------

async function testBackendsAuthenticated() {
  await test("GET /api/v1/backends — returns 200 with auth", async () => {
    const res = await fetch(url("/api/v1/backends"), {
      headers: authHeaders(),
    });
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert.ok(typeof body.default === "string", "default should be a string");
    assert.ok(Array.isArray(body.available), "available should be an array");
    assert.ok(body.available.includes("local"), 'available should include "local"');
    assert.ok(body.details && typeof body.details === "object", "details should be an object");
  });
}

async function testRunsAuthenticated() {
  await test("GET /api/v1/runs — returns 200 with auth", async () => {
    const res = await fetch(url("/api/v1/runs"), {
      headers: authHeaders(),
    });
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert.ok(Array.isArray(body.runs), "runs should be an array");
    assert.ok(typeof body.total === "number", "total should be a number");
  });
}

async function testChatCompletionsInvalidBody() {
  await test("POST /api/v1/chat/completions — returns 400 for missing messages", async () => {
    const res = await fetch(url("/api/v1/chat/completions"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ model: "claude-code" }),
    });
    assert.strictEqual(res.status, 400, `Expected 400, got ${res.status}`);
    const body = await res.json();
    assert.ok(body.error, "response should have an error object");
    assert.ok(
      body.error.message.includes("messages"),
      `Error should mention "messages", got "${body.error.message}"`,
    );
  });
}

async function testAgentMissingPrompt() {
  await test("POST /api/v1/agent — returns 400 for missing prompt", async () => {
    const res = await fetch(url("/api/v1/agent"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400, `Expected 400, got ${res.status}`);
    const body = await res.json();
    assert.ok(body.error, "response should have an error object");
    assert.ok(
      body.error.message.includes("prompt"),
      `Error should mention "prompt", got "${body.error.message}"`,
    );
  });
}

async function testEmbeddingsAuthenticated() {
  await test("POST /api/v1/embeddings — returns 200 with valid input", async () => {
    const res = await fetch(url("/api/v1/embeddings"), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ input: "Hello world", model: "text-embedding-ada-002" }),
    });
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const body = await res.json();
    assert.strictEqual(body.object, "list", `Expected object "list", got "${body.object}"`);
    assert.ok(Array.isArray(body.data), "data should be an array");
    assert.ok(body.data.length === 1, "data should have one embedding");
    assert.strictEqual(body.data[0].object, "embedding", 'Each item should have object "embedding"');
    assert.ok(Array.isArray(body.data[0].embedding), "embedding should be an array of floats");
    assert.ok(body.data[0].embedding.length > 0, "embedding array should not be empty");
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nOpenCompletions Endpoint Tests`);
  console.log(`Server: ${SERVER_URL}`);
  console.log(`API Key: ${API_KEY ? "(set)" : "(not set)"}\n`);

  // Check server is reachable
  try {
    const res = await fetch(url("/api/health"), { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Health check returned ${res.status}`);
  } catch (err) {
    console.error(`ERROR: Cannot reach server at ${SERVER_URL}`);
    console.error(`       Make sure the Next.js dev server is running: npm run dev`);
    console.error(`       Error: ${err.message}\n`);
    process.exit(1);
  }

  // --- Unauthenticated tests (always run) ---
  console.log("--- Unauthenticated Endpoints ---");
  await testHealthEndpoint();
  await testModelsEndpoint();
  await testModelDetailEndpoint();
  await testModelNotFound();
  await testStatusEndpoint();

  // --- Auth-required tests (should return 401) ---
  console.log("\n--- Auth-Required Endpoints (expect 401) ---");
  await testBackendsRequiresAuth();
  await testChatCompletionsRequiresAuth();
  await testEmbeddingsRequiresAuth();
  await testAgentRequiresAuth();
  await testRunsRequiresAuth();

  // --- Authenticated tests (only if API_KEY is provided) ---
  if (API_KEY) {
    console.log("\n--- Authenticated Endpoints ---");
    await testBackendsAuthenticated();
    await testRunsAuthenticated();
    await testChatCompletionsInvalidBody();
    await testAgentMissingPrompt();
    await testEmbeddingsAuthenticated();
  } else {
    console.log("\n--- Authenticated Endpoints (skipped — set API_KEY to run) ---");
    skip("GET /api/v1/backends (auth)", "API_KEY not set");
    skip("GET /api/v1/runs (auth)", "API_KEY not set");
    skip("POST /api/v1/chat/completions (validation)", "API_KEY not set");
    skip("POST /api/v1/agent (validation)", "API_KEY not set");
    skip("POST /api/v1/embeddings (auth)", "API_KEY not set");
  }

  // --- Summary ---
  console.log(`\n--- Results ---`);
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  console.log(`  Skipped: ${skipped}`);
  console.log();

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
