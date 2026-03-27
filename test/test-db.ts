#!/usr/bin/env npx tsx
/**
 * test-db.ts — Unit tests for lib/db.ts database operations.
 *
 * Uses a temporary SQLite DB. No server needed. Run with:
 *   npx tsx test/test-db.ts
 */

import assert from "assert";
import path from "path";
import os from "os";
import fs from "fs";

const tmpDb = path.join(os.tmpdir(), `oc-test-db-${Date.now()}.db`);

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
  // Set up temp DB path BEFORE importing db module
  process.env.SKILLS_DB_PATH = tmpDb;

  // Set an encryption key for testing secret encryption/decryption
  process.env.SETTINGS_ENCRYPTION_KEY = "test-encryption-key-32chars!!!";

  // Import db functions (this will create and migrate the temp DB)
  const db = await import("../lib/db.js");

  // -------------------------------------------------------------------------
  // DB initialization tests
  // -------------------------------------------------------------------------

  console.log("\nDatabase Tests");
  console.log("\n--- DB Initialization ---");

  // Trigger lazy DB initialization by calling any DB function
  test("getSetting returns null for nonexistent key (triggers DB init)", () => {
    const val = db.getSetting("nonexistent_key_xyz");
    assert.strictEqual(val, null);
  });

  test("temp DB file was created after first access", () => {
    assert.ok(fs.existsSync(tmpDb), `DB file should exist at ${tmpDb}`);
  });

  // -------------------------------------------------------------------------
  // Settings CRUD tests
  // -------------------------------------------------------------------------

  console.log("\n--- Settings CRUD ---");

  test("setSetting/getSetting round-trip (text)", () => {
    db.setSetting("test_key", "test_value");
    const val = db.getSetting("test_key");
    assert.strictEqual(val, "test_value");
  });

  test("setSetting overwrites existing key", () => {
    db.setSetting("test_key", "new_value");
    const val = db.getSetting("test_key");
    assert.strictEqual(val, "new_value");
  });

  test("setSetting/getSetting round-trip (secret — encrypted)", () => {
    db.setSetting("secret_key", "my-secret-token-abc123", "secret");
    const val = db.getSetting("secret_key");
    assert.strictEqual(val, "my-secret-token-abc123", "Decrypted value should match original");
  });

  test("secret value is stored encrypted (not plaintext)", () => {
    const all = db.listSettings();
    const secretEntry = all.find((s: { key: string }) => s.key === "secret_key");
    assert.ok(secretEntry, "secret_key should be in listSettings");
    assert.ok(secretEntry!.type === "secret", "type should be secret");
    assert.ok(
      secretEntry!.value !== "my-secret-token-abc123",
      "Listed value should be redacted, not plaintext",
    );
  });

  test("deleteSetting removes a key", () => {
    db.setSetting("delete_me", "gone_soon");
    assert.strictEqual(db.getSetting("delete_me"), "gone_soon");
    const deleted = db.deleteSetting("delete_me");
    assert.strictEqual(deleted, true);
    assert.strictEqual(db.getSetting("delete_me"), null);
  });

  test("deleteSetting returns false for nonexistent key", () => {
    const deleted = db.deleteSetting("never_existed_xyz");
    assert.strictEqual(deleted, false);
  });

  test("getAllSettingsDecrypted returns all settings decrypted", () => {
    db.setSetting("plain_setting", "hello");
    db.setSetting("secret_setting", "secret-value", "secret");
    const all = db.getAllSettingsDecrypted();
    assert.strictEqual(all["plain_setting"], "hello");
    assert.strictEqual(all["secret_setting"], "secret-value");
  });

  test("listSettings returns redacted secrets", () => {
    const all = db.listSettings();
    const secret = all.find((s: { key: string }) => s.key === "secret_setting");
    assert.ok(secret, "secret_setting should be in list");
    assert.notStrictEqual(
      secret!.value,
      "secret-value",
      "secret should be redacted in list",
    );
  });

  // -------------------------------------------------------------------------
  // Agent Runs tests
  // -------------------------------------------------------------------------

  console.log("\n--- Agent Runs ---");

  test("logRunStart creates a run with status running", () => {
    const runId = db.logRunStart({
      apiKeyId: "key-123",
      orgId: "org-456",
      prompt: "test prompt",
      backend: "local",
      cli: "claude",
    });
    assert.ok(runId, "logRunStart should return a run ID");
    assert.ok(typeof runId === "string", "run ID should be a string");

    const run = db.getRun(runId!);
    assert.ok(run, "getRun should find the run");
    assert.strictEqual(run!.status, "running");
    assert.strictEqual(run!.api_key_id, "key-123");
    assert.strictEqual(run!.org_id, "org-456");
    assert.strictEqual(run!.prompt, "test prompt");
    assert.strictEqual(run!.backend, "local");
    assert.strictEqual(run!.cli, "claude");
  });

  test("logRunComplete updates run to completed", () => {
    const runId = db.logRunStart({
      prompt: "another test",
      backend: "local",
    });
    assert.ok(runId);

    db.logRunComplete(runId!, {
      sessionId: "sess-abc",
      numTurns: 5,
      totalCostUsd: 0.025,
      usage: { input_tokens: 100, output_tokens: 200 },
    });

    const run = db.getRun(runId!);
    assert.ok(run, "getRun should find the run");
    assert.strictEqual(run!.status, "completed");
    assert.strictEqual(run!.session_id, "sess-abc");
    assert.strictEqual(run!.num_turns, 5);
    assert.ok(
      Math.abs(run!.total_cost_usd! - 0.025) < 0.001,
      "total_cost_usd should be ~0.025",
    );
    assert.ok(run!.completed_at, "completed_at should be set");
    assert.ok(run!.usage_json, "usage_json should be set");
    const usage = JSON.parse(run!.usage_json!);
    assert.strictEqual(usage.input_tokens, 100);
    assert.strictEqual(usage.output_tokens, 200);
  });

  test("logRunComplete with error sets status to error", () => {
    const runId = db.logRunStart({
      prompt: "error test",
      backend: "local",
    });
    assert.ok(runId);

    db.logRunComplete(runId!, {
      error: "Something went wrong",
    });

    const run = db.getRun(runId!);
    assert.ok(run);
    assert.strictEqual(run!.status, "error");
    assert.strictEqual(run!.error_message, "Something went wrong");
  });

  test("logRunEvents stores events", () => {
    const runId = db.logRunStart({ prompt: "events test", backend: "local" });
    assert.ok(runId);

    const events = [
      { type: "system", ts: Date.now() },
      { type: "assistant", ts: Date.now() + 100 },
      { type: "result", ts: Date.now() + 200 },
    ];
    db.logRunEvents(runId!, events);

    const run = db.getRun(runId!);
    assert.ok(run);
    assert.ok(run!.events_json, "events_json should be set");
    const stored = JSON.parse(run!.events_json!);
    assert.strictEqual(stored.length, 3);
    assert.strictEqual(stored[0].type, "system");
    assert.strictEqual(stored[2].type, "result");
  });

  test("listRuns returns results", () => {
    const result = db.listRuns();
    assert.ok(Array.isArray(result.runs), "runs should be an array");
    assert.ok(typeof result.total === "number", "total should be a number");
    assert.ok(
      result.total >= 4,
      `total should be >= 4 (created 4 runs above), got ${result.total}`,
    );
    assert.ok(result.runs.length > 0, "runs should not be empty");
  });

  test("listRuns filters by status", () => {
    const result = db.listRuns({ status: "error" });
    assert.ok(result.runs.length >= 1, "should have at least 1 error run");
    for (const run of result.runs) {
      assert.strictEqual(run.status, "error", "all runs should have status error");
    }
  });

  test("listRuns filters by apiKeyId", () => {
    const result = db.listRuns({ apiKeyId: "key-123" });
    assert.ok(
      result.runs.length >= 1,
      "should find at least 1 run with key-123",
    );
    for (const run of result.runs) {
      assert.strictEqual(run.api_key_id, "key-123");
    }
  });

  test("listRuns respects limit and offset", () => {
    const all = db.listRuns({ limit: 100 });
    const page1 = db.listRuns({ limit: 2, offset: 0 });
    const page2 = db.listRuns({ limit: 2, offset: 2 });
    assert.strictEqual(page1.runs.length, 2, "page1 should have 2 runs");
    assert.ok(page2.runs.length > 0, "page2 should have runs");
    assert.notStrictEqual(
      page1.runs[0].id,
      page2.runs[0].id,
      "pages should have different runs",
    );
    assert.strictEqual(page1.total, all.total);
  });

  test("getRunStats returns aggregates", () => {
    const stats = db.getRunStats();
    assert.ok(stats, "getRunStats should return an object");
    assert.ok(
      typeof stats!.total_runs === "number",
      "total_runs should be a number",
    );
    assert.ok(
      (stats!.total_runs as number) >= 4,
      `total_runs should be >= 4, got ${stats!.total_runs}`,
    );
    assert.ok(typeof stats!.completed === "number", "completed should be a number");
    assert.ok(typeof stats!.errors === "number", "errors should be a number");
    assert.ok(typeof stats!.running === "number", "running should be a number");
  });

  test("getRunStats filters by apiKeyId", () => {
    const stats = db.getRunStats({ apiKeyId: "key-123" });
    assert.ok(stats);
    assert.strictEqual(
      stats!.total_runs,
      1,
      "should have exactly 1 run for key-123",
    );
  });

  test("getRun returns null for nonexistent run", () => {
    const run = db.getRun("nonexistent-id-xyz");
    assert.strictEqual(run, null);
  });

  // -------------------------------------------------------------------------
  // Skills CRUD tests
  // -------------------------------------------------------------------------

  console.log("\n--- Skills CRUD ---");

  test("createSkill creates a new skill", () => {
    const skill = db.createSkill({
      name: "test-skill",
      display_name: "Test Skill",
      description: "A test skill",
      instructions: "Do the thing",
      tags: ["test", "demo"],
      resources: [{ file_name: "example.txt", content: "Hello world" }],
    });
    assert.ok(skill, "createSkill should return a skill");
    assert.strictEqual(skill.name, "test-skill");
    assert.strictEqual(skill.display_name, "Test Skill");
    assert.strictEqual(skill.description, "A test skill");
    assert.strictEqual(skill.instructions, "Do the thing");
    assert.ok(skill.tags.includes("test"), 'tags should include "test"');
    assert.ok(Array.isArray(skill.resources), "resources should be an array");
    assert.strictEqual(skill.resources.length, 1);
    assert.strictEqual(skill.resources[0].file_name, "example.txt");
    assert.strictEqual(skill.resources[0].content, "Hello world");
  });

  test("getSkill retrieves a skill by name", () => {
    const skill = db.getSkill("test-skill");
    assert.ok(skill, "getSkill should find the skill");
    assert.strictEqual(skill!.name, "test-skill");
    assert.strictEqual(skill!.display_name, "Test Skill");
    assert.strictEqual(skill!.resources.length, 1);
  });

  test("getSkill returns null for nonexistent skill", () => {
    const skill = db.getSkill("nonexistent-skill");
    assert.strictEqual(skill, null);
  });

  test("getSkillResource retrieves a specific resource", () => {
    const resource = db.getSkillResource("test-skill", "example.txt");
    assert.ok(resource, "getSkillResource should find the resource");
    assert.strictEqual(resource!.file_name, "example.txt");
    assert.strictEqual(resource!.content, "Hello world");
  });

  test("getSkillResource returns null for nonexistent resource", () => {
    const resource = db.getSkillResource("test-skill", "nope.txt");
    assert.strictEqual(resource, null);
  });

  test("listSkills returns all skills", () => {
    const skills = db.listSkills();
    assert.ok(Array.isArray(skills), "listSkills should return an array");
    assert.ok(skills.length >= 1, "should have at least 1 skill");
    const found = skills.find(
      (s: { name: string }) => s.name === "test-skill",
    );
    assert.ok(found, "should find test-skill in list");
  });

  test("updateSkill updates an existing skill", () => {
    const updated = db.updateSkill("test-skill", {
      display_name: "Updated Skill",
      description: "Updated description",
      instructions: "New instructions",
      tags: ["updated"],
      resources: [{ file_name: "new-file.md", content: "# New" }],
    });
    assert.ok(updated, "updateSkill should return updated skill");
    assert.strictEqual(updated!.display_name, "Updated Skill");
    assert.strictEqual(updated!.description, "Updated description");
    assert.strictEqual(updated!.instructions, "New instructions");
    assert.strictEqual(updated!.resources.length, 1);
    assert.strictEqual(updated!.resources[0].file_name, "new-file.md");
  });

  test("updateSkill returns null for nonexistent skill", () => {
    const result = db.updateSkill("nonexistent-skill", {
      display_name: "Nope",
    });
    assert.strictEqual(result, null);
  });

  test("deleteSkill removes a skill", () => {
    const deleted = db.deleteSkill("test-skill");
    assert.strictEqual(deleted, true);
    const skill = db.getSkill("test-skill");
    assert.strictEqual(skill, null);
  });

  test("deleteSkill returns false for nonexistent skill", () => {
    const deleted = db.deleteSkill("already-deleted");
    assert.strictEqual(deleted, false);
  });

  test("createSkill with no resources", () => {
    const skill = db.createSkill({
      name: "minimal-skill",
      display_name: "Minimal",
    });
    assert.ok(skill);
    assert.strictEqual(skill.name, "minimal-skill");
    assert.strictEqual(skill.resources.length, 0);
    db.deleteSkill("minimal-skill");
  });

  // -------------------------------------------------------------------------
  // User Keys tests
  // -------------------------------------------------------------------------

  console.log("\n--- User Keys ---");

  test("getUserDefaultKey returns null for unknown user", () => {
    const key = db.getUserDefaultKey("user-nonexistent");
    assert.strictEqual(key, null);
  });

  test("setUserDefaultKey/getUserDefaultKey round-trip", () => {
    db.setUserDefaultKey(
      "user-123",
      "wosak_test_key_id",
      "sk-ant-test-key-value",
    );
    const key = db.getUserDefaultKey("user-123");
    assert.strictEqual(key, "sk-ant-test-key-value");
  });

  test("setUserDefaultKey overwrites existing default key", () => {
    db.setUserDefaultKey(
      "user-123",
      "wosak_new_key_id",
      "sk-ant-new-key-value",
    );
    const key = db.getUserDefaultKey("user-123");
    assert.strictEqual(key, "sk-ant-new-key-value");
  });

  test("deleteUserKey removes a key", () => {
    const deleted = db.deleteUserKey("wosak_new_key_id");
    assert.strictEqual(deleted, true);
    const key = db.getUserDefaultKey("user-123");
    assert.strictEqual(key, null);
  });

  test("deleteUserKey returns false for nonexistent key", () => {
    const deleted = db.deleteUserKey("wosak_nonexistent");
    assert.strictEqual(deleted, false);
  });

  // -------------------------------------------------------------------------
  // Summary & Cleanup
  // -------------------------------------------------------------------------

  console.log(`\n--- Results ---`);
  console.log(`  Passed:  ${passed}`);
  console.log(`  Failed:  ${failed}`);
  console.log();

  // Clean up temp DB files
  try {
    fs.unlinkSync(tmpDb);
  } catch {}
  try {
    fs.unlinkSync(tmpDb + "-wal");
  } catch {}
  try {
    fs.unlinkSync(tmpDb + "-shm");
  } catch {}

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
