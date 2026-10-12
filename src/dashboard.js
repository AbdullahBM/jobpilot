// src/dashboard.js — Pipeline dashboard. Organized the way the worker thinks:
//   1. Worker status + today's numbers
//   2. 🔥 Fresh EMAIL leads (LinkedIn posts first, then web) — highest priority
//   3. Channel queues (Email · Easy Apply · Form · Connect), newest-posted first
//   4. Done log (every email / apply / connect, with result)
//   5. Needs you (couldn't finish automatically + the exact questions)
//   6. Full bank (searchable), collapsed
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { rows, one, initDB } from './tracker.js';
import { DASH, DATA } from './config.js';
import { getProfile } from './profile.js';
import { recommendAnswer } from './mcp/answers.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS = {
  new:            ['#64748b', 'Found, waiting in a queue'],
  emailed:        ['#22c55e', 'Email sent from your Gmail (CV attached)'],
  applied:        ['#3b82f6', 'Application submitted (Easy Apply or external form)'],
  connected:      ['#a855f7', 'LinkedIn connection request sent to the poster'],
  needs_manual:   ['#f97316', 'Started but needs you (unknown question, captcha, login-gated ATS)'],
  skipped:        ['#475569', 'Not relevant (junior, non-engineering, skip term) or duplicate'],
  stale:          ['#334155', 'Too old to act on'],
  failed:         ['#ef4444', 'Failed after max attempts'],
  draft:          ['#f59e0b', 'Legacy draft (not sent)'],
};
const CH = { email: '✉ Email', easy_apply: '⚡ Easy Apply', form: '📋 Form', connect: '🔗 Connect', none: '— none' };
const badge = s => { const c = (STATUS[s] || ['#64748b'])[0]; return `<span class="b" style="background:${c}22;color:${c};border-color:${c}55" title="${esc((STATUS[s] || [])[1] || '')}">${esc(s)}</span>`; };

function ago(iso) {
  if (!iso) return '<span class="dim">?</span>';
  const s = (Date.now() - Date.parse(iso.length <= 19 ? iso.replace(' ', 'T') + 'Z' : iso)) / 1000;
  if (isNaN(s)) return '?';
  const t = s < 3600 ? `${Math.max(1, Math.round(s / 60))}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  const c = s < 6 * 3600 ? '#22c55e' : s < 86400 ? '#84cc16' : s < 3 * 86400 ? '#eab308' : '#64748b';
  return `<span style="color:${c};font-weight:700">${t}</span>`;
}
const rel = r => { const v = Math.round((+r || 0) * 100); const c = v >= 60 ? '#22c55e' : v >= 40 ? '#3b82f6' : '#64748b'; return `<span style="color:${c};font-weight:600">${v}%</span>`; };
const link = (u, t = '↗') => u ? `<a href="${esc(u.startsWith('email:') ? '#' : u)}" target="_blank">${t}</a>` : '';
const srcLabel = s => esc((s || '').replace('linkedin_post', 'LI post').replace('linkedin_easy', 'LI jobs').replace('linkedin_jobs', 'LI jobs').replace('hn_hiring', 'HN hiring').replace('reddit_', 'r/'));

function table(id, head, body, empty) {
  return `<table id="${id}"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body || `<tr><td colspan="${head.length}" class="empty">${empty}</td></tr>`}</tbody></table>`;
}

export function writeDash() {
  const p = getProfile();
  const UIPORT = process.env.JOB_AGENT_PORT || 7788;
  let state = {};
  try { state = JSON.parse(fs.readFileSync(path.join(DATA, 'worker-state.json'), 'utf8')); } catch {}
  const q = (sql, a = []) => rows(sql, a);
  const n = (sql, a = []) => one(sql, a)?.n || 0;
  const order = `ORDER BY CASE WHEN posted_at='' OR posted_at IS NULL THEN 1 ELSE 0 END, posted_at DESC, id DESC`;

  // today
  const today = {
    found: n(`SELECT COUNT(*) n FROM jobs WHERE added_at > datetime('now','-1 day')`),
    emails: n(`SELECT COUNT(*) n FROM emails_sent WHERE result='sent' AND ts > datetime('now','-1 day')`),
    easy: n(`SELECT COUNT(*) n FROM actions WHERE type='li_easy_apply' AND result='ok' AND ts > datetime('now','-1 day')`),
    forms: n(`SELECT COUNT(*) n FROM actions WHERE type='portal_apply' AND result='ok' AND ts > datetime('now','-1 day')`),
    connects: n(`SELECT COUNT(*) n FROM actions WHERE type='li_connect' AND result='ok' AND ts > datetime('now','-1 day')`),
  };
  const tot = {
    jobs: n('SELECT COUNT(*) n FROM jobs'),
    emailed: n(`SELECT COUNT(DISTINCT lower(to_email)) n FROM emails_sent WHERE result='sent'`),
    applied: n(`SELECT COUNT(*) n FROM jobs WHERE status='applied'`),
    connected: n(`SELECT COUNT(*) n FROM jobs WHERE status='connected'`),
    manual: n(`SELECT COUNT(*) n FROM jobs WHERE status='needs_manual'`),
  };
  const queueCount = ch => n(`SELECT COUNT(*) n FROM jobs WHERE status='new' AND channel=?`, [ch]);
  const doneCount = st => n(`SELECT COUNT(*) n FROM jobs WHERE status=?`, [st]);

  // 2. fresh email leads
  const emailLeads = q(`SELECT * FROM jobs WHERE email!='' AND status NOT IN ('skipped','stale') ${order.replace('ORDER BY', "ORDER BY CASE WHEN source='linkedin_post' THEN 0 ELSE 1 END,")} LIMIT 80`);
  const emailRows = emailLeads.map(j => `<tr>
    <td>${ago(j.posted_at || j.added_at)}</td><td>${srcLabel(j.source)}</td>
    <td class="role">${esc(j.role)}</td><td>${esc(j.company)}</td>
    <td><span class="em">${esc(j.email)}</span></td><td>${rel(j.relevance)}</td><td>${badge(j.status)}</td>
    <td class="dim">${j.status === 'emailed' ? 'sent ' + esc((j.applied_at || '').slice(5, 16).replace('T', ' ')) : esc((j.notes || '').slice(0, 50))}</td>
    <td>${link(j.url.startsWith('email:') ? '' : j.url)}</td></tr>`).join('');

  // 3. queues
  const queueTable = (ch, extraHead, extraCell) => {
    const list = q(`SELECT * FROM jobs WHERE status='new' AND channel=? ${order} LIMIT 60`, [ch]);
    return table('q_' + ch, ['Posted', 'Source', 'Role', 'Company', ...extraHead, 'Match', 'Tries', 'Link'],
      list.map(j => `<tr><td>${ago(j.posted_at || j.added_at)}</td><td>${srcLabel(j.source)}</td><td class="role">${esc(j.role)}</td><td>${esc(j.company)}</td>${extraCell(j)}<td>${rel(j.relevance)}</td><td class="dim">${j.attempts || 0}</td><td>${link(j.apply_url || j.url)}</td></tr>`).join(''),
      'Queue empty — worker is scraping for more');
  };

  // 4. done log
  const done = q(`SELECT * FROM actions WHERE type IN ('email_send','li_easy_apply','portal_apply','li_connect') ORDER BY id DESC LIMIT 150`);
  const TYPE = { email_send: '✉ Email', li_easy_apply: '⚡ Easy Apply', portal_apply: '📋 Form', li_connect: '🔗 Connect' };
  const doneRows = done.map(a => {
    const c = a.result === 'ok' ? '#22c55e' : a.result === 'manual' ? '#f97316' : a.result === 'skip' ? '#64748b' : '#ef4444';
    return `<tr><td class="dim">${esc((a.ts || '').slice(5, 16))}</td><td>${TYPE[a.type] || esc(a.type)}</td><td class="role">${esc(a.role)}</td><td>${esc(a.company)}</td>
      <td class="dim">${esc((a.target || '').replace(/^https?:\/\/(www\.)?/, '').slice(0, 45))}</td><td><b style="color:${c}">${esc(a.result)}</b></td><td class="dim">${esc((a.detail || '').slice(0, 90))}</td></tr>`;
  }).join('');

  // 5. needs you
  const manual = q(`SELECT * FROM jobs WHERE status='needs_manual' ORDER BY updated_at DESC LIMIT 60`);
  const manualRows = manual.map(j => `<tr><td>${ago(j.posted_at || j.added_at)}</td><td>${CH[j.channel] || ''}</td><td class="role">${esc(j.role)}</td><td>${esc(j.company)}</td><td class="dim" style="max-width:420px">${esc(j.notes)}</td><td>${link(j.apply_url || j.url, 'finish ↗')}</td></tr>`).join('');

  // emails log
  const emails = q('SELECT * FROM emails_sent ORDER BY id DESC LIMIT 200');
  const emailLog = emails.map(e => `<tr><td class="dim">${esc((e.ts || '').slice(5, 16))}</td><td class="em">${esc(e.to_email)}</td><td>${esc(e.company)}</td><td class="role">${esc(e.role)}</td><td class="dim">${esc((e.subject || '').slice(0, 70))}</td><td><b style="color:${e.result === 'sent' ? '#22c55e' : '#f59e0b'}">${esc(e.result)}</b></td></tr>`).join('');

  // connects log
  const conns = q('SELECT * FROM connects ORDER BY id DESC LIMIT 100');
  const connRows = conns.map(c => `<tr><td class="dim">${esc((c.ts || '').slice(5, 16))}</td><td>${link(c.profile_url, esc(c.name || c.profile_url.split('/in/')[1]))}</td><td class="role">${esc(c.role)}</td><td>${esc(c.result)}</td><td class="dim">${esc((c.note || '').slice(0, 110))}</td></tr>`).join('');

  // 6. bank
  const bank = q(`SELECT * FROM jobs ${order} LIMIT 1500`);
  const bankRows = bank.map(j => `<tr data-s="${esc(j.status)}"><td>${ago(j.posted_at || j.added_at)}</td><td>${srcLabel(j.source)}</td><td class="role">${esc(j.role)}</td><td>${esc(j.company)}</td><td>${CH[j.channel] || '—'}</td><td class="em">${esc(j.email)}</td><td>${rel(j.relevance)}</td><td>${badge(j.status)}</td><td class="dim">${esc((j.notes || '').slice(0, 60))}</td><td>${link(j.apply_url || j.url)}</td></tr>`).join('');

  // 7. evolution — questions for you + open encounters + learned answers
  let pend = [], enc = [], learned = [];
  try { pend = q(`SELECT * FROM answers WHERE pending=1 ORDER BY seen DESC LIMIT 60`); } catch {}
  try { enc = q(`SELECT * FROM encounters WHERE status IN ('open','regressed') ORDER BY count DESC, last_seen DESC LIMIT 60`); } catch {}
  try { learned = q(`SELECT * FROM answers WHERE pending=0 AND answer!='' ORDER BY uses DESC, updated_at DESC LIMIT 100`); } catch {}
  const pendRows = pend.map(a => {
    const opts = (a.options || '').split(' | ').filter(Boolean);
    let rec = { value: '', basis: '' };
    try { rec = recommendAnswer(a.question, opts) || rec; } catch {}
    const recHint = rec.basis ? `<div class="dim" style="margin-top:4px">💡 recommended (${esc(rec.basis)})</div>` : '';
    let field;
    if (opts.length && opts.length <= 6) {
      // mark the recommended option
      field = opts.map(o => `<button class="opt${o === rec.value ? ' rec' : ''}" onclick="ans('${esc(a.qkey)}','${esc(o)}')">${esc(o)}${o === rec.value ? ' ✓' : ''}</button>`).join(' ');
    } else {
      // pre-fill the input with the recommendation; user edits or accepts
      const v = esc(rec.value || '');
      field = `<textarea class="ai" id="ai_${esc(a.qkey)}" rows="${rec.value && rec.value.length > 60 ? 3 : 1}" placeholder="type answer…">${v}</textarea><button class="opt" onclick="ans('${esc(a.qkey)}',document.getElementById('ai_${esc(a.qkey)}').value)">save</button>`;
    }
    return `<tr><td class="role" style="max-width:520px">${esc(a.question)}<div class="dim">asked ${a.seen}×</div>${recHint}</td><td>${field}</td></tr>`;
  }).join('');
  const encRows = enc.map(e => `<tr><td class="dim">#${e.id}</td><td><b>${esc(e.area)}</b></td><td class="dim">×${e.count}</td><td>${esc(e.domain)}</td><td class="role" style="max-width:460px">${esc(e.signature)}</td><td>${e.snapshot ? `<a href="/evidence/${esc(e.snapshot.replace(/\\\\/g, '/').split('/').pop())}.png" target="_blank">shot</a> · <a href="/evidence/${esc(e.snapshot.replace(/\\\\/g, '/').split('/').pop())}.html" target="_blank">html</a>` : ''}</td><td>${e.sample_url ? link(e.sample_url) : ''}</td></tr>`).join('');
  const learnRows = learned.map(a => `<tr><td class="role" style="max-width:460px">${esc(a.question)}</td><td class="em">${esc(a.answer)}</td><td class="dim">${esc(a.source)}</td><td class="dim">${a.uses}×</td></tr>`).join('');

  const statusCounts = q('SELECT status, COUNT(*) n FROM jobs GROUP BY status ORDER BY n DESC');
  const legend = Object.entries(STATUS).map(([k, [c, d]]) => `<div>${badge(k)} <span class="dim">${d}</span> <b>${statusCounts.find(s => s.status === k)?.n || 0}</b></div>`).join('');

  const hb = state.ts ? (Date.now() - Date.parse(state.ts)) / 1000 : 1e9;
  const live = hb < 600;
  const kpi = (v, l, c) => `<div class="k" style="border-top-color:${c}"><div class="kv" style="color:${c}">${v}</div><div class="kl">${l}</div></div>`;
  const qcard = (ch, label, c, doneSt) => `<a class="qc" href="#tab-${ch}" onclick="tab('${ch}')" style="border-color:${c}55"><div class="qh" style="color:${c}">${label}</div><div><b>${queueCount(ch)}</b> queued</div><div class="dim">${doneSt}</div></a>`;

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta http-equiv="refresh" content="45">
<title>Job Agent — ${esc(p.name || '')}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,'Segoe UI',sans-serif;background:#0b1220;color:#e2e8f0;font-size:13px}
a{color:#60a5fa;text-decoration:none}.dim{color:#64748b}.role{max-width:300px;color:#f1f5f9}.em{color:#22c55e;font-weight:600}
.hdr{padding:16px 28px;border-bottom:1px solid #1e293b;display:flex;justify-content:space-between;align-items:center;background:#0f172a}
.hdr h1{font-size:20px}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:7px}
.wrap{max-width:1750px;margin:0 auto;padding:18px 26px}
.ks{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}.k{background:#111a2e;border:1px solid #1e293b;border-top:3px solid;border-radius:10px;padding:12px 16px;min-width:120px}
.kv{font-size:28px;font-weight:800;line-height:1}.kl{font-size:11px;color:#94a3b8;margin-top:5px}
.qs{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px}.qc{display:block;background:#111a2e;border:1px solid;border-radius:10px;padding:12px 16px;color:#cbd5e1}
.qh{font-weight:800;font-size:14px;margin-bottom:4px}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:#94a3b8;margin:18px 0 8px}
table{width:100%;border-collapse:collapse;background:#111a2e;border:1px solid #1e293b;border-radius:8px;overflow:hidden}
th{background:#0f172a;color:#64748b;font-size:11px;text-transform:uppercase;text-align:left;padding:7px 9px;border-bottom:1px solid #1e293b}
td{padding:6px 9px;border-bottom:1px solid #16203a;vertical-align:top}tr:hover td{background:#0f172a}.empty{text-align:center;color:#475569;padding:18px}
.b{padding:1px 7px;border-radius:6px;font-size:11px;font-weight:700;border:1px solid}
.tabs{display:flex;gap:6px;margin-top:18px}.tabs button{background:#111a2e;color:#94a3b8;border:1px solid #1e293b;border-bottom:none;padding:8px 14px;border-radius:8px 8px 0 0;cursor:pointer;font-weight:600}
.tabs button.on{background:#1e293b;color:#fff}.pane{display:none}.pane.on{display:block}
.legend{display:grid;grid-template-columns:repeat(3,1fr);gap:6px 18px;background:#111a2e;border:1px solid #1e293b;border-radius:8px;padding:10px 14px;font-size:12px}
.banner{background:#111a2e;border:1px solid #1e293b;border-radius:8px;padding:9px 14px;margin-bottom:14px;font-size:12px}
input.s{background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:6px 10px;border-radius:6px;width:320px;margin-bottom:8px}
.opt{background:#1e293b;color:#e2e8f0;border:1px solid #3b82f6;border-radius:6px;padding:4px 10px;margin:2px;cursor:pointer;font-weight:600}
.opt:hover{background:#3b82f6}.ai{background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:4px 8px;border-radius:6px;width:420px;margin-right:6px;vertical-align:middle;font-family:inherit}
.opt.rec{background:#14532d;border-color:#22c55e;color:#bbf7d0}
.qbanner{background:#1a1407;border:1px solid #a16207;border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:13px;color:#fcd34d}
.loginbanner{background:#2a0a0a;border:1px solid #b91c1c;border-radius:8px;padding:12px 16px;margin-bottom:12px;font-size:14px;color:#fecaca}
.loginbtn{display:inline-block;background:#ef4444;color:#fff;font-weight:700;padding:5px 14px;border-radius:7px;text-decoration:none;margin:0 4px}
.loginbtn:hover{background:#dc2626}
.consentbar{background:#0b1f17;border:1px solid #166534;border-radius:8px;padding:9px 14px;margin-bottom:12px;font-size:12.5px;color:#bbf7d0}
.cbtn{border:none;border-radius:7px;padding:5px 12px;font-weight:700;cursor:pointer;margin-left:8px}
.cbtn.on{background:#22c55e;color:#06240f}.cbtn.off{background:#334155;color:#e2e8f0}
.stopbtn{margin-top:8px;background:#ef4444;color:#fff;border:none;border-radius:7px;padding:6px 14px;font-weight:700;cursor:pointer}
.stopbtn:hover{background:#dc2626}
</style></head><body>
<div class="hdr"><div><h1><span class="dot" style="background:${live ? '#22c55e' : '#ef4444'}"></span>Job Agent — ${esc(p.name || '')}</h1>
<div class="dim">${live ? `Worker LIVE · ${esc(Object.entries(state.lanes || {}).map(([k, v]) => k + ':' + (v.phase || '')).join(' · ').slice(0, 160)) || esc(state.phase || '')} · beat ${Math.round(hb)}s ago` : 'Worker not running'} · ${new Date().toLocaleString('en-GB')} · auto-refresh 20s</div></div>
<div style="text-align:right"><div class="kv" style="color:#60a5fa">${tot.jobs}</div><div class="dim">leads in bank</div>
${live ? `<button class="stopbtn" onclick="stopAll()">⏹ Stop worker</button>` : ''}</div></div>
<div class="wrap">
${state.loginNeeded && Object.keys(state.loginNeeded).length ? Object.entries(state.loginNeeded).map(([site, info]) => `<div class="loginbanner">🔑 <b>${esc(site)} needs you to log in.</b> ${esc(info.reason || '')} &nbsp;→&nbsp; <a class="loginbtn" href="${esc(info.url)}" target="_blank" rel="noopener">Open ${esc(site)} &amp; log in ↗</a> <span class="dim">(in the JobPilot Chrome window — the agent resumes automatically once you're back in)</span></div>`).join('') : ''}
<div class="consentbar">${p.consent?.autoContribute
  ? `🧬 <b>Self-contribution: ON.</b> JobPilot may file blocker issues and push <i>code/doc</i> improvements to the public repo (never your data). <button class="cbtn off" onclick="consent(false)">Turn off</button>`
  : `🧬 <b>Self-contribution: OFF.</b> JobPilot keeps every improvement local. Opt in to let it file issues &amp; push <i>code/doc</i> fixes back (hard-guarded — never your data/creds). <button class="cbtn on" onclick="consent(true)">Enable contributing back</button>`}</div>
${pend.length ? `<div class="qbanner">🧠 The agent needs <b>${pend.length}</b> answer${pend.length > 1 ? 's' : ''} from you to apply to more jobs → <a href="#tab-questions" onclick="tab('questions')" style="color:#fcd34d;text-decoration:underline">answer them in the Questions tab</a>. It remembers every answer forever.</div>` : ''}
<div class="ks">
${kpi(today.found, 'New leads (24h)', '#60a5fa')}${kpi(today.emails, 'Emails sent (24h)', '#22c55e')}${kpi(today.easy, 'Easy Applies (24h)', '#3b82f6')}${kpi(today.forms, 'Forms submitted (24h)', '#06b6d4')}${kpi(today.connects, 'Connects (24h)', '#a855f7')}
${kpi(tot.emailed, 'Unique emails, all-time', '#22c55e')}${kpi(tot.applied, 'Applied, all-time', '#3b82f6')}${kpi(tot.connected, 'Connected, all-time', '#a855f7')}${kpi(tot.manual, 'Needs you', '#f97316')}
</div>
<div class="qs">
${qcard('email', '✉ Email queue', '#22c55e', `${doneCount('emailed')} emailed`)}
${qcard('easy_apply', '⚡ Easy Apply queue', '#3b82f6', `${n(`SELECT COUNT(*) n FROM jobs WHERE status='applied' AND channel='easy_apply'`)} applied`)}
${qcard('form', '📋 External form queue', '#06b6d4', `${n(`SELECT COUNT(*) n FROM jobs WHERE status='applied' AND channel='form'`)} submitted`)}
${qcard('connect', '🔗 Connect queue', '#a855f7', `${doneCount('connected')} sent`)}
</div>

<h2>🔥 Fresh email leads — LinkedIn posts first, then the web (HN, Reddit, boards) · newest first</h2>
${table('emails', ['Posted', 'Source', 'Role', 'Company', 'Email', 'Match', 'Status', 'Result', 'Post'], emailRows, 'No email leads yet')}

<div class="tabs">
<button id="b-easy_apply" onclick="tab('easy_apply')">⚡ Easy Apply queue</button><button id="b-form" onclick="tab('form')">📋 Form queue</button>
<button id="b-connect" onclick="tab('connect')">🔗 Connect queue</button><button id="b-email" onclick="tab('email')">✉ Email queue</button>
<button id="b-done" onclick="tab('done')">✅ Done log</button><button id="b-manual" onclick="tab('manual')">🙋 Needs you (${manual.length})</button>
<button id="b-questions" onclick="tab('questions')" style="${pend.length ? 'color:#fcd34d;border-color:#a16207' : ''}">🧠 Questions (${pend.length})</button>
<button id="b-evolution" onclick="tab('evolution')">🧬 Evolution (${enc.length})</button>
<button id="b-sent" onclick="tab('sent')">📤 Emails sent</button><button id="b-conns" onclick="tab('conns')">🤝 Connects</button><button id="b-bank" onclick="tab('bank')">🗃 All leads</button></div>
<div class="pane" id="p-easy_apply">${queueTable('easy_apply', [], () => '')}</div>
<div class="pane" id="p-form">${queueTable('form', ['Portal'], j => `<td class="dim">${esc(j.portal)}</td>`)}</div>
<div class="pane" id="p-connect">${queueTable('connect', ['Poster'], j => `<td>${link(j.poster_url, esc(j.poster_name || 'profile'))}</td>`)}</div>
<div class="pane" id="p-email">${queueTable('email', ['Email'], j => `<td class="em">${esc(j.email)}</td>`)}</div>
<div class="pane" id="p-done">${table('done', ['When', 'Channel', 'Role', 'Company', 'Target', 'Result', 'Detail'], doneRows, 'Nothing done yet')}</div>
<div class="pane" id="p-manual">${table('manual', ['Posted', 'Channel', 'Role', 'Company', 'Why / unanswered questions', 'Link'], manualRows, 'Nothing needs you 🎉')}</div>
<div class="pane" id="p-questions"><p class="dim" style="margin-bottom:8px">Answer once — the agent reuses it on every future application and stops asking.</p>${table('questions', ['Question the agent hit', 'Your answer'], pendRows, 'No open questions 🎉 the agent is answering everything itself')}</div>
<div class="pane" id="p-evolution">
<p class="dim" style="margin-bottom:8px">Every failure the agent hit, grouped and counted, with a saved screenshot + HTML snapshot. Your coding agent reads <code>data/evolution/PLAYBOOK.md</code>, patches the code, and marks them fixed.</p>
${table('enc', ['#', 'Area', 'Count', 'Domain', 'Signature', 'Evidence', 'Sample'], encRows, 'No open encounters 🎉')}
<h2 style="margin-top:16px">Learned answers (${learned.length})</h2>
${table('learn', ['Question', 'Answer', 'Source', 'Uses'], learnRows, 'Nothing learned yet')}</div>
<div class="pane" id="p-sent">${table('sent', ['When', 'To', 'Company', 'Role', 'Subject', 'Result'], emailLog, 'No emails yet')}</div>
<div class="pane" id="p-conns">${table('conns', ['When', 'Person', 'About', 'Result', 'Note'], connRows, 'No connects yet')}</div>
<div class="pane" id="p-bank"><input class="s" placeholder="filter… (role, company, status, email)" oninput="flt(this.value)">
${table('bank', ['Posted', 'Source', 'Role', 'Company', 'Channel', 'Email', 'Match', 'Status', 'Notes', 'Link'], bankRows, 'Empty')}</div>

<h2>Status legend</h2><div class="legend">${legend}</div>
<p class="dim" style="margin-top:8px">“Posted” = age of the post/listing (green &lt;6h, lime &lt;24h, yellow &lt;3d). Queues are processed in priority order: Email (LinkedIn posts → web) → Easy Apply → Forms → Connect, newest first.</p>
</div>
<script>
function tab(t){document.querySelectorAll('.pane').forEach(e=>e.classList.toggle('on',e.id==='p-'+t));document.querySelectorAll('.tabs button').forEach(e=>e.classList.toggle('on',e.id==='b-'+t));history.replaceState(null,'','#tab-'+t)}
function flt(v){v=v.toLowerCase();document.querySelectorAll('#bank tbody tr').forEach(r=>r.style.display=r.innerText.toLowerCase().includes(v)?'':'none')}
async function ans(qkey, value){ if(!value){return}
  const base = (location.protocol==='file:'||!location.port) ? 'http://127.0.0.1:${UIPORT}' : '';
  const btn = event&&event.target; if(btn){btn.disabled=true; btn.textContent='saving…';}
  try{ const r = await fetch(base+'/api/answers',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({qkey,answer:value})}); if(!r.ok) throw new Error('HTTP '+r.status); location.href = base + '/#tab-questions'; location.reload(); }
  catch(e){ if(btn){btn.disabled=false; btn.textContent='save';} alert('Could not save — is the worker/server running? Open the dashboard at '+base+' (not the file). Error: '+e.message) } }
async function consent(on){
  const base = (location.protocol==='file:'||!location.port) ? 'http://127.0.0.1:${UIPORT}' : '';
  try{ const r = await fetch(base+'/api/consent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({autoContribute:on})}); if(!r.ok) throw new Error('HTTP '+r.status); location.reload(); }
  catch(e){ alert('Could not update consent — open the dashboard at '+base+'. Error: '+e.message) } }
async function stopAll(){
  if(!confirm('Stop the JobPilot worker? All four lanes halt within a few seconds. Your logged-in Chrome stays open.')) return;
  const base = (location.protocol==='file:'||!location.port) ? 'http://127.0.0.1:${UIPORT}' : '';
  const b=event&&event.target; if(b){b.disabled=true;b.textContent='Stopping…';}
  try{ const r=await fetch(base+'/api/stop',{method:'POST'}); if(!r.ok) throw new Error('HTTP '+r.status); if(b)b.textContent='Stopped ✓'; }
  catch(e){ if(b){b.disabled=false;b.textContent='⏹ Stop worker';} alert('Could not stop — open the dashboard at '+base+'. Error: '+e.message) } }
tab((location.hash.match(/tab-(\\w+)/)||[])[1]||'easy_apply');
</script></body></html>`;
  fs.writeFileSync(DASH, html, 'utf8');
  return DASH;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await initDB();
  writeDash();
  console.log('wrote ' + DASH);
}
