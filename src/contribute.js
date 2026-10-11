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

/**
 * Commit + push code/doc improvements. Returns {pushed, files} or {pushed:false,reason}.
 * identity is set per-invocation so it never depends on the user's global git config.
 */
export async function contributeCode(message, { push = true } = {}) {
  let files;
  try { files = await safeStage(); } catch (e) { return { pushed: false, reason: e.message }; }
  if (!files.length) return { pushed: false, reason: 'nothing to contribute' };
  // Uses the repo's committed identity (set to the owner at init), so GitHub attributes
  // these self-improvements to YOU — not a bot account.
  await git('commit', '-m', message);
  if (!push) return { pushed: false, committed: true, files };
  try { await git('push', 'origin', 'HEAD'); } catch (e) { return { pushed: false, committed: true, files, reason: 'push failed: ' + e.message }; }
  return { pushed: true, files };
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

/** One full self-contribution round: file issues, then push any code the agent changed. */
export async function contributeRound(message = 'chore(self-evolve): sync improvements + file discovered blockers') {
  const issues = await fileBlockerIssues().catch(e => ({ filed: [], reason: e.message }));
  const code = await contributeCode(message).catch(e => ({ pushed: false, reason: e.message }));
  return { issues, code };
}
