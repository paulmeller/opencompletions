#!/usr/bin/env npx tsx
/**
 * test-helpers.ts — Unit tests for lib/oc/helpers.ts pure functions.
 *
 * No server needed. Run with:
 *   npx tsx test/test-helpers.ts
 */

import assert from "assert";
import path from "path";
import os from "os";
import fs from "fs";

const tmpDb = path.join(os.tmpdir(), `oc-test-helpers-${Date.now()}.db`);

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err: unknown) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

async function main() {
  // Set SKILLS_DB_PATH to a temp location before importing helpers
  // (helpers.ts -> config.ts -> db.ts triggers DB init)
  process.env.SKILLS_DB_PATH = tmpDb;

  const helpers = await import("../lib/oc/helpers.js");
  const { getFirstJson, normalizeResponseFormat, applyJsonFormat, cleanOutput, cleanChunk } = helpers;

  // -------------------------------------------------------------------------
  // getFirstJson tests
  // -------------------------------------------------------------------------

  console.log("\nUnit Tests: helpers.ts");
  console.log("\n--- getFirstJson ---");

  test("returns null for null input", () => {
    assert.strictEqual(getFirstJson(null as unknown as string), null);
  });

  test("returns null for empty string", () => {
    assert.strictEqual(getFirstJson(""), null);
  });

  test("returns null for undefined input", () => {
    assert.strictEqual(getFirstJson(undefined as unknown as string), null);
  });

  test("parses plain JSON object", () => {
    const result = getFirstJson('{"name": "test", "value": 42}');
    assert.ok(result !== null, "should not be null");
    assert.deepStrictEqual(result!.json, { name: "test", value: 42 });
  });

  test("parses plain JSON array", () => {
    const result = getFirstJson("[1, 2, 3]");
    assert.ok(result !== null, "should not be null");
    assert.deepStrictEqual(result!.json, [1, 2, 3]);
  });

  test("extracts JSON from markdown code fence", () => {
    const input = '```json\n{"key": "value"}\n```';
    const result = getFirstJson(input);
    assert.ok(result !== null, "should not be null");
    assert.deepStrictEqual(result!.json, { key: "value" });
  });

  test("extracts JSON from markdown code fence without language tag", () => {
    const input = '```\n{"key": "value"}\n```';
    const result = getFirstJson(input);
    assert.ok(result !== null, "should not be null");
    assert.deepStrictEqual(result!.json, { key: "value" });
  });

  test("extracts JSON from surrounding prose", () => {
    const input = 'Here is the result: {"answer": 42} and that is it.';
    const result = getFirstJson(input);
    assert.ok(result !== null, "should not be null");
    assert.deepStrictEqual(result!.json, { answer: 42 });
  });

  test("handles nested braces", () => {
    const input = '{"outer": {"inner": {"deep": true}}, "list": [1, {"a": 2}]}';
    const result = getFirstJson(input);
    assert.ok(result !== null, "should not be null");
    assert.deepStrictEqual(result!.json, {
      outer: { inner: { deep: true } },
      list: [1, { a: 2 }],
    });
  });

  test("handles escaped quotes in strings", () => {
    const input = '{"text": "He said \\"hello\\" to me"}';
    const result = getFirstJson(input);
    assert.ok(result !== null, "should not be null");
    assert.strictEqual(
      (result!.json as Record<string, string>).text,
      'He said "hello" to me',
    );
  });

  test("returns null when no JSON found", () => {
    assert.strictEqual(getFirstJson("just some plain text with no json"), null);
  });

  test("returns null for a number (not object/array)", () => {
    assert.strictEqual(getFirstJson("42"), null);
  });

  test("returns null for a bare string", () => {
    assert.strictEqual(getFirstJson('"hello"'), null);
  });

  test("extracts first JSON when multiple present", () => {
    const input = 'First: {"a": 1} Second: {"b": 2}';
    const result = getFirstJson(input);
    assert.ok(result !== null, "should not be null");
    assert.deepStrictEqual(result!.json, { a: 1 });
  });

  test("extracts array from surrounding text", () => {
    const input = "The data is: [1, 2, 3] done.";
    const result = getFirstJson(input);
    assert.ok(result !== null, "should not be null");
    assert.deepStrictEqual(result!.json, [1, 2, 3]);
  });

  // -------------------------------------------------------------------------
  // normalizeResponseFormat tests
  // -------------------------------------------------------------------------

  console.log("\n--- normalizeResponseFormat ---");

  test('returns "text" for null', () => {
    assert.strictEqual(normalizeResponseFormat(null), "text");
  });

  test('returns "text" for undefined', () => {
    assert.strictEqual(normalizeResponseFormat(undefined), "text");
  });

  test('returns "json" for "json" string', () => {
    assert.strictEqual(normalizeResponseFormat("json"), "json");
  });

  test('returns "text" for random string', () => {
    assert.strictEqual(normalizeResponseFormat("xml"), "text");
  });

  test('returns "json" for {type: "json_object"}', () => {
    assert.strictEqual(normalizeResponseFormat({ type: "json_object" }), "json");
  });

  test('returns "text" for {type: "text"}', () => {
    assert.strictEqual(normalizeResponseFormat({ type: "text" }), "text");
  });

  test('returns "text" for {type: "other"}', () => {
    assert.strictEqual(normalizeResponseFormat({ type: "other" }), "text");
  });

  // -------------------------------------------------------------------------
  // applyJsonFormat tests
  // -------------------------------------------------------------------------

  console.log("\n--- applyJsonFormat ---");

  test("extracts valid JSON from plain JSON text", () => {
    const result = applyJsonFormat('{"status": "ok"}');
    assert.strictEqual(result.result, '{"status":"ok"}');
    assert.strictEqual(result.json_error, undefined);
  });

  test("extracts valid JSON from text with surrounding prose", () => {
    const result = applyJsonFormat('The result is {"status": "ok"} done.');
    assert.strictEqual(result.result, '{"status":"ok"}');
    assert.strictEqual(result.json_error, undefined);
  });

  test("returns error for non-JSON text", () => {
    const result = applyJsonFormat("just some plain text");
    assert.strictEqual(result.result, "just some plain text");
    assert.ok(result.json_error, "should have json_error");
    assert.ok(
      result.json_error!.includes("Could not extract"),
      `Expected error about extraction, got "${result.json_error}"`,
    );
  });

  test("returns error for empty input", () => {
    const result = applyJsonFormat("");
    assert.ok(result.json_error, "should have json_error for empty input");
    assert.ok(
      result.json_error!.includes("Empty"),
      `Expected "Empty" in error, got "${result.json_error}"`,
    );
  });

  // -------------------------------------------------------------------------
  // cleanOutput tests
  // -------------------------------------------------------------------------

  console.log("\n--- cleanOutput ---");

  test("strips ANSI escape codes", () => {
    const input = "\x1B[31mred text\x1B[0m";
    assert.strictEqual(cleanOutput(input), "red text");
  });

  test("strips multiple ANSI escape codes", () => {
    const input = "\x1B[1m\x1B[32mbold green\x1B[0m\x1B[0m";
    assert.strictEqual(cleanOutput(input), "bold green");
  });

  test("strips control characters", () => {
    const input = "hello\x00world\x07done";
    assert.strictEqual(cleanOutput(input), "helloworlddone");
  });

  test("preserves normal text", () => {
    assert.strictEqual(cleanOutput("hello world"), "hello world");
  });

  test("trims whitespace", () => {
    assert.strictEqual(cleanOutput("  hello  "), "hello");
  });

  test("handles combined ANSI + control chars + whitespace", () => {
    const input = "  \x1B[33m\x00warning\x1B[0m  ";
    assert.strictEqual(cleanOutput(input), "warning");
  });

  // -------------------------------------------------------------------------
  // cleanChunk tests (no trim variant)
  // -------------------------------------------------------------------------

  console.log("\n--- cleanChunk ---");

  test("strips ANSI but preserves whitespace", () => {
    const input = "  \x1B[31mred\x1B[0m  ";
    assert.strictEqual(cleanChunk(input), "  red  ");
  });

  // -------------------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------------------

  console.log(`\n--- Results ---`);
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  console.log();

  // Clean up temp DB
  try { fs.unlinkSync(tmpDb); } catch {}
  try { fs.unlinkSync(tmpDb + "-wal"); } catch {}
  try { fs.unlinkSync(tmpDb + "-shm"); } catch {}

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
