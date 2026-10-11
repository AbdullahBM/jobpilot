// src/worker.js — the always-on engine. Four lanes run CONCURRENTLY (own tab each),
// so scraping never blocks applying and email never blocks Easy Apply:
//   scout     — scrape LinkedIn posts/jobs (freshest first) + web (HN/Reddit/boards); UCB-ranked queries
//   mailer    — email leads (LinkedIn posts first, then web), newest posted first
//   applier   — Easy Apply + external forms, interleaved, newest first
//   connector — connection request + note to the poster
// Priority is encoded in the queue ordering (email: LI-post first; everything: newest posted first).
// Pacing is brisk but jittered; daily caps + dedup are always enforced. Everything self-records
// into the evolution memory (encounters, harvested answers, query/domain stats).
import fs from 'fs';
import path from 'path';
import { launchChrome } from './mcp/chrome.js';
import { initDB, upsertJobs, setStatus, setFields, bumpAttempt, logEmail, log, getJob,
  alreadyEmailed, alreadyApplied, alreadyConnected, logConnect, rows, doneToday } from './tracker.js';
import { liPosts, liJobs, hnHiring, redditHiring, publicBoards, relToIso } from './mcp/sources.js';
import { easyApply } from './mcp/easyapply.js';
import { applyForm } from './mcp/forms.js';
import { connect } from './mcp/connect.js';
import { sendViaGmail } from './mcp/gmail.js';
import { subject as mkSubject, body as mkBody } from './scraper/email_content.js';
import { writeDash } from './dashboard.js';
import { getProfile } from './profile.js';
import { outcome, rankByUCB, learnedSkip, writePlaybook, domainOf } from './evolve.js';
import { buildQueries, buildListingQueries } from './mcp/queries.js';
import { DATA } from './config.js';

const DRY = process.env.DRY === '1';
const DAILY = { email: 50, easy: 80, form: 30, connect: 18 };
const MIN_REL = { email: 0.3, easy_apply: 0.4, form: 0.45, connect: 0.5 };
const MAX_AGE_DAYS = { email: 12, easy_apply: 4, form: 7, connect: 3 };
const PACE = { mailer: [12000, 22000], applier: [4000, 9000], connector: [35000, 70000], scout: [15000, 30000] };
const RUN_MS = +(process.env.RUN_MS || 0) || Infinity; // 0/absent = run forever

const SLEEP = ms => new Promise(r => setTimeout(r, ms));
const jitter = ([a, b]) => SLEEP(a + Math.random() * (b - a));
const STATE = path.join(DATA, 'worker-state.json');
const started = Date.now();
let state = { startedAt: new Date().toISOString(), lanes: {}, cycle: 0 };
function beat(lane, phase, extra = {}) {
  state.lanes[lane] = { phase, ts: new Date().toISOString() };
  state.ts = new Date().toISOString();
  Object.assign(state, extra);
  try { fs.writeFileSync(STATE, JSON.stringify(state)); } catch {}
}
const say = (lane, m) => console.log(`[${new Date().toLocaleTimeString('en-GB')}] ${lane}: ${m}`);

// ── queue selector (shared) ──────────────────────────────────────────────────
function queue(channel, limit = 25) {
  const minPosted = new Date(Date.now() - MAX_AGE_DAYS[channel] * 86400e3).toISOString();
  return rows(`SELECT * FROM jobs WHERE status='new' AND channel=? AND relevance>=? AND COALESCE(attempts,0)<3
     AND (posted_at='' OR posted_at IS NULL OR posted_at>=?)
     ORDER BY ${channel === 'email' ? "CASE WHEN source='linkedin_post' THEN 0 ELSE 1 END," : ''}
       CASE WHEN posted_at='' OR posted_at IS NULL THEN 1 ELSE 0 END, posted_at DESC, relevance DESC LIMIT ?`,
    [channel, MIN_REL[channel], minPosted, limit]);
}
const capLeft = (k, type) => Math.max(0, DAILY[k] - doneToday(type));

// ── ingest helper ────────────────────────────────────────────────────────────
function ingest(leads) {
  const good = leads.filter(l => !l.skip && !l.alreadyApplied);
  const skip = leads.filter(l => l.skip && !l.alreadyApplied).map(l => ({ ...l, status: 'skipped' }));
  const applied = leads.filter(l => l.alreadyApplied).map(l => ({ ...l, status: 'applied' }));
  const n = upsertJobs([...good, ...skip, ...applied]);
  for (const l of skip) { const j = getJob(l.url); if (j && j.status === 'skipped' && !j.notes) setFields(l.url, { notes: l.skipWhy }); }
  return { n, email: good.filter(l => l.email).length };
}

// ── SCOUT lane ────────────────────────────────────────────────────────────────
async function scout() {
  let i = 0;
  while (Date.now() - started < RUN_MS) {
    try {
      const postQ = rankByUCB('post_query', buildQueries({ limit: 30 }));
      const jobQ = rankByUCB('job_query', buildListingQueries({ limit: 18 }));
      const q = postQ[0];
      beat('scout', `LI posts: ${q}`);
      const r = await liPosts(q, { datePosted: 'past-24h' });
      if (r.ok) { const { n, email } = ingest(r.leads); outcome('post_query', q, { yieldN: email * 2 + n }); say('scout', `posts "${q}" +${n} (${email} email)`); }
      await jitter(PACE.scout);

      const jq = jobQ[0];
      beat('scout', `LI jobs: ${jq}`);
      for (const geoId of ['92000000', '101022442']) { // Worldwide, Pakistan
        const rj = await liJobs(jq, { easyOnly: true, tpr: 86400, geoId, pages: 1 });
        if (rj.ok) { const { n } = ingest(rj.leads); outcome('job_query', jq, { yieldN: n }); }
        await SLEEP(2500);
      }
      say('scout', `jobs "${jq}" done`);

      if (i % 4 === 3) { // web sweep every 4th loop
        for (const [name, fn] of [['HN', () => hnHiring({ maxAgeHours: 240 })], ['Reddit', () => redditHiring()], ['Boards', () => publicBoards({ maxAgeHours: 72 })]]) {
          beat('scout', 'web: ' + name);
          try { const rr = await fn(); const { n, email } = ingest(rr.leads); say('scout', `${name} +${n} (${email} email)`); } catch (e) { say('scout', `${name} err ${e.message.slice(0, 60)}`); }
        }
      }
      i++;
      await jitter(PACE.scout);
    } catch (e) { say('scout', 'error ' + e.message.slice(0, 80)); await SLEEP(15000); }
  }
}

// ── MAILER lane ────────────────────────────────────────────────────────────────
async function mailer() {
  while (Date.now() - started < RUN_MS) {
    if (capLeft('email', 'email') <= 0) { beat('mailer', 'daily cap reached'); await SLEEP(10 * 60000); continue; }
    const j = queue('email', 12).find(j => !alreadyEmailed(j.email) && !alreadyApplied(j.company, j.role));
    if (!j) { beat('mailer', 'idle (queue empty)'); await SLEEP(30000); continue; }
    const p = getProfile();
    const job = { ...j, posterName: j.poster_name, description: j.description };
    const subj = mkSubject(job, p), body = mkBody(job, p);
    beat('mailer', `emailing ${j.email}`);
    bumpAttempt(j.url);
    if (DRY) { say('mailer', `DRY → ${j.email}`); setStatus(j.url, 'emailed', 'DRY'); await jitter(PACE.mailer); continue; }
    const r = await sendViaGmail({ to: j.email, subject: subj, body, attachmentPath: p.cvPath });
    if (r.ok) { logEmail(j.email, j.company, j.role, subj, 'sent', j.url); setStatus(j.url, 'emailed', `sent: ${subj}`); }
    else if ((j.attempts || 0) + 1 >= 3) setStatus(j.url, 'failed', r.detail);
    log('email_send', j.company, j.role, j.email, r.ok ? 'ok' : 'fail', r.detail);
    outcome('email_domain', (j.email.split('@')[1] || ''), { win: r.ok });
    say('mailer', `${r.ok ? '✉ SENT' : '✗'} ${j.email} (${j.role} @ ${j.company})`);
    writeDash();
    await jitter(PACE.mailer);
  }
}

// ── APPLIER lane (Easy Apply + forms interleaved) ───────────────────────────────
async function applier() {
  let turn = 0;
  while (Date.now() - started < RUN_MS) {
    const doEasy = turn++ % 2 === 0;
    const chan = doEasy ? 'easy_apply' : 'form';
    const capK = doEasy ? 'easy' : 'form', capType = doEasy ? 'li_easy_apply' : 'portal_apply';
    if (capLeft(capK, capType) <= 0) { await SLEEP(60000); continue; }
    const list = queue(chan, 15).filter(j => !alreadyApplied(j.company, j.role));
    const j = list.find(j => !learnedSkip('form_domain', domainOf(j.apply_url || j.url)));
    if (!j) { beat('applier', `idle (${chan} queue empty)`); await SLEEP(12000); continue; }
    bumpAttempt(j.url);
    if (DRY) { say('applier', `DRY ${chan} → ${j.role}`); setStatus(j.url, 'applied', 'DRY'); await jitter(PACE.applier); continue; }
    try {
      if (doEasy) {
        beat('applier', `⚡ ${j.role} @ ${j.company}`);
        const r = await easyApply({ url: j.apply_url || j.url });
        if (r.result === 'applied' || r.result === 'already_applied') setStatus(j.url, 'applied', r.detail);
        else if (r.result === 'no_easy_apply') { if (r.externalUrl) setFields(j.url, { channel: 'form', apply_url: r.externalUrl }); else setStatus(j.url, 'skipped', 'no Easy Apply / external'); }
        else if (r.result === 'needs_answers') setStatus(j.url, 'needs_manual', r.detail);
        else if (r.result === 'closed') setStatus(j.url, 'skipped', 'closed');
        else if ((j.attempts || 0) + 1 >= 3) setStatus(j.url, 'failed', r.detail);
        log('li_easy_apply', j.company, j.role, j.url, r.result === 'applied' ? 'ok' : /needs_answers/.test(r.result) ? 'manual' : /already|no_easy|closed/.test(r.result) ? 'skip' : 'fail', `${r.result}: ${r.detail}`);
        say('applier', `⚡ ${r.result} → ${j.role} @ ${j.company}`);
      } else {
        const target = j.apply_url || j.url;
        beat('applier', `📋 ${j.role} @ ${j.company}`);
        const r = await applyForm({ url: target, submit: true });
        if (r.result === 'submitted') setStatus(j.url, 'applied', 'form submitted');
        else if (r.result === 'needs_manual') setStatus(j.url, 'needs_manual', r.detail);
        else if (r.result === 'no_form') setStatus(j.url, 'skipped', 'no form');
        else if ((j.attempts || 0) + 1 >= 3) setStatus(j.url, 'failed', r.detail);
        if (r.finalUrl) setFields(j.url, { apply_url: r.finalUrl });
        outcome('form_domain', domainOf(r.finalUrl || target), { win: r.result === 'submitted' });
        log('portal_apply', j.company, j.role, r.finalUrl || target, r.result === 'submitted' ? 'ok' : r.result === 'needs_manual' ? 'manual' : r.result === 'no_form' ? 'skip' : 'fail', `${r.result}: ${r.detail}`);
        say('applier', `📋 ${r.result} → ${j.role} @ ${j.company}`);
      }
    } catch (e) { say('applier', 'error ' + e.message.slice(0, 80)); setStatus(j.url, 'needs_manual', e.message.slice(0, 120)); }
    writeDash();
    await jitter(PACE.applier);
  }
}

// ── CONNECTOR lane ──────────────────────────────────────────────────────────────
let connectPaused = false;
async function connector() {
  while (Date.now() - started < RUN_MS) {
    if (connectPaused || capLeft('connect', 'connect') <= 0) { beat('connector', connectPaused ? 'paused (weekly limit)' : 'daily cap'); await SLEEP(15 * 60000); continue; }
    const j = queue('connect', 15).find(j => j.poster_url && !alreadyConnected(j.poster_url) && !alreadyApplied(j.company, j.role));
    if (!j) { beat('connector', 'idle (queue empty)'); await SLEEP(45000); continue; }
    bumpAttempt(j.url);
    if (DRY) { say('connector', `DRY → ${j.poster_name}`); setStatus(j.url, 'connected', 'DRY'); await jitter(PACE.connector); continue; }
    beat('connector', `🔗 ${j.poster_name}`);
    const r = await connect({ profileUrl: j.poster_url, posterName: j.poster_name, role: j.role, company: j.company });
    if (/^connected/.test(r.result)) { setStatus(j.url, 'connected', r.detail); logConnect(j.poster_url, j.poster_name, j.company, j.role, r.note || '', 'connected'); }
    else if (/already/.test(r.result)) { setStatus(j.url, 'skipped', r.detail); logConnect(j.poster_url, j.poster_name, j.company, j.role, '', 'pending'); }
    else if (r.result === 'limit') { connectPaused = true; say('connector', 'weekly invite limit — pausing'); }
    else if (r.result === 'no_connect') setStatus(j.url, 'skipped', r.detail);
    else if ((j.attempts || 0) + 1 >= 3) setStatus(j.url, 'failed', r.detail);
    log('li_connect', j.company, j.role, j.poster_url, /^connected/.test(r.result) ? 'ok' : r.result === 'error' ? 'fail' : 'skip', `${r.result}: ${r.detail}`);
    say('connector', `🔗 ${r.result} → ${j.poster_name}`);
    writeDash();
    await jitter(PACE.connector);
  }
}

// ── dashboard + playbook refresher ──────────────────────────────────────────────
async function refresher() {
  while (Date.now() - started < RUN_MS) {
    try { writeDash(); writePlaybook(); } catch {}
    await SLEEP(20000);
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
await launchChrome();
await initDB();
say('main', `worker start${DRY ? ' (DRY)' : ''} — concurrent lanes: scout · mailer · applier · connector`);
beat('main', 'running');
await Promise.all([scout(), mailer(), applier(), connector(), refresher()]);
process.exit(0);
