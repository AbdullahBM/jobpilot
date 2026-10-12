// src/contribute.js — the "self-improving repository" loop.
//
// JobPilot contributes its OWN improvements back to the public repo automatically:
//   • pushes CODE/doc changes (src/, docs, *.md, mcp-server.js, start.js, package.json)
//   • files GitHub issues for blockers it discovers in the evolution memory
// It NEVER commits personal data or credentials. A hard allowlist + a sensitive-path
// tripwire abort the push if anything under data/, .env*, drafts/, applied/, logs/, or a
// screenshot/db ever reaches the index. Safe to run unattended.
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { ROOT, DATA } from './config.js';
import { openEncounters, resolveEncounter } from './evolve.js';

const run = promisify(execFile);
// Commit identity for self-contributions — the repo owner, so contributions are attributed
// to YOU on GitHub (uses your public handle + a noreply email; no personal email is leaked).
// Read from git config (set once at repo init); falls back to the owner handle.
const git = (...a) => run('git', a, { cwd: ROOT }).then(r => r.stdout.trim()).catch(e => { throw new Error((e.stderr || e.stdout || e.message).slice(0, 300)); });
const gh = (...a) => run('gh', a, { cwd: ROOT }).then(r => r.stdout.trim());

// Only these top-level paths may ever be committed by the auto-contributor.
const ALLOW = [/^src\//, /^docs\//, /^scripts\//, /^\.github\//, /^[^/]+\.md$/, /^mcp-server\.js$/, /^start\.js$/, /^package(-lock)?\.json$/, /^\.gitignore$/, /^\.env\.example$/, /^LICENSE$/];
// If ANY of these ever appear staged, abort hard.
const DENY = [/^data\//, /^\.env$/, /^\.env\.[^x]/, /\.env$/, /^drafts\//, /^applied\//, /^logs\//, /\.log$/, /jobs\.db$/, /profile\.json$/, /chrome-debug/, /\.png$/, /\.html$/, /uploads\//];

async function staged() { return (await git('diff', '--cached', '--name-only')).split('\n').filter(Boolean); }

/** Stage ONLY allowlisted paths, then abort if anything sensitive slipped in. */
async function safeStage() {
  await git('add', '--', 'src', 'docs', 'scripts', '.github', 'mcp-server.js', 'start.js', 'package.json', 'package-lock.json', '.gitignore', '.env.example', 'LICENSE', 'README.md', 'AGENTS.md', 'CONTRIBUTING.md').catch(() => {});
  const files = await staged();
  const bad = files.filter(f => DENY.some(re => re.test(f)) || !ALLOW.some(re => re.test(f)));
  if (bad.length) { await git('reset').catch(() => {}); throw new Error('ABORT: non-allowlisted/sensitive paths staged: ' + bad.slice(0, 8).join(', ')); }
  return files;
}

// ── Upstream / fork topology ───────────────────────────────────────────────────
/** Figure out where PRs should go: the parent repo if this is a fork, else origin itself. */
export async function repoInfo() {
  try {
    const j = JSON.parse(await gh('repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,parent'));
    const upstream = j.parent ? j.parent.nameWithOwner : j.nameWithOwner;
    return { origin: j.nameWithOwner, owner: j.nameWithOwner.split('/')[0], upstream, base: j.defaultBranchRef?.name || 'main', isFork: !!j.parent };
  } catch {
    return { origin: '', owner: '', upstream: '', base: 'main', isFork: false };
  }
}

/**
 * Keep the local branch IN SYNC with upstream before doing anything:
 *  - add an `upstream` remote when this is a fork,
 *  - fetch upstream, rebase local base onto upstream/base (fast, conflict-safe: aborts cleanly),
 *  - when forked, push the fork's base back up so the fork stays current too.
 */
export async function syncBranch() {
  const info = await repoInfo();
  const { base, upstream, isFork } = info;
  try {
    if (isFork && upstream) {
      const remotes = await git('remote').catch(() => '');
      if (!/\bupstream\b/.test(remotes)) await git('remote', 'add', 'upstream', `https://github.com/${upstream}.git`).catch(() => {});
      await git('fetch', 'upstream', base).catch(() => {});
      await git('checkout', base).catch(() => {});
      const before = await git('rev-parse', 'HEAD').catch(() => '');
      const r = await git('rebase', `upstream/${base}`).catch(async () => { await git('rebase', '--abort').catch(() => {}); return 'conflict'; });
      if (r === 'conflict') return { ...info, synced: false, reason: 'rebase conflict (left as-is)' };
      const after = await git('rev-parse', 'HEAD').catch(() => '');
      if (before !== after) await git('push', 'origin', base).catch(() => {}); // keep the fork current
      return { ...info, synced: true, advanced: before !== after };
    }
    // owner / non-fork: fast-forward local base to origin
    await git('fetch', 'origin', base).catch(() => {});
    await git('checkout', base).catch(() => {});
    await git('merge', '--ff-only', `origin/${base}`).catch(() => {});
    return { ...info, synced: true };
  } catch (e) {
    return { ...info, synced: false, reason: e.message };
  }
}

/**
 * Commit + push code/doc improvements. Returns {pushed, files} or {pushed:false,reason}.
 */
export async function contributeCode(message, { push = true } = {}) {
  let files;
  try { files = await safeStage(); } catch (e) { return { pushed: false, reason: e.message }; }
  if (!files.length) return { pushed: false, reason: 'nothing to contribute' };
  await git('commit', '-m', message);
  if (!push) return { pushed: false, committed: true, files };
  try { await git('push', 'origin', 'HEAD'); } catch (e) { return { pushed: false, committed: true, files, reason: 'push failed: ' + e.message }; }
  return { pushed: true, files };
}

/**
 * Contribute improvements as a PULL REQUEST to the main (upstream) repo — immediately.
 * Works for forks (opens a cross-fork PR to the parent) and for the owner (PR to main so it
 * goes through the automated review + security gate). Hard-guarded against data/creds.
 * Returns { pr } | { pushed:false, reason }.
 */
export async function contributeViaPR(message) {
  const info = await repoInfo();
  const { base, upstream, owner, isFork } = info;
  const startBranch = (await git('rev-parse', '--abbrev-ref', 'HEAD').catch(() => base)) || base;
  const branch = `self-evolve/${Date.now()}`;
  try {
    // stage first; if nothing allowlisted changed, don't open an empty PR
    let files;
    try { files = await safeStage(); } catch (e) { return { pushed: false, reason: e.message }; }
    if (!files.length) return { pushed: false, reason: 'nothing to contribute' };
    await git('reset').catch(() => {});            // unstage; commit on a fresh branch instead
    await git('checkout', '-b', branch);
    await safeStage();                              // re-stage on the new branch (re-checks the guard)
    await git('commit', '-m', message);
    await git('push', '-u', 'origin', branch);
    const head = isFork ? `${owner}:${branch}` : branch;
    const body = 'Automated self-evolution contribution from JobPilot.\n\n' +
      '- Only allowlisted code/doc paths (never `data/`, `.env`, drafts, logs, screenshots, or the DB).\n' +
      '- Gated by the security review workflow before merge.\n\n_Files: ' + files.join(', ') + '_';
    const url = await gh('pr', 'create', '--repo', upstream, '--base', base, '--head', head, '--title', message, '--body', body, '--label', 'self-evolve');
    await gh('pr', 'merge', '--auto', '--squash', url).catch(() => {}); // auto-merge once checks pass
    return { pr: url, files };
  } catch (e) {
    return { pushed: false, reason: e.message };
  } finally {
    await git('checkout', startBranch).catch(() => {});
  }
}

// Curated issue bodies for the blockers we understand; keyed by a signature matcher.
const BLOCKER_RULES = [
  { match: /indeed/i,                         title: 'Blocker: Indeed anti-bot / login wall — can\'t auto-apply', labels: 'blocker', file: 'docs/issue-indeed.md' },
  { match: /glassdoor/i,                      title: 'Blocker: Glassdoor login + anti-bot wall — can\'t auto-apply', labels: 'blocker', file: 'docs/issue-glassdoor.md' },
  { match: /workday|icims|taleo|successfactors|oraclecloud|brassring/i, title: 'Account-gated ATS adapters: Workday / iCIMS / Taleo / SuccessFactors', labels: 'ats-adapter', file: 'docs/issue-gated-ats.md' },
  { match: /arbeitnow|weworkremotely|himalayas|remoteok|lnkd\.in/i, title: 'Resolve job-board redirects to the real ATS (Arbeitnow, WeWorkRemotely, Himalayas, RemoteOK)', labels: 'ats-adapter', file: 'docs/issue-board-redirects.md' },
];

/** File GitHub issues for recurring blockers in the evolution memory (deduped by title). */
export async function fileBlockerIssues({ minCount = 3 } = {}) {
  let existing = [];
  try { existing = JSON.parse(await gh('issue', 'list', '--state', 'all', '--limit', '200', '--json', 'title')).map(i => i.title); } catch { return { filed: [], reason: 'gh not available / not authed' }; }
  const enc = openEncounters(60);
  const want = new Map();
  for (const e of enc) {
    if ((e.count || 0) < minCount) continue;
    const rule = BLOCKER_RULES.find(r => r.match.test(`${e.domain} ${e.signature}`));
    if (rule && !want.has(rule.title)) want.set(rule.title, rule);
  }
  const filed = [];
  for (const [title, rule] of want) {
    if (existing.includes(title)) continue;
    const bodyFile = path.join(ROOT, rule.file);
    const args = ['issue', 'create', '--title', title, '--label', rule.labels];
    if (fs.existsSync(bodyFile)) args.push('--body-file', bodyFile); else args.push('--body', 'Auto-filed from JobPilot evolution memory.');
    try { const url = await gh(...args); filed.push(url); } catch {}
  }
  return { filed };
}

/** One full self-contribution round: sync branch → file issues → open a PR to the main repo.
 *  ON by default (profile.consent.autoContribute defaults true). Can be toggled off from the
 *  dashboard; pass force:true to override. Always hard-guarded against pushing data/creds.
 *  Contributes as a PULL REQUEST to upstream (fork or owner), gated by the review workflow. */
export async function contributeRound(message = 'chore(self-evolve): sync improvements + file discovered blockers', { force = false } = {}) {
  let enabled = force;
  if (!enabled) {
    try { const { getProfile } = await import('./profile.js'); enabled = getProfile().consent?.autoContribute !== false; } catch { enabled = true; }
  }
  if (!enabled) return { skipped: true, reason: 'self-contribution is turned off in the dashboard' };
  const sync = await syncBranch().catch(e => ({ synced: false, reason: e.message }));
  const issues = await fileBlockerIssues().catch(e => ({ filed: [], reason: e.message }));
  const pr = await contributeViaPR(message).catch(e => ({ pushed: false, reason: e.message }));
  return { sync, issues, pr };
}
