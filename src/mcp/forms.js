// src/mcp/forms.js — External application forms (Greenhouse, Lever, Ashby, Workable, generic).
// Resolves short links, hops from job-description pages to the actual form, fills every field
// with the answer engine (incl. react-select comboboxes, radio groups, consent boxes), uploads
// the CV, refuses to submit while REQUIRED fields are still unknown, and verifies a
// confirmation page. result: submitted | needs_manual | no_form | error
import { getContext } from '../agent/browser.js';
import { getProfile } from '../profile.js';
import { textAnswer, choiceAnswer, coverText } from './answers.js';
import { encounter, askLater, learn } from '../evolve.js';
import fs from 'fs';
import { cvAttachmentForJob } from '../cv.js';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));
const CONFIRM_RE = /thank(s| you) for (applying|your (application|interest))|application (has been |was )?(received|submitted|sent)|we.?ve received your application|successfully (applied|submitted)/i;

const SCAN = () => {
  const vis = el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return (r.width > 0 || r.height > 0 || el.type === 'file' || el.type === 'radio' || el.type === 'checkbox') && s.visibility !== 'hidden'; };
  const qOf = el => {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l?.innerText.trim()) return l.innerText; }
    if (el.type !== 'radio' && el.type !== 'checkbox') { const l = el.closest('label'); if (l?.innerText.trim()) return l.innerText; }
    const fs = el.closest('fieldset'); const lg = fs?.querySelector('legend'); if (lg?.innerText.trim()) return lg.innerText;
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const lb = el.getAttribute('aria-labelledby'); if (lb) { const t = lb.split(' ').map(i => document.getElementById(i)?.innerText || '').join(' '); if (t.trim()) return t; }
    let p = el.parentElement;
    for (let i = 0; i < 6 && p; i++, p = p.parentElement) { const lab = p.querySelector('label, .application-label, [class*="label"]'); if (lab && lab.innerText.trim() && !lab.contains(el)) return lab.innerText; }
    return el.placeholder || el.name || '';
  };
  const out = []; let i = 0;
  for (const el of document.querySelectorAll('input, select, textarea')) {
    if (el.type === 'hidden' || el.type === 'submit' || el.disabled || !vis(el)) continue;
    if (el.closest('[aria-hidden="true"]') && el.type !== 'file') continue;
    const id = 'jf' + (i++); el.setAttribute('data-jf', id);
    const lab = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : el.closest('label');
    const q = (qOf(el) || '').replace(/\s+/g, ' ').trim();
    let val = el.tagName === 'SELECT' ? (el.selectedIndex > 0 ? el.options[el.selectedIndex].text : '') : el.value;
    if (el.getAttribute('role') === 'combobox' && !val) {
      const c = el.closest('[class*="select__control"]') || el.closest('[class*="select-shell"]') || el.parentElement?.parentElement?.parentElement;
      const t = c ? c.innerText.replace(/^(select\.*|start typing.*)$/im, '').trim() : '';
      if (t && !/^select/i.test(t)) val = t;
    }
    out.push({ id, tag: el.tagName, type: el.type, name: el.name, role: el.getAttribute('role') || '', q: q.slice(0, 300), optLabel: (lab?.innerText || el.value || '').trim().slice(0, 120),
      val, checked: !!el.checked,
      opts: el.tagName === 'SELECT' ? [...el.options].map(o => o.text.trim()) : undefined,
      required: el.required || el.getAttribute('aria-required') === 'true' || /\*\s*$|\*\s*\n|required/i.test(q) });
  }
  return out;
};

// Job-board description pages (not real forms). Their apply link redirects to the true ATS.
const BOARD_HOST = /(^|\.)(remoteok\.com|remotive\.com|jobicy\.com|himalayas\.app|weworkremotely\.com|wellfound\.com|arbeitnow\.com|aihackerjobs\.com)$/i;
const hostOf = u => { try { return new URL(u).hostname; } catch { return ''; } };

// ── Indeed: extract the real ATS link embedded in the posting, or fall back to
//    connect/email so the lead still gets actioned rather than silently dropped.
async function resolveIndeed(page) {
  // Indeed embeds the employer's apply URL in a data attribute or an <a> tag inside
  // the job posting detail. Try the most common selectors first.
  const atsUrl = await page.evaluate(() => {
    // 1. "Apply on company website" button href
    const ext = document.querySelector('a[data-indeed-apply-joburl], a[href*="indeedapply"], .jobsearch-IndeedApplyButton-newDesign a');
    if (ext?.href && !ext.href.includes('indeed.com')) return ext.href;

    // 2. Metadata inside the apply widget
    const meta = document.querySelector('[data-indeed-apply-apitoken], [data-indeed-apply-joburl]');
    if (meta) {
      const u = meta.getAttribute('data-indeed-apply-joburl') || meta.getAttribute('action');
      if (u && !u.includes('indeed.com')) return u;
    }

    // 3. Any visible "Apply" link pointing off indeed.com
    for (const a of document.querySelectorAll('a[href]')) {
      const txt = (a.innerText || '').toLowerCase();
      if ((txt.includes('apply') || txt.includes('company site')) && !a.href.includes('indeed.com')) return a.href;
    }
    return null;
  }).catch(() => null);

  return atsUrl || null;
}

// ── Glassdoor: click the "Apply on company site" CTA and return the destination URL.
async function resolveGlassdoor(page) {
  const btn = page.getByRole('link', { name: /apply on (company site|employer site)|apply now/i })
    .or(page.locator('a[data-test="job-link"], a.applyButton').first());
  if (!(await btn.first().isVisible({ timeout: 6000 }).catch(() => false))) return null;

  const ctx = page.context();
  const [popup] = await Promise.all([
    ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null),
    btn.first().click({ timeout: 8000 }).catch(() => {}),
  ]);

  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    const dest = popup.url();
    await popup.close().catch(() => {});
    if (dest && !dest.includes('glassdoor.com')) return dest;
  }

  // Glassdoor navigates in the same tab sometimes
  await SLEEP(3000);
  const current = page.url();
  if (!current.includes('glassdoor.com')) return current;
  return null;
}

// ── WeWorkRemotely: the "Apply for this job" button links directly to the employer's URL.
async function resolveWeWorkRemotely(page) {
  // WWR posts an <a class="button"> with href pointing to the real application URL.
  const atsUrl = await page.evaluate(() => {
    // Primary: the green "Apply for this job" button on the detail page
    for (const a of document.querySelectorAll('a.button, a.wwr-button, section.apply a, .listing-header-container a')) {
      const txt = (a.innerText || '').toLowerCase();
      if ((txt.includes('apply') || txt.includes('job')) && a.href && !a.href.includes('weworkremotely.com')) return a.href;
    }
    // Fallback: any off-domain link in the job body
    for (const a of document.querySelectorAll('.listing-container a[href], .job-listing a[href]')) {
      if (a.href && !a.href.includes('weworkremotely.com') && /apply|careers|job/i.test(a.href + a.innerText)) return a.href;
    }
    return null;
  }).catch(() => null);

  return atsUrl || null;
}

async function toForm(page) {
  const u = page.url();
  if (/jobs\.lever\.co\/[^/]+\/[0-9a-f-]{36}$/.test(u)) { await page.goto(u + '/apply', { waitUntil: 'domcontentloaded' }); return; }
  if (/jobs\.ashbyhq\.com\/[^/]+\/[0-9a-f-]{36}\/?$/.test(u)) { await page.goto(u.replace(/\/$/, '') + '/application', { waitUntil: 'domcontentloaded' }); return; }

  const startHost = hostOf(u);
  const onBoard = BOARD_HOST.test(startHost);
  // On a real ATS page that already shows a form, stop.
  if (!onBoard) {
    const fileInputs = await page.locator('input[type="file"]').count();
    const textInputs = await page.locator('input[type="text"]:visible, input[type="email"]:visible').count();
    if (fileInputs || textInputs >= 2) return;
  }

  // Collect candidate apply links; on job boards follow them to the external ATS.
  const links = await page.locator('a:visible').evaluateAll(as => as
    .filter(a => /apply/i.test((a.innerText || '') + (a.getAttribute('aria-label') || '')))
    .map(a => a.href).filter(Boolean));
  const ctx = page.context();
  // Prefer links that already point off the board to a known ATS.
  const FORM_HOST = /greenhouse|lever\.co|ashbyhq|workable|smartrecruiters|breezy|recruitee|bamboohr|jobvite|teamtailor|rippling|personio|forms\.gle|google\.com\/forms|typeform|tally\.so/i;
  const direct = links.find(l => FORM_HOST.test(l));
  if (direct) { await page.goto(direct, { waitUntil: 'domcontentloaded' }).catch(() => {}); await SLEEP(2500); return followRedirect(page, startHost); }

  const btn = page.getByRole('link', { name: /apply (now|for this job|to this)|^apply$|i.?m interested/i }).or(page.getByRole('button', { name: /apply (now|for this job)|^apply$/i })).first();
  if (await btn.isVisible().catch(() => false)) {
    const [popup] = await Promise.all([ctx.waitForEvent('page', { timeout: 6000 }).catch(() => null), btn.click().catch(() => {})]);
    if (popup) { await popup.waitForLoadState('domcontentloaded').catch(() => {}); const url = popup.url(); await popup.close().catch(() => {}); await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {}); }
    await SLEEP(3000);
    return followRedirect(page, startHost);
  }
}

// Boards often use an interstitial /l/<id> that 302s to the ATS. If we're still on the
// board host, click the apply link once more and wait for the host to change.
async function followRedirect(page, startHost) {
  for (let i = 0; i < 2 && hostOf(page.url()) === startHost; i++) {
    const relay = await page.locator('a[href*="/l/"], a[rel~="external"], meta[http-equiv="refresh"]').first();
    const href = await page.locator('a:visible', { hasText: /apply/i }).first().getAttribute('href').catch(() => '');
    if (href && hostOf(href) !== startHost) { await page.goto(href, { waitUntil: 'domcontentloaded' }).catch(() => {}); await SLEEP(2500); }
    else break;
  }
}


async function fillAll(page, unknown, job = {}) {
  const p = getProfile();
  const cvPath = cvAttachmentForJob(job, p);
  const fields = await page.evaluate(SCAN);
  const radios = {};
  for (const f of fields) {
    const loc = page.locator(`[data-jf="${f.id}"]`);
    try {
      if (f.type === 'file') {
        const isCover = /cover/i.test(f.q + f.name);
        if (!isCover && cvPath && fs.existsSync(cvPath)) { await loc.setInputFiles(cvPath); await SLEEP(1500); }
        continue;
      }
      if (f.type === 'radio') { (radios[f.name || f.q] ||= []).push(f); continue; }
      if (f.type === 'checkbox') {
        if (!f.checked && (/agree|consent|acknowledge|privacy|terms|confirm|certify/i.test(f.q + f.optLabel) || f.required)) await loc.check({ force: true }).catch(() => {});
        continue;
      }
      if (f.tag === 'SELECT') {
        if (f.val) continue;
        const pick = choiceAnswer(f.q, f.opts.slice(1)) ; if (pick) await loc.selectOption({ label: pick }).catch(() => {}); else if (f.required) unknown.add(f.q);
        continue;
      }
      if (f.val && f.val.trim()) continue;
      if (f.role === 'combobox' || /select/i.test(f.q) && f.tag === 'INPUT' && f.type === 'text' && await loc.getAttribute('aria-autocomplete').catch(() => null)) {
        // react-select: open, read options, pick
        await loc.click().catch(() => {}); await SLEEP(600);
        const opts = await page.locator('[role="option"]').allInnerTexts().catch(() => []);
        let pick = opts.length ? choiceAnswer(f.q, opts) : textAnswer(f.q);
        if (!opts.length && pick) { await loc.fill(pick); await SLEEP(1200); }
        const key = pick ? pick.split(/[\s+(]/).filter(Boolean)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
        const opt = key ? page.locator('[role="option"]').filter({ hasText: new RegExp('^\\s*' + key, 'i') }).first() : page.locator('[role="option"]').first();
        if (await opt.isVisible().catch(() => false)) await opt.click().catch(() => {});
        else { await loc.press('Enter').catch(() => {}); if (f.required && !pick) unknown.add(f.q); }
        await page.keyboard.press('Escape').catch(() => {});
        continue;
      }
      const numeric = f.type === 'number';
      let v = textAnswer(f.q, { numeric });
      if ((v == null || v === '') && f.tag === 'TEXTAREA') v = coverText(p);
      if (v == null || v === '') { if (f.required) unknown.add(f.q); continue; }
      await loc.fill(String(v));
      if (/location|city/i.test(f.q)) { await SLEEP(1200); const o = page.locator('[role="option"], .pac-item').first(); if (await o.isVisible().catch(() => false)) await o.click().catch(() => {}); }
    } catch {}
  }
  for (const g of Object.values(radios)) {
    if (g.some(r => r.checked)) continue;
    const pick = choiceAnswer(g[0].q, g.map(r => r.optLabel));
    const r = g.find(x => x.optLabel === pick) || g[0];
    await page.locator(`[data-jf="${r.id}"]`).check({ force: true }).catch(() => {});
  }
  return fields.length;
}

export async function applyForm({ url, timeoutMs = 120000, submit = true, job = {} }) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(15000);
  const unknown = new Set();
  const t0 = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await SLEEP(3500);
    await toForm(page);
    await SLEEP(1500);
    const finalUrl = page.url();

    // ── Indeed: try to extract the real ATS link before bailing out.
    if (/indeed\.com/.test(finalUrl)) {
      const atsLink = await resolveIndeed(page);
      if (atsLink) {
        await page.goto(atsLink, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await SLEEP(2500);
        // fall through and let the rest of applyForm handle the real ATS page
      } else {
        await encounter('form', 'indeed.com — no external ATS link found; routing to connect/email', { url: finalUrl, page });
        return { ok: false, result: 'needs_manual', detail: 'indeed.com — route via connect or email', finalUrl };
      }
    }

    // ── Glassdoor: click through to the employer's ATS.
    if (/glassdoor\.com/.test(page.url())) {
      const atsLink = await resolveGlassdoor(page);
      if (atsLink) {
        await page.goto(atsLink, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await SLEEP(2500);
      } else {
        await encounter('form', 'glassdoor.com — "Apply on company site" not found; routing to connect/email', { url: page.url(), page });
        return { ok: false, result: 'needs_manual', detail: 'glassdoor.com — route via connect or email', finalUrl };
      }
    }

    // ── WeWorkRemotely: resolve the employer's direct apply URL.
    if (/weworkremotely\.com/.test(page.url())) {
      const atsLink = await resolveWeWorkRemotely(page);
      if (atsLink) {
        await page.goto(atsLink, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await SLEEP(2500);
      } else {
        await encounter('form', 'weworkremotely.com — no external apply link found', { url: page.url(), page });
        return { ok: false, result: 'needs_manual', detail: 'weworkremotely.com — no external apply link', finalUrl };
      }
    }

    if (/linkedin\.com\/(login|authwall)/.test(page.url())) { await encounter('form', 'redirected to linkedin login/authwall', { url: page.url(), page }); return { ok: false, result: 'needs_manual', detail: 'redirected to ' + page.url().slice(0, 80), finalUrl }; }
    if (/workday|myworkdayjobs|icims|taleo|successfactors|oraclecloud|brassring/.test(finalUrl)) return { ok: false, result: 'needs_manual', detail: 'account-gated ATS (Workday/iCIMS/Taleo) — one-click for you', finalUrl };

    let n = await fillAll(page, unknown, job);
    if (n < 2) {
      // still on a job-board description page with no real form → hand off with the direct link
      if (BOARD_HOST.test(hostOf(finalUrl))) { await encounter('form', 'job-board page, no external ATS form found on ' + hostOf(finalUrl), { url: finalUrl, page }); return { ok: false, result: 'needs_manual', detail: 'board page — open the apply link manually', finalUrl }; }
      await encounter('form', 'no application form found on ' + hostOf(finalUrl), { url: finalUrl, page });
      return { ok: false, result: 'no_form', detail: 'no application form found', finalUrl };
    }
    await SLEEP(800);
    n = await fillAll(page, unknown, job); // second pass: conditional fields that appeared

    // recompute unknown required: only those still empty
    const still = (await page.evaluate(SCAN)).filter(f => f.required && f.type !== 'file' && f.type !== 'checkbox' && (f.type === 'radio' ? false : !String(f.val || '').trim()));
    if (process.env.DEBUG_FORMS) console.log('STILL', JSON.stringify(still, null, 1));
    const missing = still.map(f => f.q).filter(Boolean);
    if (missing.length) { missing.forEach(q => askLater(q)); return { ok: false, result: 'needs_manual', detail: 'unknown required: ' + missing.slice(0, 4).join(' | ').slice(0, 300), questions: missing, finalUrl }; }
    if (!submit) return { ok: true, result: 'dry_run_ready', detail: `filled ${n} fields`, finalUrl };

    // Prefer an explicit submit control (Workable's `[data-ui="apply-button"]`, Greenhouse/Lever
    // `button[type=submit]`) before falling back to the generic accessible-name match. The
    // submit button usually sits at the very bottom of a long form, so it can be below the fold
    // where a sticky footer/overlay intercepts a plain click — hence the scroll + forced + JS
    // click fallbacks instead of a single click() that hangs until the actionability timeout.
    const btn = page.locator(
      'button[data-ui="apply-button"], [data-ui="submit"], button[type="submit"]:not([aria-disabled="true"])'
    ).first()
      .or(page.getByRole('button', { name: /submit application|submit|send application|apply now|^apply$/i }).last());
    if (!(await btn.isVisible().catch(() => false))) { await encounter('form', 'form filled but no submit button on ' + hostOf(finalUrl), { url: finalUrl, page }); return { ok: false, result: 'needs_manual', detail: 'no submit button', finalUrl }; }
    await btn.scrollIntoViewIfNeeded().catch(() => {});
    await SLEEP(300);
    let clicked = await btn.click({ timeout: 8000 }).then(() => true).catch(() => false);
    if (!clicked) clicked = await btn.click({ force: true, timeout: 5000 }).then(() => true).catch(() => false);
    if (!clicked) clicked = await btn.evaluate(el => { el.click(); return true; }).catch(() => false);
    if (!clicked) { await encounter('form', 'submit button not clickable on ' + hostOf(finalUrl), { url: finalUrl, page }); return { ok: false, result: 'needs_manual', detail: 'submit button not clickable', finalUrl }; }
    for (let i = 0; i < 20; i++) {
      await SLEEP(1000);
      const t = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (CONFIRM_RE.test(t) || /\/(thanks|thank-you|confirmation|success)/i.test(page.url())) return { ok: true, result: 'submitted', detail: 'confirmation page shown', finalUrl };
      if (/captcha|verify you are human/i.test(t) && i > 4) return { ok: false, result: 'needs_manual', detail: 'captcha after submit', finalUrl };
    }
    const errs = await page.locator('[role="alert"], .error, [class*="error"]').allInnerTexts().catch(() => []);
    await encounter('form', 'submitted but no confirmation on ' + hostOf(page.url()), { url: page.url(), page });
    return { ok: false, result: 'needs_manual', detail: 'no confirmation; ' + errs.filter(Boolean).slice(0, 3).join(' | ').slice(0, 200), finalUrl };
  } catch (e) {
    await encounter('form', 'exception: ' + e.message.split('\n')[0], { url, page }).catch(() => {});
    return { ok: false, result: 'error', detail: e.message.slice(0, 200) };
  } finally { await page.close().catch(() => {}); }
}
