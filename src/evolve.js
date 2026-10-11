// src/evolve.js — the self-evolution memory.
//
// Three loops, all persisted in the same SQLite DB (gitignored, per-user):
//   1. ENCOUNTERS  — every failure/oddity, keyed by (area, signature). Count, last seen,
//                    a DOM snapshot + screenshot, and status open|learned|fixed. Your coding
//                    agent reads data/evolution/PLAYBOOK.md, patches the code, marks fixed.
//   2. ANSWERS     — application questions → answers. Sources: user, agent, harvested
//                    (LinkedIn prefilled values = your own past answers), inferred, default.
//                    Unknown questions become "questions for you" and are asked ONCE.
//   3. STRATEGY    — outcomes per (lane, key) e.g. query / domain / ATS. Used to weight
//                    query rotation (UCB bandit) and to auto-skip domains that keep failing.
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { rows, one, save, getDB } from './tracker.js';
import { DATA } from './config.js';

const EVO_DIR = path.join(DATA, 'evolution');
fs.mkdirSync(EVO_DIR, { recursive: true });
const h = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);

export function initEvolve() {
  const db = getDB();
  db.run(`
    CREATE TABLE IF NOT EXISTS encounters (
      id INTEGER PRIMARY KEY AUTOINCREMENT, area TEXT, signature TEXT, domain TEXT, detail TEXT,
      sample_url TEXT, snapshot TEXT, count INTEGER DEFAULT 1, status TEXT DEFAULT 'open',
      first_seen TEXT DEFAULT (datetime('now')), last_seen TEXT DEFAULT (datetime('now')), resolution TEXT DEFAULT '',
      UNIQUE(area, signature));
    CREATE TABLE IF NOT EXISTS answers (
      qkey TEXT PRIMARY KEY, question TEXT, answer TEXT, source TEXT, uses INTEGER DEFAULT 0,
      wins INTEGER DEFAULT 0, pending INTEGER DEFAULT 0, seen INTEGER DEFAULT 1, options TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS strategy (
      lane TEXT, key TEXT, tries INTEGER DEFAULT 0, wins INTEGER DEFAULT 0, yield INTEGER DEFAULT 0,
      last TEXT DEFAULT (datetime('now')), PRIMARY KEY (lane, key));
  `);
  save();
}

// ── 1. Encounters ────────────────────────────────────────────────────────────
/** Normalize volatile bits (ids, numbers, urls) so the same problem groups together. */
export function signatureOf(detail = '') {
  return String(detail).toLowerCase().replace(/https?:\/\/\S+/g, '<url>').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 140);
}
export function domainOf(url = '') { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }

/** Record something the agent couldn't handle. Optionally snapshots the page for later diagnosis. */
export async function encounter(area, detail, { url = '', page = null, scope = null } = {}) {
  const sig = signatureOf(detail);
  const domain = domainOf(url);
  let snapshot = '';
  if (page) {
    try {
      const base = path.join(EVO_DIR, `${area}-${h(area + sig)}`);
      if (!fs.existsSync(base + '.png')) {
        await page.screenshot({ path: base + '.png' }).catch(() => {});
        const html = await (scope || page.locator('body')).evaluate(el => el.outerHTML).catch(() => '');
        fs.writeFileSync(base + '.html', html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>/g, '').slice(0, 200000));
      }
      snapshot = path.relative(DATA, base);
    } catch {}
  }
  const db = getDB();
  db.run(`INSERT INTO encounters (area, signature, domain, detail, sample_url, snapshot) VALUES (?,?,?,?,?,?)
          ON CONFLICT(area, signature) DO UPDATE SET count=count+1, last_seen=datetime('now'), detail=excluded.detail,
          sample_url=excluded.sample_url, snapshot=CASE WHEN excluded.snapshot!='' THEN excluded.snapshot ELSE snapshot END,
          status=CASE WHEN status='fixed' THEN 'regressed' ELSE status END`,
    [area, sig, domain, String(detail).slice(0, 600), url, snapshot]);
  save();
}
export function resolveEncounter(id, resolution, status = 'fixed') {
  getDB().run(`UPDATE encounters SET status=?, resolution=? WHERE id=?`, [status, resolution, id]); save();
}
export function openEncounters(limit = 50) {
  return rows(`SELECT * FROM encounters WHERE status IN ('open','regressed') ORDER BY count DESC, last_seen DESC LIMIT ?`, [limit]);
}

// ── 2. Answers ───────────────────────────────────────────────────────────────
const STOP = new Set('a an the of to for in on with do you your are is have has what how many which please our this that we be as at or and if any'.split(' '));
export function qkey(q = '') {
  return String(q).toLowerCase().replace(/[*?:()\[\].,!"'’]/g, ' ').replace(/\s+/g, ' ').trim()
    .split(' ').filter(w => w && !STOP.has(w)).slice(0, 18).join(' ');
}
function sim(a, b) {
  const A = new Set(a.split(' ')), B = new Set(b.split(' '));
  let i = 0; for (const w of A) if (B.has(w)) i++;
  return i / Math.max(1, Math.min(A.size, B.size) + Math.abs(A.size - B.size) * 0.5);
}
/** Best learned answer for a question (exact key, else fuzzy ≥0.8). Skips pending (unanswered) rows. */
export function learnedAnswer(question) {
  const k = qkey(question);
  if (!k) return null;
  const exact = one(`SELECT * FROM answers WHERE qkey=? AND answer!='' AND pending=0`, [k]);
  if (exact) return exact.answer;
  let best = null, bs = 0;
  for (const r of rows(`SELECT qkey, answer, source FROM answers WHERE answer!='' AND pending=0`)) {
    const s = sim(k, r.qkey); if (s > bs) { bs = s; best = r; }
  }
  return bs >= 0.8 ? best.answer : null;
}
/** Teach an answer. source: user | agent | harvested | inferred | default. User beats everything. */
export function learn(question, answer, source = 'agent') {
  const k = qkey(question); if (!k || answer == null) return;
  const rank = { default: 0, inferred: 1, harvested: 2, agent: 3, user: 4 };
  const cur = one(`SELECT source, pending FROM answers WHERE qkey=?`, [k]);
  if (cur && !cur.pending && (rank[cur.source] ?? 0) > (rank[source] ?? 0)) return;
  getDB().run(`INSERT INTO answers (qkey, question, answer, source, pending) VALUES (?,?,?,?,0)
     ON CONFLICT(qkey) DO UPDATE SET answer=excluded.answer, source=excluded.source, pending=0, updated_at=datetime('now')`,
    [k, String(question).slice(0, 300), String(answer).slice(0, 2000), source]);
  save();
}
/** Mark a question we could not answer → it shows up under "Questions for you". */
export function askLater(question, options = []) {
  const k = qkey(question); if (!k) return;
  getDB().run(`INSERT INTO answers (qkey, question, answer, source, pending, options) VALUES (?,?,'', 'pending', 1, ?)
     ON CONFLICT(qkey) DO UPDATE SET seen=seen+1, options=CASE WHEN excluded.options!='' THEN excluded.options ELSE options END`,
    [k, String(question).slice(0, 300), options.slice(0, 12).join(' | ')]);
  save();
}
export function pendingQuestions(limit = 40) { return rows(`SELECT * FROM answers WHERE pending=1 ORDER BY seen DESC LIMIT ?`, [limit]); }
export function allAnswers() { return rows(`SELECT * FROM answers WHERE pending=0 ORDER BY uses DESC, updated_at DESC`); }
export function usedAnswer(question) { getDB().run(`UPDATE answers SET uses=uses+1 WHERE qkey=?`, [qkey(question)]); }

// ── 3. Strategy (bandit + learned skips) ─────────────────────────────────────
export function outcome(lane, key, { win = false, yieldN = 0 } = {}) {
  if (!key) return;
  getDB().run(`INSERT INTO strategy (lane, key, tries, wins, yield) VALUES (?,?,1,?,?)
     ON CONFLICT(lane, key) DO UPDATE SET tries=tries+1, wins=wins+excluded.wins, yield=yield+excluded.yield, last=datetime('now')`,
    [lane, key, win ? 1 : 0, yieldN]);
  save();
}
/** UCB1 ranking of candidate keys by average yield (unseen keys are explored first). */
export function rankByUCB(lane, keys) {
  const st = Object.fromEntries(rows(`SELECT key, tries, yield FROM strategy WHERE lane=?`, [lane]).map(r => [r.key, r]));
  const total = Object.values(st).reduce((a, r) => a + r.tries, 0) + 1;
  return [...keys].map(k => {
    const r = st[k];
    const ucb = !r ? 1e9 : r.yield / r.tries + 2 * Math.sqrt(Math.log(total) / r.tries);
    return { k, ucb: ucb + Math.random() * 0.01 };
  }).sort((a, b) => b.ucb - a.ucb).map(x => x.k);
}
/** Domains that failed ≥4 times with zero wins are skipped (learned), until reset. */
export function learnedSkip(lane, key) {
  const r = one(`SELECT tries, wins FROM strategy WHERE lane=? AND key=?`, [lane, key]);
  return !!r && r.tries >= 4 && r.wins === 0;
}
export function strategyTable(lane) { return rows(`SELECT * FROM strategy WHERE lane=? ORDER BY tries DESC LIMIT 60`, [lane]); }

// ── Playbook for the coding agent ────────────────────────────────────────────
export function writePlaybook() {
  const enc = openEncounters(40);
  const pq = pendingQuestions(30);
  const fails = rows(`SELECT lane, key, tries, wins FROM strategy WHERE lane LIKE '%domain' AND tries>=3 ORDER BY (wins*1.0/tries) ASC, tries DESC LIMIT 20`);
  const md = `# Evolution playbook (auto-generated ${new Date().toISOString()})

Read this at the start of every session. Fix the top encounters in code, teach answers
with the \`learn_answer\` tool (or ask the user), then \`resolve_encounter\`.

## Open encounters (most frequent first)
${enc.map(e => `- [#${e.id}] **${e.area}** ×${e.count} · ${e.domain || '-'} · \`${e.signature}\`${e.snapshot ? ` · snapshot: data/${e.snapshot}.{png,html}` : ''}${e.sample_url ? `\n  sample: ${e.sample_url}` : ''}`).join('\n') || '- none 🎉'}

## Questions waiting for the user (asked once, remembered forever)
${pq.map(q => `- (${q.seen}×) ${q.question}${q.options ? ` — options: ${q.options}` : ''}`).join('\n') || '- none'}

## Low-success domains / ATS
${fails.map(f => `- ${f.lane} ${f.key}: ${f.wins}/${f.tries}`).join('\n') || '- none'}
`;
  fs.writeFileSync(path.join(EVO_DIR, 'PLAYBOOK.md'), md);
  return md;
}
