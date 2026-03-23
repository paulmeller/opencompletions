/**
 * SQLite persistence for OpenCompletions.
 *
 * Stores agent run history for the dashboard. Skills and auth stay external
 * (filesystem and WorkOS respectively).
 *
 * Usage:
 *   const db = require("./db");
 *   db.init("opencompletions.db");  // creates tables if needed
 *   db.logRun({ ... });
 *   db.listRuns({ limit: 50 });
 */

const { randomUUID } = require("crypto");

let sqlite = null;

function init(dbPath) {
  if (!dbPath) return;
  try {
    const Database = require("better-sqlite3");
    sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("busy_timeout = 5000");
    migrate();
    console.log(`[db] Opened ${dbPath}`);
  } catch (err) {
    console.error(`[db] Failed to open ${dbPath}: ${err.message}`);
    sqlite = null;
  }
}

function migrate() {
  if (!sqlite) return;
  const version = sqlite.pragma("user_version", { simple: true });

  if (version < 1) {
    sqlite.exec(`
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
        started_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_runs_started ON agent_runs(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_runs_key ON agent_runs(api_key_id);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON agent_runs(status);
      PRAGMA user_version = 1;
    `);
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function logRunStart({ apiKeyId, orgId, sessionId, workspaceId, prompt, systemPrompt, backend }) {
  if (!sqlite) return null;
  const id = randomUUID();
  const now = Date.now();
  sqlite.prepare(`
    INSERT INTO agent_runs (id, api_key_id, org_id, session_id, workspace_id, prompt, system_prompt, backend, status, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
  `).run(id, apiKeyId || null, orgId || null, sessionId || null, workspaceId || null,
    prompt || null, systemPrompt || null, backend || null, now);
  return id;
}

function logRunComplete(runId, { sessionId, numTurns, totalCostUsd, usage, error }) {
  if (!sqlite || !runId) return;
  const status = error ? "error" : "completed";
  sqlite.prepare(`
    UPDATE agent_runs
    SET status = ?, session_id = COALESCE(?, session_id), num_turns = ?, total_cost_usd = ?,
        usage_json = ?, error_message = ?, completed_at = ?
    WHERE id = ?
  `).run(status, sessionId || null, numTurns || null, totalCostUsd || null,
    usage ? JSON.stringify(usage) : null, error || null, Date.now(), runId);
}

function listRuns({ limit = 50, offset = 0, apiKeyId, orgId, status } = {}) {
  if (!sqlite) return { runs: [], total: 0 };

  let where = "1=1";
  const params = [];
  if (apiKeyId) { where += " AND api_key_id = ?"; params.push(apiKeyId); }
  if (orgId) { where += " AND org_id = ?"; params.push(orgId); }
  if (status) { where += " AND status = ?"; params.push(status); }

  const total = sqlite.prepare(`SELECT COUNT(*) as c FROM agent_runs WHERE ${where}`).get(...params).c;
  const runs = sqlite.prepare(`
    SELECT id, api_key_id, org_id, session_id, workspace_id,
           prompt, backend, status, num_turns, total_cost_usd,
           error_message, started_at, completed_at
    FROM agent_runs WHERE ${where} ORDER BY started_at DESC LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return { runs, total };
}

function getRun(id) {
  if (!sqlite) return null;
  return sqlite.prepare("SELECT * FROM agent_runs WHERE id = ?").get(id) || null;
}

function getStats({ apiKeyId, orgId, since } = {}) {
  if (!sqlite) return null;

  let where = "1=1";
  const params = [];
  if (apiKeyId) { where += " AND api_key_id = ?"; params.push(apiKeyId); }
  if (orgId) { where += " AND org_id = ?"; params.push(orgId); }
  if (since) { where += " AND started_at >= ?"; params.push(since); }

  return sqlite.prepare(`
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
  `).get(...params);
}

function close() {
  if (sqlite) {
    sqlite.close();
    sqlite = null;
  }
}

module.exports = { init, logRunStart, logRunComplete, listRuns, getRun, getStats, close };
