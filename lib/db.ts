import Database from "better-sqlite3";
import path from "path";
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

export interface SkillRow {
  id: number;
  name: string;
  display_name: string;
  description: string;
  instructions: string;
  tags: string; // JSON array string e.g. '["legal","contracts"]'
  created_at: string;
  updated_at: string;
}

export interface SkillResource {
  file_name: string;
  content: string;
}

export interface SkillFull extends SkillRow {
  resources: SkillResource[];
}

export interface SkillInput {
  name: string;
  display_name?: string;
  description?: string;
  instructions?: string;
  tags?: string[];
  resources?: SkillResource[];
}

let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (db) return db;

  const dbPath =
    process.env.SKILLS_DB_PATH ||
    path.join(process.cwd(), "data", "skills.db");

  // Ensure data directory exists
  const dir = path.dirname(dbPath);
  const fs = require("fs");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  migrate(db);
  return db;
}

function migrate(db: Database.Database) {
  const version = db.pragma("user_version", { simple: true }) as number;

  if (version < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        instructions TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS skill_resources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_id INTEGER NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        UNIQUE(skill_id, file_name)
      );

      CREATE INDEX IF NOT EXISTS idx_skill_resources_skill_id
        ON skill_resources(skill_id);

      PRAGMA user_version = 1;
    `);
  }

  if (version < 2) {
    db.exec(`
      ALTER TABLE skills ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
      PRAGMA user_version = 2;
    `);
  }

  if (version < 3) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'text',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      PRAGMA user_version = 3;
    `);
  }

  if (version < 4) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        api_key_id TEXT,
        org_id TEXT,
        session_id TEXT,
        workspace_id TEXT,
        prompt TEXT,
        system_prompt TEXT,
        backend TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        num_turns INTEGER,
        total_cost_usd REAL,
        usage_json TEXT,
        error_message TEXT,
        cli TEXT,
        model TEXT,
        events_json TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_runs_started ON agent_runs(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_key ON agent_runs(api_key_id);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON agent_runs(status);
      PRAGMA user_version = 4;
    `);
  }

  if (version < 5) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workos_user_id TEXT NOT NULL,
        workos_key_id TEXT NOT NULL,
        key_value TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT 'Default',
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_keys_user_default
        ON user_keys(workos_user_id) WHERE is_default = 1;
      CREATE INDEX IF NOT EXISTS idx_user_keys_user
        ON user_keys(workos_user_id);
      PRAGMA user_version = 5;
    `);
  }
}

// ---------------------------------------------------------------------------
// Encryption helpers for secret settings
// ---------------------------------------------------------------------------

const ENCRYPTION_KEY = process.env.SETTINGS_ENCRYPTION_KEY || process.env.SESSION_SECRET || "";

function encrypt(plaintext: string): string {
  if (!ENCRYPTION_KEY) {
    if (!encryptionWarned) {
      console.warn("[settings] SETTINGS_ENCRYPTION_KEY not set — storing secrets in plaintext");
      encryptionWarned = true;
    }
    return plaintext;
  }
  const key = Buffer.from(ENCRYPTION_KEY.padEnd(32, "0").slice(0, 32));
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

function decrypt(ciphertext: string): string {
  if (!ciphertext.startsWith("enc:")) return ciphertext; // plaintext fallback
  if (!ENCRYPTION_KEY) return ciphertext;
  const [, ivHex, tagHex, dataHex] = ciphertext.split(":");
  const key = Buffer.from(ENCRYPTION_KEY.padEnd(32, "0").slice(0, 32));
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return decipher.update(Buffer.from(dataHex, "hex")) + decipher.final("utf8");
}

let encryptionWarned = false;

// ---------------------------------------------------------------------------
// Settings CRUD
// ---------------------------------------------------------------------------

let settingsCache: Map<string, string> | null = null;

export function getSetting(key: string): string | null {
  const db = getDb();
  const row = db.prepare("SELECT value, type FROM settings WHERE key = ?").get(key) as
    | { value: string; type: string }
    | undefined;
  if (!row) return null;
  return row.type === "secret" ? decrypt(row.value) : row.value;
}

export function setSetting(key: string, value: string, type: "text" | "secret" = "text"): void {
  const db = getDb();
  const stored = type === "secret" ? encrypt(value) : value;
  db.prepare(
    `INSERT INTO settings (key, value, type, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = ?, type = ?, updated_at = datetime('now')`
  ).run(key, stored, type, stored, type);
  settingsCache = null; // invalidate cache
}

export function deleteSetting(key: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  settingsCache = null;
  return result.changes > 0;
}

function redactSecret(value: string, type: string): string {
  if (type !== "secret") return value;
  const plain = value.startsWith("enc:") ? "(encrypted)" : value;
  if (plain === "(encrypted)") return plain;
  if (plain.length <= 8) return "••••";
  const prefix = plain.slice(0, plain.indexOf("-", 4) + 1) || plain.slice(0, 4);
  return `${prefix}•••${plain.slice(-4)}`;
}

export function getAllSettingsDecrypted(): Record<string, string> {
  const db = getDb();
  const rows = db.prepare("SELECT key, value, type FROM settings").all() as
    Array<{ key: string; value: string; type: string }>;
  const result: Record<string, string> = {};
  for (const r of rows) {
    result[r.key] = r.type === "secret" ? decrypt(r.value) : r.value;
  }
  return result;
}

export function listSettings(): Array<{ key: string; value: string; type: string; updated_at: string }> {
  const db = getDb();
  const rows = db.prepare("SELECT key, value, type, updated_at FROM settings ORDER BY key").all() as
    Array<{ key: string; value: string; type: string; updated_at: string }>;
  return rows.map((r) => ({
    ...r,
    value: redactSecret(r.value, r.type),
  }));
}

export function listSkills(): SkillFull[] {
  const db = getDb();
  const skills = db.prepare("SELECT * FROM skills ORDER BY name").all() as SkillRow[];

  const resourceStmt = db.prepare(
    "SELECT file_name, content FROM skill_resources WHERE skill_id = ?"
  );

  return skills.map((skill) => ({
    ...skill,
    resources: resourceStmt.all(skill.id) as SkillResource[],
  }));
}

export function getSkill(name: string): SkillFull | null {
  const db = getDb();
  const skill = db
    .prepare("SELECT * FROM skills WHERE name = ?")
    .get(name) as SkillRow | undefined;

  if (!skill) return null;

  const resources = db
    .prepare("SELECT file_name, content FROM skill_resources WHERE skill_id = ?")
    .all(skill.id) as SkillResource[];

  return { ...skill, resources };
}

export function getSkillResource(
  skillName: string,
  fileName: string
): SkillResource | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT sr.file_name, sr.content
       FROM skill_resources sr
       JOIN skills s ON s.id = sr.skill_id
       WHERE s.name = ? AND sr.file_name = ?`
    )
    .get(skillName, fileName) as SkillResource | undefined;

  return row || null;
}

export const createSkill = (() => {
  let fn: ReturnType<Database.Database["transaction"]> | null = null;

  return (input: SkillInput): SkillFull => {
    const db = getDb();
    if (!fn) {
      fn = db.transaction((input: SkillInput) => {
        const result = db
          .prepare(
            `INSERT INTO skills (name, display_name, description, instructions, tags)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(
            input.name,
            input.display_name || "",
            input.description || "",
            input.instructions || "",
            JSON.stringify(input.tags || [])
          );

        const skillId = result.lastInsertRowid as number;

        if (input.resources?.length) {
          const insertResource = db.prepare(
            `INSERT INTO skill_resources (skill_id, file_name, content)
             VALUES (?, ?, ?)`
          );
          for (const r of input.resources) {
            insertResource.run(skillId, r.file_name, r.content);
          }
        }

        return getSkill(input.name)!;
      });
    }
    return fn(input) as SkillFull;
  };
})();

export const updateSkill = (() => {
  let fn: ReturnType<Database.Database["transaction"]> | null = null;

  return (name: string, input: Omit<SkillInput, "name">): SkillFull | null => {
    const db = getDb();
    if (!fn) {
      fn = db.transaction((name: string, input: Omit<SkillInput, "name">) => {
        const existing = db
          .prepare("SELECT id FROM skills WHERE name = ?")
          .get(name) as { id: number } | undefined;

        if (!existing) return null;

        db.prepare(
          `UPDATE skills
           SET display_name = ?, description = ?, instructions = ?, tags = ?,
               updated_at = datetime('now')
           WHERE id = ?`
        ).run(
          input.display_name ?? "",
          input.description ?? "",
          input.instructions ?? "",
          input.tags ? JSON.stringify(input.tags) : "[]",
          existing.id
        );

        if (input.resources !== undefined) {
          db.prepare("DELETE FROM skill_resources WHERE skill_id = ?").run(
            existing.id
          );

          if (input.resources.length) {
            const insertResource = db.prepare(
              `INSERT INTO skill_resources (skill_id, file_name, content)
               VALUES (?, ?, ?)`
            );
            for (const r of input.resources) {
              insertResource.run(existing.id, r.file_name, r.content);
            }
          }
        }

        return getSkill(name);
      });
    }
    return fn(name, input) as SkillFull | null;
  };
})();

export function deleteSkill(name: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM skills WHERE name = ?").run(name);
  return result.changes > 0;
}

// ---------------------------------------------------------------------------
// Agent Runs CRUD
// ---------------------------------------------------------------------------

import { randomUUID } from "crypto";

export interface AgentRun {
  id: string;
  api_key_id: string | null;
  org_id: string | null;
  session_id: string | null;
  workspace_id: string | null;
  prompt: string | null;
  system_prompt: string | null;
  backend: string | null;
  cli: string | null;
  model: string | null;
  status: string;
  num_turns: number | null;
  total_cost_usd: number | null;
  usage_json: string | null;
  events_json: string | null;
  error_message: string | null;
  started_at: number;
  completed_at: number | null;
}

export function logRunStart(opts: {
  apiKeyId?: string;
  orgId?: string;
  sessionId?: string;
  workspaceId?: string;
  prompt?: string;
  systemPrompt?: string;
  backend?: string;
  cli?: string;
  model?: string;
}): string | null {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  db.prepare(`
    INSERT INTO agent_runs (id, api_key_id, org_id, session_id, workspace_id, prompt, system_prompt, backend, cli, model, status, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
  `).run(
    id,
    opts.apiKeyId || null,
    opts.orgId || null,
    opts.sessionId || null,
    opts.workspaceId || null,
    opts.prompt || null,
    opts.systemPrompt || null,
    opts.backend || null,
    opts.cli || null,
    opts.model || null,
    now
  );
  return id;
}

export function logRunComplete(
  runId: string,
  opts: {
    sessionId?: string;
    numTurns?: number;
    totalCostUsd?: number;
    usage?: Record<string, unknown>;
    error?: string;
  }
): void {
  if (!runId) return;
  const db = getDb();
  const status = opts.error ? "error" : "completed";
  db.prepare(`
    UPDATE agent_runs
    SET status = ?, session_id = COALESCE(?, session_id), num_turns = ?, total_cost_usd = ?,
        usage_json = ?, error_message = ?, completed_at = ?
    WHERE id = ?
  `).run(
    status,
    opts.sessionId || null,
    opts.numTurns || null,
    opts.totalCostUsd || null,
    opts.usage ? JSON.stringify(opts.usage) : null,
    opts.error || null,
    Date.now(),
    runId
  );
}

export function logRunEvents(runId: string, events: unknown[]): void {
  if (!runId || !events?.length) return;
  const db = getDb();
  db.prepare("UPDATE agent_runs SET events_json = ? WHERE id = ?")
    .run(JSON.stringify(events), runId);
}

export function listRuns(opts: {
  limit?: number;
  offset?: number;
  apiKeyId?: string;
  orgId?: string;
  status?: string;
} = {}): { runs: AgentRun[]; total: number } {
  const db = getDb();
  const { limit = 50, offset = 0 } = opts;

  let where = "1=1";
  const params: (string | number)[] = [];
  if (opts.apiKeyId) { where += " AND api_key_id = ?"; params.push(opts.apiKeyId); }
  if (opts.orgId) { where += " AND org_id = ?"; params.push(opts.orgId); }
  if (opts.status) { where += " AND status = ?"; params.push(opts.status); }

  const total = (db.prepare(`SELECT COUNT(*) as c FROM agent_runs WHERE ${where}`).get(...params) as { c: number }).c;
  const runs = db.prepare(`
    SELECT id, api_key_id, org_id, session_id, workspace_id,
           prompt, backend, cli, model, status, num_turns, total_cost_usd,
           error_message, started_at, completed_at
    FROM agent_runs WHERE ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as AgentRun[];

  return { runs, total };
}

export function getRun(id: string): AgentRun | null {
  const db = getDb();
  return (db.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) as AgentRun) || null;
}

export function getRunStats(opts: {
  apiKeyId?: string;
  orgId?: string;
  since?: number;
} = {}): Record<string, unknown> | null {
  const db = getDb();

  let where = "1=1";
  const params: (string | number)[] = [];
  if (opts.apiKeyId) { where += " AND api_key_id = ?"; params.push(opts.apiKeyId); }
  if (opts.orgId) { where += " AND org_id = ?"; params.push(opts.orgId); }
  if (opts.since) { where += " AND started_at >= ?"; params.push(opts.since); }

  return db.prepare(`
    SELECT
      COUNT(*) as total_runs,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
      SUM(total_cost_usd) as total_cost_usd,
      SUM(num_turns) as total_turns,
      AVG(total_cost_usd) as avg_cost_usd,
      AVG(num_turns) as avg_turns
    FROM agent_runs WHERE ${where}
  `).get(...params) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// User Keys CRUD
// ---------------------------------------------------------------------------

export function getUserDefaultKey(workosUserId: string): string | null {
  const db = getDb();
  const row = db
    .prepare("SELECT key_value FROM user_keys WHERE workos_user_id = ? AND is_default = 1")
    .get(workosUserId) as { key_value: string } | undefined;
  if (!row) return null;
  return decrypt(row.key_value);
}

export function setUserDefaultKey(
  workosUserId: string,
  workosKeyId: string,
  keyValue: string,
): void {
  const db = getDb();
  const encrypted = encrypt(keyValue);
  db.prepare(
    `INSERT INTO user_keys (workos_user_id, workos_key_id, key_value, name, is_default)
     VALUES (?, ?, ?, 'Default', 1)
     ON CONFLICT (workos_user_id) WHERE is_default = 1
     DO UPDATE SET workos_key_id = ?, key_value = ?`
  ).run(workosUserId, workosKeyId, encrypted, workosKeyId, encrypted);
}

export function deleteUserKey(workosKeyId: string): boolean {
  const db = getDb();
  const result = db
    .prepare("DELETE FROM user_keys WHERE workos_key_id = ?")
    .run(workosKeyId);
  return result.changes > 0;
}
