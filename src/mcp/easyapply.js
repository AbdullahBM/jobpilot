// src/mcp/easyapply.js — LinkedIn Easy Apply driver (2026 UI: native <dialog>, obfuscated classes).
// Self-evolving:
//   • HARVESTS every prefilled answer LinkedIn shows (= your past answers) into evolution memory
//   • unknown required questions → "questions for you" (asked once, reused forever)
//   • anything unexpected → an encounter with a DOM snapshot for the coding agent to fix
//   • success is VERIFIED by reloading the job and reading "Application submitted"
import { getContext } from '../agent/browser.js';
import { getProfile } from '../profile.js';
import { textAnswer, choiceAnswer } from './answers.js';
import { learn, askLater, encounter } from '../evolve.js';
import fs from 'fs';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));
const APPLIED_RE = /Application submitted|Applied \d+ (second|minute|hour|day)s? ago|You applied|application was sent/i;

// In-page: tag every field in the dialog and describe it.
const SCAN = (dlg) => {
  const qOf = (el) => {
    const root = el.getRootNode();
    if (el.type !== 'radio' && el.type !== 'checkbox' && el.id) {
      const l = root.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l?.innerText.trim()) return l.innerText;
    }
    const fs = el.closest('fieldset'); const lg = fs?.querySelector('legend'); if (lg?.innerText.trim()) return lg.innerText;
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    if (el.type === 'radio' || el.type === 'checkbox') {
      // walk up past the options block to the first line that is real question text
      let p = el.parentElement;
      for (let i = 0; i < 10 && p && p !== dlg; i++, p = p.parentElement) {
        const line = (p.innerText || '').split('\n').map(s => s.trim()).find(s => s.length > 8 && !/^(yes|no)$/i.test(s));
        if (line && p.querySelectorAll('input[type="radio"], input[type="checkbox"]').length < 12) return line;
      }
    }
    let p = el.parentElement;
    for (let i = 0; i < 8 && p && p !== dlg; i++, p = p.parentElement) {
      const t = (p.innerText || '').trim();
      if (t.length > 3 && t.length < 600 && (/[?*]/.test(t) || p.querySelectorAll('input,select,textarea').length > 1)) return t.split('\n').find(s => s.trim().length > 3) || t;
    }
    return el.placeholder || el.name || '';
  };
  const out = []; let i = 0; const nonce = Math.random().toString(36).slice(2, 7);
  for (const el of dlg.querySelectorAll('input, select, textarea')) {
    if (el.type === 'hidden' || el.disabled) continue;
    const id = 'ja' + nonce + (i++); el.setAttribute('data-ja', id);
    const root = el.getRootNode();
    const lbl = el.id ? root.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    const q = (qOf(el) || '').replace(/\s+/g, ' ').trim();
    out.push({
      id, tag: el.tagName, type: el.type, name: el.name, role: el.getAttribute('role') || '',
      q: q.replace(/\s*\*\s*$/, '').slice(0, 300),
      elId: el.id,
      optLabel: ((el.closest('[role="radio"]')?.innerText || '').trim() || lbl?.innerText.trim() || el.closest('label')?.innerText.trim() || (el.value && el.value !== 'on' ? el.value : '') || el.closest('[role="radio"]')?.getAttribute('aria-label') || '').trim().split('\n')[0],
      val: el.tagName === 'SELECT' ? (el.selectedIndex > 0 ? el.options[el.selectedIndex].text : '') : (el.value || ''),
      checked: !!el.checked,
      opts: el.tagName === 'SELECT' ? [...el.options].map(o => o.text.trim()) : undefined,
      required: el.required || el.getAttribute('aria-required') === 'true' || /\*/.test(q),
      numeric: el.type === 'number' || /numeric/i.test(el.id) || el.getAttribute('inputmode') === 'numeric',
    });
  }
  const errors = [...dlg.querySelectorAll('[role="alert"], [aria-live], .artdeco-inline-feedback--error')]
    .map(e => e.innerText.trim()).filter(t => t && /required|valid|enter|select|must|between|larger|smaller|whole number|decimal/i.test(t));
  const text = dlg.innerText.replace(/\s+/g, ' ');
  return { fields: out, errors, progress: (text.match(/(\d+)\/(\d+) pages|(\d+)%/) || [''])[0], heading: (dlg.querySelector('h3, h2')?.innerText || '').trim(), text: text.slice(0, 300) };
};

const IDENTITY = /^(email|phone|mobile|first name|last name|city|location|country code|phone country code)/i;

async function fillPage(page, dlg, ctx) {
  const { fields } = await dlg.evaluate(SCAN);
  const p = getProfile();
  const groups = {};
  for (const f of fields) if (f.type === 'radio') (groups[f.name || f.q] ||= []).push(f);
  // Checkbox GROUPS: LinkedIn renders "select all that apply" / single-select questions as a set
  // of role="checkbox" wrappers around hidden inputs. The `required` flag lives on the group, not
  // each input, so handling them one-by-one leaves the group empty and the page can't advance.
  const cbGroups = {};
  for (const f of fields) if (f.type === 'checkbox') (cbGroups[f.q] ||= []).push(f);
  // A real multi-option question = 2+ checkboxes sharing one question. Standalone checkboxes
  // (single consent/privacy/terms boxes) are still handled inline in the per-field loop.
  const groupedCbIds = new Set();
  for (const [q, g] of Object.entries(cbGroups)) if (g.length >= 2 && q && q.length > 8) g.forEach(f => groupedCbIds.add(f.id));

  for (const f of fields) {
    const loc = page.locator(`[data-ja="${f.id}"]`);
    try {
      if (f.type === 'file') {
        if (p.cvPath && fs.existsSync(p.cvPath) && /resume|cv/i.test(f.q) && !fields.some(x => x.type === 'radio' && x.checked && /resume/i.test(x.q))) await loc.setInputFiles(p.cvPath).catch(() => {});
        continue;
      }
      if (f.type === 'radio') continue;
      if (f.type === 'checkbox') {
        if (groupedCbIds.has(f.id)) continue; // part of a multi-option question → handled below
        if (!f.checked && f.required) await loc.check({ force: true }).catch(() => {});
        if (f.checked && /follow/i.test(f.q + f.optLabel)) await loc.uncheck({ force: true }).catch(() => {});
        continue;
      }
      if (f.tag === 'SELECT') {
        if (f.val && !/select an option/i.test(f.val)) { if (!IDENTITY.test(f.q)) learn(f.q, f.val, 'harvested'); continue; }
        const pick = choiceAnswer(f.q, f.opts.slice(1));
        if (pick) await loc.selectOption({ label: pick }).catch(() => {});
        else if (f.required) { ctx.unanswered.add(f.q); askLater(f.q, f.opts.slice(1)); }
        continue;
      }
      if (f.val && f.val.trim()) { if (!IDENTITY.test(f.q) && f.q.length > 8) learn(f.q, f.val.trim(), 'harvested'); continue; }
      const numeric = f.numeric || /how many|years|number of|salary|compensation|ctc|rate|expectation/i.test(f.q);
      const v = textAnswer(f.q, { numeric });
      if (v == null || v === '') { if (f.required) { ctx.unanswered.add(f.q); askLater(f.q); } continue; }
      await loc.fill(String(v));
      ctx.used.push(f.q);
      if (f.role === 'combobox' || /city|location/i.test(f.q)) {
        await SLEEP(1200);
        const opt = page.locator('[role="listbox"] [role="option"]').first();
        if (await opt.isVisible().catch(() => false)) await opt.click().catch(() => {});
        else await loc.press('ArrowDown').then(() => loc.press('Enter')).catch(() => {});
      }
    } catch {}
  }
  for (const g of Object.values(groups)) {
    // resume picker (radio-group of CV files) — LinkedIn preselects the latest; leave it
    if (/^radio-group|resume|cv/i.test(g[0].q) || g.every(r => /\.(pdf|docx?)$/i.test(r.optLabel))) continue;
    const learnable = g[0].q.length > 8 && !/^radio-group/.test(g[0].q);
    const checked = g.find(r => r.checked);
    if (checked) { if (learnable && checked.optLabel) learn(g[0].q, checked.optLabel, 'harvested'); continue; }
    const pick = choiceAnswer(g[0].q, g.map(r => r.optLabel));
    if (process.env.DEBUG_EA) console.log('RADIO', JSON.stringify({ q: g[0].q, opts: g.map(r => r.optLabel), pick }));
    if (!pick) { ctx.unanswered.add(g[0].q); if (learnable) askLater(g[0].q, g.map(r => r.optLabel)); continue; }
    // The role=radio WRAPPER carries aria-label=question and the visible option text.
    // Clicking the wrapper is what registers (hidden <input> ignores synthetic clicks).
    const wrap = dlg.getByRole('radio', { name: g[0].q, exact: false }).filter({ hasText: new RegExp(`^\\s*${pick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i') }).first();
    let okRadio = false;
    if (await wrap.count().catch(() => 0)) { await wrap.click({ timeout: 3000 }).catch(() => {}); okRadio = await wrap.getAttribute('aria-checked').then(v => v === 'true').catch(() => false); }
    if (!okRadio) { // fallback: data-ja input's role=radio ancestor
      const loc = page.locator(`[data-ja="${g.find(x => x.optLabel === pick)?.id || g[0].id}"]`);
      await loc.locator('xpath=ancestor::*[@role="radio"][1]').click({ timeout: 2500 }).catch(() => {});
      okRadio = await loc.isChecked().catch(() => false);
    }
    if (process.env.DEBUG_EA) console.log('  radio checked:', okRadio);
    ctx.used.push(g[0].q);
  }

  // Checkbox GROUPS (multi-option "select all that apply" / single-select questions).
  for (const [q, g] of Object.entries(cbGroups)) {
    if (g.length < 2 || !q || q.length <= 8) continue;       // standalone consent handled inline
    if (g.some(c => c.checked)) { if (q.length > 8) learn(q, g.filter(c => c.checked).map(c => c.optLabel).join(', '), 'harvested'); continue; }
    const labels = g.map(c => c.optLabel).filter(Boolean);
    // Pick the matching option(s) from the user's profile/answers; if nothing matches, prefer a
    // safe neutral option ("Other"/"None") so a required group never blocks the page, else ask.
    let picks = [];
    const choice = choiceAnswer(q, labels);
    if (choice) picks = [choice];
    if (!picks.length) { const other = labels.find(l => /^(other|none|n\/?a|prefer not)/i.test(l)); if (other) picks = [other]; }
    if (process.env.DEBUG_EA) console.log('CBGROUP', JSON.stringify({ q, opts: labels, picks }));
    if (!picks.length) {
      if (g[0].required) { ctx.unanswered.add(q); askLater(q, labels); }
      continue;
    }
    for (const pick of picks) {
      // Click the role=checkbox WRAPPER (hidden input ignores synthetic clicks), same as radios.
      const esc = pick.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const wrap = dlg.locator('[role="checkbox"]').filter({ hasText: new RegExp(`^\\s*${esc}\\s*$`, 'i') }).first();
      let okCb = false;
      if (await wrap.count().catch(() => 0)) { await wrap.click({ timeout: 3000 }).catch(() => {}); okCb = await wrap.getAttribute('aria-checked').then(v => v === 'true').catch(() => false); }
      if (!okCb) {
        const f = g.find(x => x.optLabel === pick) || g[0];
        const loc = page.locator(`[data-ja="${f.id}"]`);
        await loc.locator('xpath=ancestor::*[@role="checkbox"][1]').click({ timeout: 2500 }).catch(() => {});
        await loc.check({ force: true }).catch(() => {});
      }
    }
    ctx.used.push(q);
  }
}

async function discard(page) {
  await page.locator('dialog').getByRole('button', { name: /dismiss|close/i }).first().click({ timeout: 3000 }).catch(() => {});
  await SLEEP(800);
  await page.getByRole('button', { name: /discard/i }).first().click({ timeout: 3000 }).catch(() => {});
}

async function verifyApplied(page, url) {
  const body = await page.evaluate(() => document.body.innerText).catch(() => '');
  if (APPLIED_RE.test(body)) return true;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await SLEEP(3000);
  const main = await page.evaluate(() => (document.querySelector('main') || document.body).innerText.slice(0, 2500)).catch(() => '');
  return APPLIED_RE.test(main);
}

/**
 * Apply via Easy Apply. Returns {ok, result, detail, questions?, meta, externalUrl?}
 * result: applied | already_applied | no_easy_apply | needs_answers | stuck | closed | error | dry_run_ready
 */
export async function easyApply({ url, timeoutMs = 120000, dryRun = false }) {
  const bctx = await getContext();
  const page = await bctx.newPage();
  page.setDefaultTimeout(15000);
  const t0 = Date.now();
  const ctx = { unanswered: new Set(), used: [] };
  let meta = {};
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await SLEEP(3000);
    meta = await page.evaluate(() => {
      const main = (document.querySelector('main') || document.body).innerText;
      return { posted: (main.match(/(\d+\s+(minute|hour|day|week|month)s?\s+ago)/) || [])[1] || '', head: main.slice(0, 1500) };
    });
    // LinkedIn daily submission cap: "We limit daily submissions ... Save this job and apply tomorrow."
    if (/limit daily submissions|apply tomorrow|reached your daily|daily (submission|application) limit|limit.{0,30}submissions/i.test(meta.head)) {
      await encounter('easy_apply', 'linkedin daily submission limit reached', { url, page });
      await page.close(); return { ok: false, result: 'daily_limit', detail: 'LinkedIn daily Easy Apply limit reached — pausing Easy Apply until tomorrow', meta };
    }
    // LinkedIn anti-bot throttle: a security checkpoint / "unusual activity" / rate-limit page.
    if (/security check|security verification|unusual activity|doing that too (much|often|fast)|try again later|rate limit|you.?ve reached|temporarily (restricted|blocked)|verify you.?re a human|captcha|\/checkpoint\//i.test(meta.head + ' ' + page.url())) {
      await encounter('easy_apply', 'linkedin anti-bot throttle / checkpoint', { url, page });
      await page.close(); return { ok: false, result: 'throttled', detail: 'LinkedIn security check / rate limit — backing off', meta };
    }
    if (APPLIED_RE.test(meta.head)) { await page.close(); return { ok: true, result: 'already_applied', detail: 'LinkedIn shows already applied', meta }; }
    if (/no longer accepting applications/i.test(meta.head)) { await page.close(); return { ok: true, result: 'closed', detail: 'no longer accepting applications', meta }; }

    const ea = page.getByRole('button', { name: /easy apply/i }).first();
    if (!(await ea.isVisible().catch(() => false))) {
      const ext = page.getByRole('button', { name: /^apply/i }).or(page.getByRole('link', { name: /^apply/i })).first();
      let extUrl = '';
      if (await ext.isVisible().catch(() => false)) {
        const [popup] = await Promise.all([bctx.waitForEvent('page', { timeout: 8000 }).catch(() => null), ext.click().catch(() => {})]);
        if (popup) { await popup.waitForLoadState('domcontentloaded').catch(() => {}); extUrl = popup.url(); await popup.close().catch(() => {}); }
      }
      await page.close();
      return { ok: true, result: 'no_easy_apply', detail: extUrl ? 'external: ' + extUrl : 'no Easy Apply button', externalUrl: extUrl, meta };
    }
    await ea.click();
    let dlg = page.locator('dialog').filter({ has: page.getByRole('button', { name: /next|review|submit|continue/i }) }).first();
    await dlg.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
    if (!(await dlg.isVisible().catch(() => false))) {
      // safety/"job search safety reminder" interstitial → continue
      const cont = page.getByRole('button', { name: /continue applying|^continue$/i }).first();
      if (await cont.isVisible().catch(() => false)) { await cont.click(); await dlg.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {}); }
    }
    // If we matched a "Job search safety reminder" dialog (no real form fields), dismiss it and re-find the real apply dialog.
    if (await dlg.isVisible().catch(() => false)) {
      const dlgText = await dlg.innerText().catch(() => '');
      if (/safety reminder|safety tips|research the company|report suspicious/i.test(dlgText)) {
        const contBtn = dlg.getByRole('link', { name: /continue applying/i }).or(dlg.getByRole('button', { name: /continue applying/i })).first();
        if (await contBtn.isVisible().catch(() => false)) {
          await contBtn.click().catch(() => {});
          await SLEEP(1500);
          // re-select the actual apply dialog (not the safety one)
          dlg = page.locator('dialog').filter({ has: page.getByRole('button', { name: /next|review|submit/i }) }).first();
          await dlg.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
        }
      }
    }
    if (!(await dlg.isVisible().catch(() => false))) {
      await encounter('easy_apply', 'dialog did not open', { url, page });
      await page.close(); return { ok: false, result: 'error', detail: 'Easy Apply dialog did not open', meta };
    }

    let lastProgress = '', same = 0;
    for (let step = 0; step < 15 && Date.now() - t0 < timeoutMs; step++) {
      await fillPage(page, dlg, ctx);
      await SLEEP(500);
      const submit = dlg.getByRole('button', { name: /submit application/i }).first();
      if (await submit.isVisible().catch(() => false)) {
        if (dryRun) { await discard(page); await page.close(); return { ok: true, result: 'dry_run_ready', detail: `reached submit at step ${step}`, meta }; }
        await submit.click();
        await SLEEP(3500);
        await page.getByRole('button', { name: /^done$|dismiss/i }).first().click({ timeout: 3000 }).catch(() => {});
        const ok = await verifyApplied(page, url);
        if (!ok) await encounter('easy_apply', 'submit clicked but not confirmed', { url, page });
        await page.close().catch(() => {});
        return { ok, result: ok ? 'applied' : 'stuck', detail: ok ? `submitted + verified (${step + 1} pages)` : 'submit not confirmed', meta, used: ctx.used };
      }
      const next = dlg.getByRole('button', { name: /continue to next step|review your application|^next$|^review$/i }).first();
      if (!(await next.isVisible().catch(() => false))) { await encounter('easy_apply', 'no next/submit button', { url, page, scope: dlg }); break; }
      await next.click().catch(() => {});
      await SLEEP(1600);
      const st = await dlg.evaluate(SCAN).catch(() => ({ progress: '', errors: [] }));
      if (st.progress === lastProgress && st.progress) {
        same++;
        // a validation error usually means a numeric field got text, or a choice we didn't pick
        for (const f of st.fields.filter(f => f.required && !f.val && !f.checked && f.type !== 'radio' && f.type !== 'checkbox')) { ctx.unanswered.add(f.q); askLater(f.q, f.opts?.slice(1) || []); }
        if (same >= 2) {
          if (!ctx.unanswered.size) await encounter('easy_apply', `stuck on page "${st.heading}": ${st.errors.join(' | ')}`, { url, page, scope: dlg });
          break;
        }
      } else same = 0;
      lastProgress = st.progress;
    }
    await discard(page);
    await page.close().catch(() => {});
    const qs = [...ctx.unanswered];
    return qs.length
      ? { ok: false, result: 'needs_answers', detail: 'needs your answer: ' + qs.slice(0, 4).join(' | ').slice(0, 300), questions: qs, meta }
      : { ok: false, result: 'stuck', detail: 'could not advance (see Evolution tab)', meta };
  } catch (e) {
    await encounter('easy_apply', 'exception: ' + e.message.split('\n')[0], { url, page }).catch(() => {});
    await discard(page).catch(() => {});
    await page.close().catch(() => {});
    return { ok: false, result: 'error', detail: e.message.slice(0, 200), questions: [...ctx.unanswered], meta };
  }
}
