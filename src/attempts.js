// src/attempts.js — Per-job attempt + per-step recording.
// Uses the SAME in-memory DB handle as tracker.js (two handles = each save()
// overwrote the other's writes). Tables are created in tracker.initDB().
import { initDB, rows, one, save, getDB } from './tracker.js';

export async function initAttempts() { await initDB(); }

/** Record one step with timing + attempt number. */
export function recordStep({ tool, target = '', args = {}, outcome, detail = '', attempt = 1, durationMs = 0, timeoutMs = 0 }) {
  const db = getDB();
  db.run(
    `INSERT INTO steps (tool,target,args,outcome,detail,attempt,duration_ms,timeout_ms) VALUES (?,?,?,?,?,?,?,?)`,
    [tool, target, JSON.stringify(args).slice(0, 1000), outcome, (detail || '').slice(0, 500), attempt, durationMs, timeoutMs]
  );
  db.run(
    `INSERT INTO attempt_counts (key,attempts,last_ts,last_outcome) VALUES (?,1,datetime('now'),?)
     ON CONFLICT(key) DO UPDATE SET attempts=attempts+1, last_ts=datetime('now'), last_outcome=?`,
    [`${tool}:::${target}`, outcome, outcome]
  );
  save();
}

export function attemptCount(tool, target) {
  return one(`SELECT attempts FROM attempt_counts WHERE key=?`, [`${tool}:::${target}`])?.attempts || 0;
}
export function canAttempt(tool, target, maxAttempts = 3) { return attemptCount(tool, target) < maxAttempts; }
export function recentSteps(limit = 200) { return rows(`SELECT * FROM steps ORDER BY id DESC LIMIT ?`, [limit]); }
export function stepStats() {
  return {
    total: one('SELECT COUNT(*) n FROM steps')?.n || 0,
    byOutcome: rows('SELECT outcome, COUNT(*) n FROM steps GROUP BY outcome ORDER BY n DESC'),
    byTool: rows('SELECT tool, outcome, COUNT(*) n, AVG(duration_ms) avg_ms FROM steps GROUP BY tool, outcome ORDER BY n DESC'),
    timeouts: one("SELECT COUNT(*) n FROM steps WHERE outcome='timeout'")?.n || 0,
  };
}
