// scripts/refresh-easyapply-limit.mjs — refresh the learned LinkedIn Easy Apply daily limit
// from the public web and store it in data/easyapply-limit.json (gitignored).
//
// Safe by construction: a failed/offline fetch or an implausible number never raises the cap —
// the previous (or conservative default) value is kept. Exits 0 even when it falls back, so it
// is safe to run on a daily schedule, hands-free, from the always-on worker.
//
// Usage: node scripts/refresh-easyapply-limit.mjs
import { refreshEasyApplyLimitFromWeb, getEasyApplyLimit } from '../src/limits.js';

const before = getEasyApplyLimit();
console.log(`[easyapply-limit] before: dailyLimit=${before.dailyLimit} effectiveCap=${before.effectiveCap} source=${before.source} checkedAt=${before.checkedAt || 'never'}`);

const r = await refreshEasyApplyLimitFromWeb().catch(e => ({ stored: false, reason: e.message }));

if (r.stored) {
  console.log(`[easyapply-limit] updated: dailyLimit=${r.dailyLimit} effectiveCap=${r.effectiveCap} (safety buffer ${Math.round(r.safetyBuffer * 100)}%) source=${r.source}`);
  if (r.found) console.log(`[easyapply-limit] candidates seen: ${r.found.join(', ')}`);
} else {
  const now = getEasyApplyLimit();
  console.log(`[easyapply-limit] kept existing value (${r.reason || 'no change'}): dailyLimit=${now.dailyLimit} effectiveCap=${now.effectiveCap}`);
}

process.exit(0);
