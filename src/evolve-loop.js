// src/evolve-loop.js — Background self-evolution loop for the MCP server.
//
// When the agent is driving via the MCP server (no always-on worker running), this keeps the
// self-evolution + recontribution happening automatically on a timer — so "hunt + self-evolve
// + PR" works in agent-only mode too, not just under `npm run worker`.
//
// DOUBLE-CONTRIBUTION GUARD: if the always-on worker is running (fresh heartbeat in
// data/worker-state.json), THIS loop stands down and lets the worker own the contribute loop —
// so you never get two processes opening redundant PRs at once.
//
// Disable entirely with env JOBPILOT_MCP_AUTOEVOLVE=0.
import fs from 'fs';
import path from 'path';
import { DATA } from './config.js';
import { getProfile } from './profile.js';

const STATE = path.join(DATA, 'worker-state.json');
const log = (...a) => console.error('[mcp-evolve] ' + a.join(' '));

/** @returns {boolean} true if the always-on worker is alive (heartbeat < 2 min old). */
export function workerIsLive() {
  try {
    const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    return st.ts ? (Date.now() - Date.parse(st.ts)) < 2 * 60000 : false;
  } catch { return false; }
}

/**
 * Start the background evolution loop. Non-blocking; returns a stop() function.
 * @param {object} [opts]
 * @param {number} [opts.syncMs]     - how often to sync + review/merge PRs (default 10 min)
 * @param {number} [opts.contribMs]  - how often to run the full contribute round (default 20 min)
 * @param {number} [opts.dashMs]     - how often to refresh the dashboard (default 45 s)
 * @returns {() => void} stop function
 */
export function startBackgroundEvolve({ syncMs = 2 * 60000, contribMs = 10 * 60000, dashMs = 45000 } = {}) {
  if (process.env.JOBPILOT_MCP_AUTOEVOLVE === '0') { log('disabled via JOBPILOT_MCP_AUTOEVOLVE=0'); return () => {}; }

  let lastSync = 0, lastContrib = 0, stopped = false;

  const tick = async () => {
    if (stopped) return;
    // Always keep the dashboard fresh (cheap, local, safe even alongside the worker).
    try { const { writeDash } = await import('./dashboard.js'); writeDash(); } catch {}
    try { const { writePlaybook } = await import('./evolve.js'); writePlaybook(); } catch {}

    // Contribute/sync ONLY when the worker isn't the one doing it (avoid double-contribution),
    // and only when the user has left self-contribution on.
    const consentOn = getProfile().consent?.autoContribute !== false;
    if (consentOn && !workerIsLive()) {
      const now = Date.now();
      try {
        const { syncBranch, repoInfo, reviewAndMergePRs, contributeRound } = await import('./contribute.js');
        // ~10 min: keep in sync + (main repo) review & merge open PRs
        if (now - lastSync > syncMs) {
          lastSync = now;
          const info = await repoInfo();
          const s = await syncBranch();
          if (s.advanced) log(`pulled newer upstream version (in sync with ${s.upstream || 'origin'})`);
          if (!info.isFork) {
            const rev = await reviewAndMergePRs();
            if (rev.merged?.length) log(`reviewed + merged PRs: ${rev.merged.join(', ')}`);
            if (rev.closed?.length) log(`closed empty/redundant PRs: ${rev.closed.join(', ')}`);
          }
        }
        // ~20 min: full contribute round (sync → file issues → PR / review+merge)
        if (now - lastContrib > contribMs) {
          lastContrib = now;
          const r = await contributeRound();
          if (r.pr?.pr) log(`opened self-evolve PR: ${r.pr.pr}`);
          if (r.review?.merged?.length) log(`merged PRs: ${r.review.merged.join(', ')}`);
          if (r.issues?.filed?.length) log(`filed issues: ${r.issues.filed.join(', ')}`);
        }
      } catch (e) { log('tick skip: ' + (e.message || e).toString().slice(0, 100)); }
    }
  };

  // Fire an initial tick shortly after boot, then on the dashboard cadence.
  const kick = setTimeout(() => { tick().catch(() => {}); }, 15000);
  const iv = setInterval(() => { tick().catch(() => {}); }, dashMs);
  log(`background self-evolution armed (sync ~${Math.round(syncMs / 60000)}m, contribute ~${Math.round(contribMs / 60000)}m; stands down while the worker is live)`);

  return () => { stopped = true; clearTimeout(kick); clearInterval(iv); };
}
