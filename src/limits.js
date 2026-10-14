// src/limits.js — account-safety limits that are refreshed from the web, not hard-coded.
//
// The one we care about most: LinkedIn's Easy Apply daily submission cap. LinkedIn does NOT
// publish the exact number and it resets at the end of the day (UTC); community reporting in
// 2026 converges on ~50 submissions / 24h (older sources say 100–150). Over-applying — or
// applying in fast, bot-like bursts — is what gets accounts restricted.
//
// So JobPilot:
//   • assumes a conservative default (50/day), refreshable from the internet once a day;
//   • stops Easy Apply at a safety buffer (default 80% → 40/day) rather than at the real cap;
//   • NEVER raises the cap on a bad/implausible fetch — it only ever keeps the last good value
//     or the conservative default, and every stored number is sanity-bounded.
//
// This file holds ZERO personal data. The learned number lives in data/easyapply-limit.json
// (gitignored) — never committed.
import fs from 'fs';
import path from 'path';
import { DATA } from './config.js';

const LIMIT_FILE = path.join(DATA, 'easyapply-limit.json');

// Conservative defaults + hard sanity bounds. A fetched number outside [MIN,MAX] is ignored,
// and the effective cap is never allowed above HARD_CEIL no matter what a source claims.
export const EASY_APPLY_DEFAULTS = Object.freeze({ dailyLimit: 50, safetyBuffer: 0.8 });
const MIN_LIMIT = 20;
const MAX_LIMIT = 200;
const HARD_CEIL = 80;      // never let the effective cap exceed this, ever
const STALE_MS = 24 * 3600 * 1000;

/**
 * Compute the effective (safety-buffered) Easy Apply cap from a daily limit + buffer.
 * Always clamped to [1, HARD_CEIL].
 * @param {number} dailyLimit
 * @param {number} safetyBuffer - fraction in (0,1], e.g. 0.8 = stop at 80%
 * @returns {number}
 */
export function computeEffectiveCap(dailyLimit, safetyBuffer) {
  const dl = Number.isFinite(dailyLimit) ? dailyLimit : EASY_APPLY_DEFAULTS.dailyLimit;
  const sb = Number.isFinite(safetyBuffer) && safetyBuffer > 0 && safetyBuffer <= 1
    ? safetyBuffer : EASY_APPLY_DEFAULTS.safetyBuffer;
  return Math.max(1, Math.min(HARD_CEIL, Math.floor(dl * sb)));
}

function readStore() {
  try { return JSON.parse(fs.readFileSync(LIMIT_FILE, 'utf8')); } catch { return null; }
}

/**
 * Read the current Easy Apply limit state. Falls back to conservative defaults when the file
 * is missing or corrupt. `stale` is true when the value is missing or older than 24h — the
 * caller should trigger a refresh.
 * @returns {{dailyLimit:number, safetyBuffer:number, effectiveCap:number, source:string, checkedAt:(string|null), stale:boolean}}
 */
export function getEasyApplyLimit() {
  const s = readStore() || {};
  let dailyLimit = Number(s.dailyLimit);
  if (!Number.isFinite(dailyLimit) || dailyLimit < MIN_LIMIT || dailyLimit > MAX_LIMIT) {
    dailyLimit = EASY_APPLY_DEFAULTS.dailyLimit;
  }
  let safetyBuffer = Number(s.safetyBuffer);
  if (!Number.isFinite(safetyBuffer) || safetyBuffer <= 0 || safetyBuffer > 1) {
    safetyBuffer = EASY_APPLY_DEFAULTS.safetyBuffer;
  }
  const checkedAt = typeof s.checkedAt === 'string' ? s.checkedAt : null;
  const ageOk = checkedAt && (Date.now() - Date.parse(checkedAt) < STALE_MS);
  return {
    dailyLimit,
    safetyBuffer,
    effectiveCap: computeEffectiveCap(dailyLimit, safetyBuffer),
    source: typeof s.source === 'string' ? s.source : 'default',
    checkedAt,
    stale: !ageOk,
  };
}

/**
 * Persist a researched Easy Apply daily limit. Sanity-bounds the number to [MIN,MAX]; an
 * out-of-range or non-numeric value is REJECTED (the previous/default value is kept) so a bad
 * fetch can never raise the cap. Writes atomically with a fresh UTC timestamp.
 * @param {{dailyLimit:number, safetyBuffer?:number, source?:string}} input
 * @returns {{stored:boolean, reason?:string} & ReturnType<typeof getEasyApplyLimit>}
 */
export function setEasyApplyLimit({ dailyLimit, safetyBuffer, source } = {}) {
  const current = getEasyApplyLimit();
  const dl = Number(dailyLimit);
  if (!Number.isFinite(dl) || dl < MIN_LIMIT || dl > MAX_LIMIT) {
    return { ...current, stored: false, reason: `rejected dailyLimit=${dailyLimit} (outside [${MIN_LIMIT},${MAX_LIMIT}])` };
  }
  let sb = Number(safetyBuffer);
  if (!Number.isFinite(sb) || sb <= 0 || sb > 1) sb = current.safetyBuffer;
  sb = Math.max(0.3, Math.min(0.95, sb));
  const record = {
    dailyLimit: Math.round(dl),
    safetyBuffer: sb,
    effectiveCap: computeEffectiveCap(dl, sb),
    source: source || 'manual',
    checkedAt: new Date().toISOString(),
  };
  try {
    fs.mkdirSync(DATA, { recursive: true });
    const tmp = LIMIT_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
    fs.renameSync(tmp, LIMIT_FILE);
  } catch (e) {
    return { ...current, stored: false, reason: 'write failed: ' + e.message };
  }
  return { ...record, stale: false, stored: true };
}

// ── Web refresh ────────────────────────────────────────────────────────────────

// Public pages whose body text states the current Easy Apply per-day number. These are read as
// plain text and a number is extracted ONLY when it sits next to apply/easy-apply + per-day
// wording, so connection/message limits on the same page never contaminate the result.
const SOURCES = [
  'https://www.loopcv.pro/guides/linkedin-easy-apply-limit/',
  'https://blog.fastapply.co/fastapply-vs-linkedin-easy-apply-2026',
  'https://www.lobstr.io/blog/linkedin-limits',
];

/**
 * Pull candidate "N per day" Easy Apply numbers out of a blob of page text.
 * Only counts numbers that appear within a short window of both an apply-ish word and a
 * per-day/24h word, bounded to [MIN,MAX]. Returns a de-duped array of integers.
 * @param {string} text
 * @returns {number[]}
 */
export function parseLimitsFromText(text = '') {
  const t = String(text).replace(/\s+/g, ' ').toLowerCase();
  const out = new Set();
  // e.g. "around 50 easy apply submissions per day", "50 applications per 24 hours",
  //      "caps easy apply at approximately 50 per day"
  const re = /(easy[ -]?apply|applications?|submissions?|appl[a-z]*)[^.]{0,40}?\b(\d{2,3})\b[^.]{0,25}?(per day|\/ ?day|a day|per 24|24[ -]?hour|daily)/g;
  const re2 = /\b(\d{2,3})\b[^.]{0,25}?(easy[ -]?apply|applications?|submissions?)[^.]{0,25}?(per day|\/ ?day|a day|per 24|24[ -]?hour|daily)/g;
  for (const rx of [re, re2]) {
    let m;
    while ((m = rx.exec(t))) {
      const n = Number(m[2] || m[1]);
      if (Number.isFinite(n) && n >= MIN_LIMIT && n <= MAX_LIMIT) out.add(n);
    }
  }
  return [...out];
}

/**
 * Research the current Easy Apply daily limit from the web and store the most conservative
 * credible value found. Pure safety: on ANY failure, no parse, or implausible data it returns
 * the current value UNCHANGED (never raises the cap). Never throws.
 * @param {{fetchImpl?:Function, sources?:string[], safetyBuffer?:number}} [opts]
 * @returns {Promise<ReturnType<typeof getEasyApplyLimit> & {stored:boolean, found?:number[], source?:string, reason?:string}>}
 */
export async function refreshEasyApplyLimitFromWeb({ fetchImpl, sources = SOURCES, safetyBuffer } = {}) {
  const before = getEasyApplyLimit();
  let fetchFn = fetchImpl;
  if (!fetchFn) {
    try { fetchFn = (await import('node-fetch')).default; } catch { return { ...before, stored: false, reason: 'node-fetch unavailable' }; }
  }
  const found = [];
  let chosenSource = '';
  for (const url of sources) {
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetchFn(url, { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 JobPilot-safety' } }).catch(() => null);
      clearTimeout(to);
      if (!res || !res.ok) continue;
      const html = await res.text();
      const nums = parseLimitsFromText(html);
      if (nums.length) { found.push(...nums); if (!chosenSource) chosenSource = url; }
    } catch { /* ignore this source */ }
  }
  if (!found.length) return { ...before, stored: false, reason: 'no credible number parsed', found };
  // Conservative: pick the lowest credible value (safer for the account), but never below 30
  // to avoid a stray low number making the tool uselessly cautious.
  const chosen = Math.max(30, Math.min(...found));
  const saved = setEasyApplyLimit({ dailyLimit: chosen, safetyBuffer: safetyBuffer ?? before.safetyBuffer, source: chosenSource || 'web' });
  return { ...saved, found };
}

/**
 * Refresh only if the stored value is stale (>24h). Fire-and-forget friendly; never throws.
 * @returns {Promise<{refreshed:boolean, limit:ReturnType<typeof getEasyApplyLimit>}>}
 */
export async function maybeRefreshEasyApplyLimit() {
  const cur = getEasyApplyLimit();
  if (!cur.stale) return { refreshed: false, limit: cur };
  try {
    const r = await refreshEasyApplyLimitFromWeb();
    return { refreshed: !!r.stored, limit: getEasyApplyLimit() };
  } catch {
    return { refreshed: false, limit: cur };
  }
}
