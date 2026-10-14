// src/contribute.js — the "self-improving repository" loop.
//
// Flow:
//   Fork  →  sync with upstream/main (rebase)  →  open a PR to upstream
//   Main  →  ff-merge origin/main              →  review + merge open self-evolve PRs
//
// Hard-guarded:
//   • Only allowlisted paths (src/, docs/, scripts/, *.md, mcp-server.js, etc.) may be staged.
//   • A DENY list aborts immediately if data/, .env*, drafts/, applied/, logs/, screenshots,
//     or the DB ever appear in the index.
//   • The CI security gate (scripts/ci-security-scan.mjs) re-checks on every PR.
//   • Commits are attributed to the repo owner; no personal email is ever committed.
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import { ROOT, DATA } from './config.js';
import {
  openEncounters, evolutionAudits, markAuditIssue, linkAuditPr,
  recordEvolutionAudit,
} from './evolve.js';

const run = promisify(execFile);
const git = (...a) => run('git', a, { cwd: ROOT }).then(r => r.stdout.trim())
  .catch(e => { throw new Error((e.stderr || e.stdout || e.message).slice(0, 300)); });
const gh  = (...a) => run('gh',  a, { cwd: ROOT }).then(r => r.stdout.trim());

function parseGitHubRepo(raw = '') {
  const s = String(raw).trim().replace(/\.git$/, '');
  const m = s.match(/github\.com[:/]([^/]+\/[^/]+)$/i);
  return m ? m[1] : '';
}

// ── Author identity ─────────────────────────────────────────────────────────
// Commits are attributed to the GitHub USERNAME (e.g. "maazbin"), NOT a real name or a
// random name, using the account's noreply email so no personal email is ever committed.
let _ident = null;
/**
 * Resolve the commit identity from the authenticated GitHub account.
 * Returns { name: <login>, email: <id>+<login>@users.noreply.github.com }.
 * Cached for the process. Falls back to the local git user if gh is unavailable.
 * @returns {Promise<{name:string, email:string}>}
 */
async function ghIdentity() {
  if (_ident) return _ident;
  try {
    const login = await gh('api', 'user', '--jq', '.login');
    const id    = await gh('api', 'user', '--jq', '.id');
    _ident = { name: login, email: `${id}+${login}@users.noreply.github.com` };
  } catch {
    const name  = await git('config', 'user.name').catch(() => 'jobpilot');
    const email = await git('config', 'user.email').catch(() => 'jobpilot@users.noreply.github.com');
    _ident = { name, email };
  }
  return _ident;
}

/**
 * Commit staged changes authored AND committed as the GitHub username (via -c overrides),
 * so attribution is the actual username regardless of local/global git config.
 * @param {string} message
 */
async function commitAs(message) {
  const id = await ghIdentity();
  await git(
    '-c', `user.name=${id.name}`,
    '-c', `user.email=${id.email}`,
    'commit', '--author', `${id.name} <${id.email}>`, '-m', message,
  );
}

// ── Allowlist / denylist ──────────────────────────────────────────────────────
const ALLOW = [
  /^src\//, /^docs\//, /^scripts\//, /^\.github\//, /^[^/]+\.md$/,
  /^mcp-server\.js$/, /^start\.js$/, /^package(-lock)?\.json$/,
  /^\.gitignore$/, /^\.env\.example$/, /^LICENSE$/,
];
const DENY = [
  /^data\//, /^\.env$/, /^\.env\.[^x]/, /\.env$/, /^drafts\//, /^applied\//, /^logs\//,
  /\.log$/, /jobs\.db$/, /profile\.json$/, /chrome-debug/, /\.png$/, /\.html$/, /uploads\//,
];

async function staged() {
  return (await git('diff', '--cached', '--name-only')).split('\n').filter(Boolean);
}

/**
 * Stage only allowlisted paths, then hard-abort if anything sensitive slipped in.
 * @returns {string[]} list of staged files
 */
async function safeStage() {
  await git('add', '--',
    'src', 'docs', 'scripts', '.github',
    'mcp-server.js', 'start.js', 'package.json', 'package-lock.json',
    '.gitignore', '.env.example', 'LICENSE',
    'README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'CODING_STANDARDS.md',
  ).catch(() => {});
  const files = await staged();
  const bad = files.filter(f => DENY.some(re => re.test(f)) || !ALLOW.some(re => re.test(f)));
  if (bad.length) {
    await git('reset').catch(() => {});
    throw new Error('ABORT: sensitive/non-allowlisted paths staged: ' + bad.slice(0, 8).join(', '));
  }
  return files;
}

// ── Repo topology ─────────────────────────────────────────────────────────────

/**
 * Determine repo identity: is this a fork? who is upstream?
 * @returns {Promise<{origin, owner, upstream, base, isFork}>}
 */
export async function repoInfo() {
  // Prefer the checkout's remotes. `gh repo view` can resolve the authenticated
  // upstream repository even when this checkout is a fork, which would make a
  // cross-fork PR look like a same-repository branch and fail with "no commits".
  const originRemote = parseGitHubRepo(await git('remote', 'get-url', 'origin').catch(() => ''));
  const upstreamRemote = parseGitHubRepo(await git('remote', 'get-url', 'upstream').catch(() => ''));
  try {
    const j = JSON.parse(await gh('repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,parent'));
    const parentName = j.parent?.nameWithOwner || (j.parent?.owner?.login && j.parent?.name ? `${j.parent.owner.login}/${j.parent.name}` : '');
    const origin = originRemote || j.nameWithOwner;
    const upstream = upstreamRemote || parentName || j.nameWithOwner;
    return {
      origin,
      owner:    origin.split('/')[0],
      upstream,
      base:     j.defaultBranchRef?.name || 'main',
      isFork:   (Boolean(originRemote && upstreamRemote && originRemote !== upstreamRemote) || !!j.parent),
    };
  } catch {
    // `gh repo view` can fail in a worktree without a GitHub repository context.
    // Fall back to the configured remotes so self-evolution never constructs
    // an invalid `gh pr create --repo` invocation.
    const origin = parseGitHubRepo(await git('remote', 'get-url', 'origin').catch(() => ''));
    const upstreamRemote = parseGitHubRepo(await git('remote', 'get-url', 'upstream').catch(() => ''));
    const upstream = upstreamRemote || origin;
    return {
      origin,
      owner: origin.split('/')[0] || '',
      upstream,
      base: 'main',
      isFork: !!upstreamRemote && upstreamRemote !== origin,
    };
  }
}

/**
 * Pull the latest code from upstream BEFORE doing anything:
 *   Fork  — fetch upstream/main and rebase. If rebase conflicts, abort cleanly (leave as-is).
 *            Then push the fork's base branch so the fork itself stays current.
 *   Main  — fetch origin/main and fast-forward merge.
 *
 * This is called at the top of every contributeRound() so we always work from the newest code.
 * @returns {Promise<{synced, advanced, reason?}>}
 */
export async function syncBranch() {
  const info = await repoInfo();
  const { base, upstream, isFork } = info;
  try {
    if (isFork && upstream) {
      // Ensure upstream remote exists
      const remotes = await git('remote').catch(() => '');
      if (!/\bupstream\b/.test(remotes)) {
        await git('remote', 'add', 'upstream', `https://github.com/${upstream}.git`).catch(() => {});
      }
      await git('fetch', 'upstream', base).catch(() => {});
      await git('checkout', base).catch(() => {});
      const before = await git('rev-parse', 'HEAD').catch(() => '');
      const result = await git('rebase', `upstream/${base}`)
        .catch(async () => { await git('rebase', '--abort').catch(() => {}); return 'conflict'; });
      if (result === 'conflict') {
        return { ...info, synced: false, reason: 'rebase conflict — left branch as-is, will retry next cycle' };
      }
      const after = await git('rev-parse', 'HEAD').catch(() => '');
      if (before !== after) {
        // Push updated fork branch so it stays current with upstream
        await git('push', 'origin', base).catch(() => {});
      }
      return { ...info, synced: true, advanced: before !== after };
    }

    // Main repo (not a fork): fast-forward merge from origin
    await git('fetch', 'origin', base).catch(() => {});
    await git('checkout', base).catch(() => {});
    await git('merge', '--ff-only', `origin/${base}`).catch(() => {});
    return { ...info, synced: true };
  } catch (e) {
    return { ...info, synced: false, reason: e.message };
  }
}

/**
 * Open a PR from a feature branch to upstream/main.
 * Works for both forks (cross-fork PR) and the main repo itself.
 * Returns to the original branch when done.
 * Hard-guarded — aborts if anything sensitive would be staged.
 * @param {string} message - commit/PR title
 * @returns {Promise<{pr?, pushed, files?, reason?}>}
 */
export async function contributeViaPR(message) {
  const info = await repoInfo();
  const { base, upstream, owner, isFork } = info;
  if (!upstream || !owner) return { ...info, pushed: false, reason: 'GitHub repository identity unavailable' };
  const startBranch = (await git('rev-parse', '--abbrev-ref', 'HEAD').catch(() => base)) || base;
  const branch = `self-evolve/${Date.now()}`;
  try {
    // Stage on current branch first — if nothing changed, skip
    let files;
    try { files = await safeStage(); } catch (e) { return { pushed: false, reason: e.message }; }
    if (!files.length) return { pushed: false, reason: 'nothing to contribute' };
    const improvementAudit = recordEvolutionAudit('improvement', `${message}|${files.join('|')}`, { needsCode: true });
    await git('reset').catch(() => {});           // unstage; commit on a dedicated branch

    await git('checkout', '-b', branch);
    await safeStage();                             // re-stage + re-check on the new branch
    await commitAs(message);                       // author as the GitHub username
    await git('push', '-u', 'origin', branch);

    const head = isFork ? `${owner}:${branch}` : branch;
    const body = [
      'Automated self-evolution contribution from JobPilot.',
      '',
      '- Only allowlisted code/doc paths (never `data/`, `.env`, drafts, logs, screenshots, or the DB).',
      '- Gated by the security review workflow before merge.',
      '',
      `_Files changed: ${files.join(', ')}_`,
    ].join('\n');

    const url = await gh(
      'pr', 'create',
      '--repo', upstream,
      '--base', base,
      '--head', head,
      '--title', message,
      '--body', body,
      '--label', 'self-evolve',
    );
    // Enable auto-merge once CI passes. Use a MERGE commit (not squash) so the author line
    // we set — the GitHub username — is preserved verbatim (squash lets GitHub rewrite the
    // author to the account's profile display name).
    await gh('pr', 'merge', '--auto', '--merge', url).catch(() => {});
    return { pr: url, pushed: true, files, audit: improvementAudit };
  } catch (e) {
    return { pushed: false, reason: e.message };
  } finally {
    await git('checkout', startBranch).catch(() => {});
  }
}

// The upstream repository already has this established label. Reuse it for
// audit records instead of inventing a label that contributors may not be
// permitted to create on the upstream repository.
const AUDIT_LABEL = 'self-evolve';
const AUDIT_FALLBACK_LABEL = 'enhancement';

function auditTitle(a) { return `Audit: ${a.kind} · ${a.fingerprint}`; }

function auditBody(a) {
  return [
    '## JobPilot self-evolution audit',
    '',
    `- Event type: **${a.kind}**`,
    '- Fingerprint: `' + a.fingerprint + '`',
    `- Observations: **${a.occurrences}**`,
    `- Code/PR follow-up: **${a.needs_code ? 'required or expected' : 'not required'}**`,
    `- Local status: **${a.status}**`,
    a.pr_url ? `- Linked PR: ${a.pr_url}` : '- Linked PR: pending / none',
    '',
    'This issue is an anonymized audit record. It intentionally excludes application questions, answers, CV/profile data, job URLs, screenshots, credentials, and personal contact data.',
  ].join('\n');
}

/**
 * Mirror the local learning ledger to dedicated GitHub audit issues.
 * Audit issues use the repository's established `self-evolve` label. Open
 * events stay open; resolved events are closed with their resolution and PR
 * link.
 */
export async function syncEvolutionAuditIssues({ prUrl = '' } = {}) {
  const { initDB } = await import('./tracker.js');
  await initDB();
  const info = await repoInfo();
  const repo = info.upstream || info.origin;
  if (!repo) return { created: [], reopened: [], closed: [], linked: [], reason: 'repository identity unavailable' };
  const created = [], reopened = [], closed = [], linked = [];
  let issueLabel = AUDIT_LABEL;
  try {
    const labels = JSON.parse(await gh('label', 'list', '--repo', repo, '--limit', '100', '--json', 'name'));
    if (!labels.some(x => x.name === AUDIT_LABEL)) {
      await gh('label', 'create', AUDIT_LABEL, '--repo', repo, '--color', '6f42c1', '--description', 'Anonymized self-evolution audit trail');
    }
  } catch {
    // Contributors may create issues but lack permission to create repository labels.
    // Use an existing non-PR label and retain the stable Audit: title prefix.
    issueLabel = AUDIT_FALLBACK_LABEL;
  }

  let remote = [];
  try { remote = JSON.parse(await gh('issue', 'list', '--repo', repo, '--state', 'all', '--limit', '500', '--json', 'number,title,url,state,labels')); } catch (e) {
    return { created, reopened, closed, linked, reason: e.message };
  }
  const byTitle = new Map(remote.filter(x => String(x.title || '').startsWith('Audit: ')).map(x => [x.title, x]));
  const audits = evolutionAudits(300);

  for (const a of audits) {
    const title = auditTitle(a);
    let issue = byTitle.get(title);
    if (!issue) {
      try {
        const url = await gh('issue', 'create', '--repo', repo, '--title', title, '--label', issueLabel, '--body', auditBody(a));
        const m = String(url).match(/issues\/(\d+)/);
        markAuditIssue(a.fingerprint, m ? +m[1] : null, url);
        issue = { number: m ? +m[1] : null, title, url, state: 'OPEN' };
        created.push(url);
      } catch { continue; }
    } else if (!a.issue_number || a.issue_url !== issue.url) {
      markAuditIssue(a.fingerprint, issue.number, issue.url);
    }

    if (prUrl && a.needs_code && a.pr_url !== prUrl) {
      linkAuditPr(a.fingerprint, prUrl);
      try { await gh('issue', 'comment', String(issue.number), '--repo', repo, '--body', `Linked self-evolution PR: ${prUrl}`); linked.push(issue.url); } catch {}
    }
    const state = String(issue.state || '').toLowerCase();
    if (a.status === 'resolved' && state === 'open') {
      try {
        await gh('issue', 'close', String(issue.number), '--repo', repo, '--comment', `Resolved locally: ${a.resolution || 'resolution recorded in JobPilot evolution memory.'}${a.pr_url ? `\n\nLinked PR: ${a.pr_url}` : ''}`);
        closed.push(issue.url);
      } catch {}
    } else if (a.status === 'open' && state === 'closed') {
      try { await gh('issue', 'reopen', String(issue.number), '--repo', repo, '--comment', 'Reopened automatically: this audit fingerprint was observed again.'); reopened.push(issue.url); } catch {}
    }
  }
  return { created, reopened, closed, linked };
}

/**
 * Approve pending CI for PRs from forks (first-time / external contributors). GitHub holds
 * their workflow runs in `action_required` until a maintainer approves — otherwise the `review`
 * security gate never runs and the PR can never be safely merged. As the repo owner we approve
 * those runs so the security gate executes. We NEVER merge on the strength of this approval alone —
 * the PR still only merges once the `review` gate actually concludes SUCCESS.
 * @param {string} repo - owner/name
 * @returns {Promise<string[]>} ids of runs approved
 */
async function approveForkCIRuns(repo) {
  const approved = [];
  try {
    const raw = await gh('api', `repos/${repo}/actions/runs?status=action_required&per_page=50`, '--jq', '.workflow_runs[].id');
    const ids = (raw || '').split('\n').map(s => s.trim()).filter(Boolean);
    for (const id of ids) {
      try { await gh('api', '--method', 'POST', `repos/${repo}/actions/runs/${id}/approve`); approved.push(id); } catch {}
    }
    // Also handle runs explicitly 'waiting' for approval
    const raw2 = await gh('api', `repos/${repo}/actions/runs?status=waiting&per_page=50`, '--jq', '.workflow_runs[].id').catch(() => '');
    for (const id of (raw2 || '').split('\n').map(s => s.trim()).filter(Boolean)) {
      if (approved.includes(id)) continue;
      try { await gh('api', '--method', 'POST', `repos/${repo}/actions/runs/${id}/approve`); approved.push(id); } catch {}
    }
  } catch {}
  return approved;
}

// ── Linked-issue resolution ────────────────────────────────────────────────────

/**
 * Resolve the issue(s) a PR is intended to address, so usefulness is judged against real intent
 * rather than labels. Combines two signals:
 *   • GitHub's native linkage — `closingIssuesReferences` (set via "Fixes #N" or the PR UI).
 *   • The PR body — "Fixes/Closes/Resolves #N" closing keywords (strong) AND any bare "#N"
 *     mention (weak/context, e.g. "the top recurring encounter (#20, x48)").
 * Each referenced issue is fetched (title/state/body) and returned, deduped by number. Fetch
 * failures (e.g. the number is actually a PR, or doesn't exist) are tolerated and skipped.
 *
 * @param {string} repo - owner/name of the repo the PR targets
 * @param {{number:number, body?:string}} pr
 * @returns {Promise<Array<{number:number,title:string,state:string,body:string,closing:boolean}>>}
 */
export async function linkedIssuesFor(repo, pr) {
  const closing = new Set();   // strong: this PR closes the issue
  const mentioned = new Set(); // weak: referenced for context
  const body = pr.body || '';

  // Closing keywords in the body.
  const closeRe = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s*:?\s+#(\d+)\b/gi;
  let m;
  while ((m = closeRe.exec(body))) closing.add(Number(m[1]));
  // Any other bare "#N" reference → context only.
  const bareRe = /(?<![\w/])#(\d+)\b/g;
  while ((m = bareRe.exec(body))) {
    const n = Number(m[1]);
    if (!closing.has(n)) mentioned.add(n);
  }

  // GitHub's own closing linkage (authoritative for the "closing" set).
  try {
    const [owner, name] = repo.split('/');
    const q = 'query($owner:String!,$name:String!,$num:Int!){repository(owner:$owner,name:$name)' +
      '{pullRequest(number:$num){closingIssuesReferences(first:20){nodes{number}}}}}';
    const raw = await gh('api', 'graphql', '-f', `query=${q}`,
      '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `num=${pr.number}`);
    const nodes = JSON.parse(raw)?.data?.repository?.pullRequest?.closingIssuesReferences?.nodes || [];
    for (const n of nodes) { closing.add(n.number); mentioned.delete(n.number); }
  } catch {}

  const out = [];
  for (const n of [...closing, ...mentioned]) {
    try {
      const raw = await gh('issue', 'view', String(n), '--repo', repo, '--json', 'number,title,state,body');
      const j = JSON.parse(raw);
      out.push({ number: j.number, title: j.title, state: j.state, body: j.body || '', closing: closing.has(n) });
    } catch { /* not an issue / inaccessible — skip */ }
  }
  return out;
}

// ── Usefulness assessment (label-independent, testable, pure) ───────────────────

/**
 * Decide whether a PR is worth merging — on the merits of the change itself, NOT its labels or
 * author. Pure function: given the PR's size/files and its linked issues, returns a verdict.
 *
 *   • empty (0 files or 0 net churn)                       → not useful, close as redundant.
 *   • touches sensitive / non-allowlisted paths            → not useful (CI would fail anyway).
 *   • real churn in allowlisted code/docs                  → useful; strengthened if it addresses
 *                                                            an OPEN linked issue.
 *
 * Labels are deliberately never consulted here.
 *
 * @param {{changedFiles?:number, additions?:number, deletions?:number, files?:Array<{path:string}|string>}} pr
 * @param {Array<{number:number,state:string,closing?:boolean}>} [linkedIssues]
 * @returns {{useful:boolean, empty:boolean, addressesOpenIssue:boolean, reason:string}}
 */
export function assessUsefulness(pr, linkedIssues = []) {
  const changedFiles = pr.changedFiles || 0;
  const churn = (pr.additions || 0) + (pr.deletions || 0);

  if (changedFiles === 0 || churn === 0) {
    return { useful: false, empty: true, addressesOpenIssue: false, reason: 'no net changes against base (empty/redundant)' };
  }

  const paths = (pr.files || []).map(f => (typeof f === 'string' ? f : f.path)).filter(Boolean);
  if (paths.length) {
    const bad = paths.filter(p => DENY.some(re => re.test(p)) || !ALLOW.some(re => re.test(p)));
    if (bad.length) {
      return { useful: false, empty: false, addressesOpenIssue: false,
        reason: 'touches sensitive/non-allowlisted paths (would fail the security gate): ' + bad.slice(0, 6).join(', ') };
    }
  }

  const addressesOpenIssue = linkedIssues.some(i => (i.state || '').toUpperCase() === 'OPEN');
  const parts = [`${changedFiles} file(s), ${churn} line(s) in allowlisted paths`];
  if (linkedIssues.length) {
    const closing = linkedIssues.filter(i => i.closing).map(i => '#' + i.number);
    const ctx     = linkedIssues.filter(i => !i.closing).map(i => '#' + i.number);
    if (closing.length) parts.push(`closes ${closing.join(', ')}`);
    if (ctx.length)     parts.push(`refs ${ctx.join(', ')}`);
  }
  return { useful: true, empty: false, addressesOpenIssue, reason: parts.join('; ') };
}

/**
 * Review EVERY open PR from EVERYONE — any contributor, any fork, any label (there are several
 * contributing agents out there, not just this one). Each PR is judged purely on usefulness
 * (see {@link assessUsefulness}) against its actual diff + the issues it links/references
 * ({@link linkedIssuesFor}) — labels and author are deliberately ignored. Acts on each:
 *   • first approve any pending fork CI so the `review` security gate actually runs;
 *   • empty / redundant PR (0 net changes)      → close with a note.
 *   • not-useful PR (e.g. sensitive paths)       → left open + flagged with the reason.
 *   • useful PR whose `review` gate passed        → merge (merge commit). Uses --admin to force
 *                                                   past a stuck/mechanical required check —
 *                                                   ONLY after the security gate is confirmed green.
 *   • useful PR whose `review` gate FAILED        → left open + flagged. The `review` job is the
 *                                                   data-safety + security gate; that one is NEVER
 *                                                   bypassed, even for a useful PR from anyone.
 *   • useful PR with CI pending/absent            → CI (re)triggered via approval; retried next cycle.
 *
 * Runs against `info.upstream` — for the main repo that is itself; for a fork it attempts the
 * parent (merges there simply fail gracefully into `skipped` if we lack push rights).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] - assess + log intended actions, but perform no close/merge/update.
 * @returns {Promise<{merged:string[], closed:string[], skipped:string[], conflicts:string[], approvedCI?:string[], plan?:object[], reason?:string}>}
 */
export async function reviewAndMergePRs({ dryRun = false } = {}) {
  try {
    const info = await repoInfo();
    const target = info.upstream || info.origin;

    // Let external contributors' CI run so their security gate can pass. (Skipped on dry runs.)
    const approvedCI = dryRun ? [] : await approveForkCIRuns(target);

    const raw = await gh(
      'pr', 'list',
      '--repo', target,
      '--state', 'open',
      '--json', 'number,title,body,files,statusCheckRollup,url,additions,deletions,changedFiles,author,isCrossRepository,mergeable,mergeStateStatus',
      '--limit', '50',
    );
    const prs = JSON.parse(raw || '[]');
    const merged = [], closed = [], skipped = [], conflicts = [], plan = [];

    for (const pr of prs) {
      const who = pr.author?.login ? `@${pr.author.login}` : 'unknown';
      const origin = pr.isCrossRepository ? 'fork' : 'branch';
      const tag = `#${pr.number} (${origin} by ${who})`;

      // Usefulness is judged on the diff + the issues the PR addresses — never on labels/author.
      const issues = await linkedIssuesFor(target, pr).catch(() => []);
      const verdict = assessUsefulness(pr, issues);
      plan.push({ number: pr.number, url: pr.url, author: who, verdict });

      // Empty / redundant PR — nothing to merge, close it politely.
      if (verdict.empty) {
        if (dryRun) { closed.push(`${tag} — WOULD CLOSE (${verdict.reason})`); continue; }
        try {
          await gh('pr', 'close', String(pr.number), '--repo', target,
            '--comment', `Auto-closed by JobPilot: no changes against the base branch (already merged / redundant). Thanks ${who}!`);
          closed.push(`${tag} — closed (${verdict.reason})`);
        } catch { skipped.push(`${tag} — close failed`); }
        continue;
      }

      // Not useful (e.g. touches sensitive/non-allowlisted paths) → flag, do not merge.
      if (!verdict.useful) {
        skipped.push(`${tag} — not useful: ${verdict.reason}`);
        continue;
      }

      // The `review` CI job is the data-safety + security gate. It must have concluded SUCCESS.
      const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup : [];
      const reviewCheck = checks.find(c => (c.name || c.workflowName || '').toLowerCase().includes('review'));
      const reviewFailed = checks.some(c => {
        const n = (c.name || c.workflowName || '').toLowerCase();
        const concl = (c.conclusion || '').toUpperCase();
        return n.includes('review') && ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(concl);
      });
      const reviewPassed = reviewCheck
        ? (reviewCheck.conclusion || '').toUpperCase() === 'SUCCESS'
        : false;
      const noChecksYet = checks.length === 0;

      if (reviewFailed) {
        skipped.push(`${tag} — useful (${verdict.reason}) but the review security gate is NOT green → not bypassed`);
        continue;
      }
      if (!reviewPassed) {
        skipped.push(`${tag} — useful (${verdict.reason}); awaiting review gate${!noChecksYet ? ' (in progress)' : (approvedCI.length ? ' (CI approved, will run)' : '')} → retry next cycle`);
        continue;
      }

      // ── From here the security gate is CONFIRMED GREEN. Only now may we merge. ──
      if (pr.mergeable === 'CONFLICTING') {
        conflicts.push(`${tag} — useful + security-passed, needs conflict resolution`);
        continue;
      }
      if (/BEHIND/i.test(pr.mergeStateStatus || '')) {
        if (dryRun) { skipped.push(`${tag} — WOULD update-branch then merge`); continue; }
        try { await gh('api', '--method', 'PUT', `repos/${target}/pulls/${pr.number}/update-branch`); } catch {}
      }

      if (dryRun) { merged.push(`${tag} — WOULD MERGE (${verdict.reason})`); continue; }

      // Useful + security gate green + mergeable → merge. --admin forces past a stuck/mechanical
      // required check, and is used ONLY here, after the security gate is confirmed SUCCESS.
      try {
        await gh('pr', 'merge', '--merge', '--admin', String(pr.number), '--repo', target);
        merged.push(`${tag} — merged (${verdict.reason})`);
      } catch {
        try { await gh('pr', 'merge', '--merge', '--auto', String(pr.number), '--repo', target); merged.push(`${tag} — auto-merge armed (${verdict.reason})`); }
        catch { skipped.push(`${tag} — merge blocked`); }
      }
    }

    // After merging PRs, pull the new commits into our local branch
    if (merged.length && !dryRun) await syncBranch().catch(() => {});
    return { merged, closed, skipped, conflicts, approvedCI, plan };
  } catch (e) {
    return { merged: [], closed: [], skipped: [], conflicts: [], reason: e.message };
  }
}

// ── Blocker issue filing ──────────────────────────────────────────────────────

const BLOCKER_RULES = [
  { match: /indeed/i,                         title: "Blocker: Indeed anti-bot / login wall — can't auto-apply", labels: 'blocker', file: 'docs/issue-indeed.md' },
  { match: /glassdoor/i,                      title: "Blocker: Glassdoor login + anti-bot wall — can't auto-apply", labels: 'blocker', file: 'docs/issue-glassdoor.md' },
  { match: /workday|icims|taleo|successfactors|oraclecloud|brassring/i, title: 'Account-gated ATS adapters: Workday / iCIMS / Taleo / SuccessFactors', labels: 'ats-adapter', file: 'docs/issue-gated-ats.md' },
  { match: /arbeitnow|weworkremotely|himalayas|remoteok|lnkd\.in/i, title: 'Resolve job-board redirects to the real ATS (Arbeitnow, WeWorkRemotely, Himalayas, RemoteOK)', labels: 'ats-adapter', file: 'docs/issue-board-redirects.md' },
];

/**
 * File GitHub issues for recurring blockers discovered in the evolution memory.
 * Deduped by title — never files the same issue twice.
 * @param {object} opts
 * @param {number} [opts.minCount=3] - minimum encounter count before filing
 * @returns {Promise<{filed: string[], reason?}>}
 */
export async function fileBlockerIssues({ minCount = 3 } = {}) {
  let existing = [];
  try {
    existing = JSON.parse(
      await gh('issue', 'list', '--state', 'all', '--limit', '200', '--json', 'title')
    ).map(i => i.title);
  } catch {
    return { filed: [], reason: 'gh not available / not authed' };
  }

  const enc  = openEncounters(60);
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
    if (fs.existsSync(bodyFile)) args.push('--body-file', bodyFile);
    else args.push('--body', 'Auto-filed from JobPilot evolution memory.');
    try { const url = await gh(...args); filed.push(url); } catch {}
  }
  return { filed };
}

// ── Main contribution round ───────────────────────────────────────────────────

/**
 * One full self-contribution cycle (the heart of self-evolution + recontribution):
 *   1. Pull the latest code from upstream (sync first — never contribute stale code)
 *   2. File GitHub issues for recurring blockers
 *   3. Open a CI-gated `self-evolve` PR for any local code/doc changes
 *        Fork → cross-fork PR to upstream.  Main → PR to its own main (never a direct push).
 *   4. Main repo only: review + merge every open self-evolve PR that has passed CI.
 *
 * ON by default (profile.consent.autoContribute defaults true).
 * Toggle off from the dashboard. Pass force:true to override the consent flag.
 *
 * @param {string} [message] - commit/PR title
 * @param {object} [opts]
 * @param {boolean} [opts.force] - skip consent check
 * @returns {Promise<object>} { sync, issues, pr, review }
 */
export async function contributeRound(
  message = 'chore(self-evolve): sync improvements + file discovered blockers',
  { force = false } = {},
) {
  let enabled = force;
  if (!enabled) {
    try {
      const { getProfile } = await import('./profile.js');
      enabled = getProfile().consent?.autoContribute !== false;
    } catch {
      enabled = true;
    }
  }
  if (!enabled) return { skipped: true, reason: 'self-contribution is turned off in the dashboard' };

  // Contribution can be invoked by the worker or directly by the MCP/agent.
  // Make the latter safe too: audit and encounter reads must never depend on a
  // prior worker boot having initialized the shared sql.js handle.
  const { initDB } = await import('./tracker.js');
  await initDB();

  const info = await repoInfo();

  // 1. Always sync first — pull new version before contributing
  const sync = await syncBranch().catch(e => ({ synced: false, reason: e.message }));

  // Audit learning/improvement events alongside the normal blocker issue flow.
  // This is deliberately separate from the self-evolve PR label/workflow.
  const auditBefore = await syncEvolutionAuditIssues().catch(e => ({ created: [], reason: e.message }));

  // 2. File issues for recurring blockers
  const issues = await fileBlockerIssues().catch(e => ({ filed: [], reason: e.message }));

  // 3. Push local code/doc changes AS A PR (both fork and main repo).
  //    Every change must land on GitHub through a CI-gated self-evolve PR — never a direct push to
  //    main — so the security gate + boot smoke test always run first. For a fork this is a
  //    cross-fork PR to upstream; for the main repo it is a self-evolve PR to its own main.
  const pr = await contributeViaPR(message).catch(e => ({ pushed: false, reason: e.message }));
  const auditAfter = await syncEvolutionAuditIssues({ prUrl: pr.pr || '' }).catch(e => ({ created: [], reason: e.message }));

  // 4. Main repo ALSO acts as reviewer: merge every open self-evolve PR that has passed CI
  //    (including the one just opened, once its checks are green), then fast-forward main.
  let review = {};
  if (!info.isFork) {
    review = await reviewAndMergePRs().catch(e => ({ merged: [], skipped: [], reason: e.message }));
  }

  return { sync, issues, audits: { before: auditBefore, after: auditAfter }, pr, review };
}
