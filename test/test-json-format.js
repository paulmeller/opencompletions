#!/usr/bin/env node
/**
 * Tests for getFirstJson() utility and response_format: "json" support.
 *
 * Tier 1: No CLI needed, tests the extraction utility directly.
 */

const assert = require("assert");

// Extract getFirstJson from server.js by evaluating the function
// (it's not exported, so we inline a copy for testing)
function getFirstJson(text) {
  if (!text || typeof text !== "string") return null;
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (typeof parsed === "object" && parsed !== null) return { json: parsed, raw: fenceMatch[1].trim() };
    } catch {}
  }
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null) return { json: parsed, raw: trimmed };
  } catch {}
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch !== "{" && ch !== "[") continue;
    const close = ch === "{" ? "}" : "]";
    let depth = 0, inString = false, escape = false;
    for (let j = i; j < trimmed.length; j++) {
      const c = trimmed[j];
      if (escape) { escape = false; continue; }
      if (c === "\\") { escape = true; continue; }
      if (c === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (c === ch) depth++;
      if (c === close) {
        depth--;
        if (depth === 0) {
          const candidate = trimmed.slice(i, j + 1);
          try {
            const parsed = JSON.parse(candidate);
            if (typeof parsed === "object" && parsed !== null) return { json: parsed, raw: candidate };
          } catch {}
          break;
        }
      }
    }
  }
  return null;
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

console.log("\ngetFirstJson() tests\n");

test("pure JSON object", () => {
  const r = getFirstJson('{"name":"test","value":42}');
  assert.ok(r);
  assert.deepStrictEqual(r.json, { name: "test", value: 42 });
});

test("pure JSON array", () => {
  const r = getFirstJson('["red","green","blue"]');
  assert.ok(r);
  assert.deepStrictEqual(r.json, ["red", "green", "blue"]);
});

test("JSON in markdown code fence", () => {
  const r = getFirstJson('Here is the result:\n```json\n{"status":"ok"}\n```\nDone.');
  assert.ok(r);
  assert.deepStrictEqual(r.json, { status: "ok" });
});

test("JSON in code fence without json tag", () => {
  const r = getFirstJson('```\n[1,2,3]\n```');
  assert.ok(r);
  assert.deepStrictEqual(r.json, [1, 2, 3]);
});

test("JSON with surrounding prose", () => {
  const r = getFirstJson('The answer is: {"count":5,"items":["a","b"]} as shown above.');
  assert.ok(r);
  assert.deepStrictEqual(r.json, { count: 5, items: ["a", "b"] });
});

test("nested JSON objects", () => {
  const r = getFirstJson('{"outer":{"inner":{"deep":true}}}');
  assert.ok(r);
  assert.strictEqual(r.json.outer.inner.deep, true);
});

test("JSON with escaped quotes", () => {
  const r = getFirstJson('{"message":"He said \\"hello\\""}');
  assert.ok(r);
  assert.strictEqual(r.json.message, 'He said "hello"');
});

test("empty string returns null", () => {
  assert.strictEqual(getFirstJson(""), null);
});

test("null returns null", () => {
  assert.strictEqual(getFirstJson(null), null);
});

test("plain text with no JSON returns null", () => {
  assert.strictEqual(getFirstJson("This is just text with no JSON."), null);
});

test("primitive JSON (number) returns null", () => {
  assert.strictEqual(getFirstJson("42"), null);
});

test("primitive JSON (string) returns null", () => {
  assert.strictEqual(getFirstJson('"hello"'), null);
});

test("JSON with leading whitespace and newlines", () => {
  const r = getFirstJson('\n\n  {"ok": true}\n\n');
  assert.ok(r);
  assert.strictEqual(r.json.ok, true);
});

test("array in markdown with extra text", () => {
  const r = getFirstJson('I found 3 colors:\n```json\n["red", "green", "blue"]\n```\nHope that helps!');
  assert.ok(r);
  assert.strictEqual(r.json.length, 3);
});

test("multiple JSON objects — returns first", () => {
  const r = getFirstJson('{"first":1} {"second":2}');
  assert.ok(r);
  assert.strictEqual(r.json.first, 1);
});

console.log(`\n${"─".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
