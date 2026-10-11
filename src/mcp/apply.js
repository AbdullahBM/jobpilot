// src/mcp/apply.js — Application capabilities.
// Fills forms using the user's PROFILE (answers matched semantically to field labels).
// Drives the logged-in Chrome. Returns structured outcome for the agent to reason on.
import { getContext } from '../agent/browser.js';
import { getProfile } from '../profile.js';
import fs from 'fs';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));

// ── Semantic answer: match a form-field label to a profile answer ─────────────
// Uses the user's own answers map first, then sensible fallbacks from profile.
function answerFor(label, profile) {
  const q = (label || '').toLowerCase();
  const a = profile.answers || {};

  // 1. Direct match against user's custom answers (by keyword overlap)
  for (const [key, val] of Object.entries(a)) {
    const words = key.toLowerCase().split(/\s+/);
    if (words.every(w => q.includes(w)) && words.length) return String(val);
  }

  // 2. Identity fallbacks from profile
  if (/first name/.test(q)) return profile.firstName || profile.name.split(' ')[0] || '';
  if (/last name|surname/.test(q)) return profile.lastName || profile.name.split(' ').slice(1).join(' ') || '';
  if (/full name|^name|your name/.test(q)) return profile.name || '';
  if (/email/.test(q)) return profile.email || '';
  if (/phone|mobile|contact number/.test(q)) return profile.phone || '';
  if (/linkedin/.test(q)) return profile.links.linkedin || '';
  if (/github/.test(q)) return profile.links.github || '';
  if (/portfolio|personal site|website/.test(q)) return profile.links.portfolio || profile.links.website || '';
  if (/city|location|where.*based/.test(q)) return profile.location || '';
  if (/salary|compensation|expected pay/.test(q)) return profile.preferences.minSalary ? String(profile.preferences.minSalary) : '';
  if (/notice period|start date|available/.test(q)) return a['notice period'] || '2 weeks';
  if (/visa|sponsor|authoriz/.test(q)) return a['visa'] || '';
  if (/relocat/.test(q)) return a['relocate'] || 'Open to remote';
  if (/remote/.test(q)) return 'Yes, remote preferred';
  if (/cover letter|why.*apply|motivation|tell us/.test(q)) return a['cover letter'] || buildCover(profile);

  return ''; // unknown — agent decides whether to skip or supply
}

function buildCover(profile) {
  const projLine = (profile.projects || []).slice(0, 2).map(p => p.name).join(', ');
  return [
    `Hi, I'm ${profile.name}.`,
    (profile.preferences.roles || []).length ? `I'm looking for ${profile.preferences.roles[0]} roles.` : '',
    projLine ? `Recent work: ${projLine}.` : '',
    profile.links.portfolio ? `Portfolio: ${profile.links.portfolio}` : '',
    profile.links.linkedin ? `LinkedIn: ${profile.links.linkedin}` : '',
  ].filter(Boolean).join(' ');
}

// ── Fill + submit a portal application form (Greenhouse/Lever/Ashby/generic) ──
export async function fillAndSubmit({ url, timeoutMs = 60000, submit = true }) {
  const profile = getProfile();
  const ctx = await getContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(timeoutMs);

  let fieldsFound = 0, fieldsFilled = 0, submitted = false;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await SLEEP(2500);

    const fields = await page.locator('input:visible, textarea:visible, select:visible').all().catch(() => []);
    fieldsFound = fields.length;

    for (const field of fields) {
      try {
        const type = await field.evaluate(el => el.tagName.toLowerCase() + ':' + (el.type || '')).catch(() => '');
        if (type.startsWith('input:file')) {
          if (profile.cvPath && fs.existsSync(profile.cvPath)) {
            await field.setInputFiles(profile.cvPath).catch(() => {});
            fieldsFilled++;
          }
          continue;
        }
        if (/submit|button|checkbox|radio|hidden/.test(type)) continue;

        const label = await field.evaluate(el => {
          const id = el.id;
          const lbl = id ? document.querySelector(`label[for="${id}"]`)?.innerText : '';
          return lbl || el.placeholder || el.getAttribute('aria-label') || el.name || '';
        }).catch(() => '');

        const answer = answerFor(label, profile);
        if (!answer) continue;

        if (type.startsWith('select')) {
          const opts = await field.locator('option').all().catch(() => []);
          for (const opt of opts) {
            const txt = (await opt.textContent().catch(() => '') || '').toLowerCase();
            if (txt.includes(answer.toLowerCase().slice(0, 8))) {
              const val = await opt.getAttribute('value').catch(() => '');
              await field.selectOption(val).catch(() => {});
              break;
            }
          }
        } else {
          await field.fill(answer).catch(() => {});
        }
        fieldsFilled++;
      } catch {}
    }

    // Submit — getByRole first (works on React forms), then CSS fallbacks
    if (submit) {
      try {
        const btn = page.getByRole('button', { name: /submit application|submit|apply now|send application/i }).first();
        if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await btn.click();
          await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          submitted = true;
        }
      } catch {}
      if (!submitted) {
        for (const sel of ["button[type='submit']", "input[type='submit']", "#submit_app", "button.application-submit", "button[data-form-submit]"]) {
          try {
            const btn = page.locator(sel).first();
            await btn.waitFor({ timeout: 2500, state: 'visible' });
            await btn.click();
            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
            submitted = true;
            break;
          } catch {}
        }
      }
    }

    await page.close().catch(() => {});
    return { ok: true, submitted, fieldsFound, fieldsFilled, detail: submitted ? 'submitted' : `filled ${fieldsFilled}/${fieldsFound}, manual submit needed` };
  } catch (e) {
    await page.close().catch(() => {});
    return { ok: false, submitted: false, fieldsFound, fieldsFilled, detail: e.message.slice(0, 200) };
  }
}

// ── LinkedIn Easy Apply ───────────────────────────────────────────────────────
export async function linkedinEasyApply({ url, timeoutMs = 60000 }) {
  const profile = getProfile();
  const ctx = await getContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(timeoutMs);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await SLEEP(2500);

    const eaBtn = page.locator("button.jobs-apply-button, button:has-text('Easy Apply')").first();
    try { await eaBtn.waitFor({ timeout: 8000, state: 'visible' }); await eaBtn.click(); await SLEEP(1500); }
    catch { await page.close().catch(() => {}); return { ok: true, result: 'no_easy_apply', detail: 'No Easy Apply button (external application)' }; }

    for (let step = 0; step < 12; step++) {
      const questions = await page.locator('.jobs-easy-apply-form-element, .fb-form-element').all().catch(() => []);
      for (const q of questions) {
        try {
          const label = await q.locator('label, legend').first().textContent().catch(() => '');
          const answer = answerFor(label, profile);
          const input = q.locator("input:not([type='hidden']):not([type='submit']), textarea").first();
          if (answer && await input.isVisible().catch(() => false)) await input.fill(answer).catch(() => {});
        } catch {}
      }
      // CV upload
      if (profile.cvPath && fs.existsSync(profile.cvPath)) {
        await page.locator("input[type='file']").all()
          .then(fis => fis.forEach(fi => fi.setInputFiles(profile.cvPath).catch(() => {}))).catch(() => {});
      }

      const submitBtn = page.locator("button:has-text('Submit application')").first();
      if (await submitBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
        await submitBtn.click(); await SLEEP(2000);
        await page.close().catch(() => {});
        return { ok: true, result: 'applied', detail: `applied at step ${step}` };
      }
      let moved = false;
      for (const txt of ['Next', 'Continue', 'Review']) {
        try { await page.locator(`button:has-text('${txt}')`).first().click({ timeout: 2500 }); await SLEEP(1200); moved = true; break; } catch {}
      }
      if (!moved) break;
    }

    await page.close().catch(() => {});
    return { ok: true, result: 'partial', detail: 'form started, needs manual completion' };
  } catch (e) {
    await page.close().catch(() => {});
    return { ok: false, result: 'error', detail: e.message.slice(0, 200) };
  }
}

export { answerFor, buildCover };

// ── LinkedIn DM (message) a poster, or connect-with-note as fallback ──────────
import { getContext as _getCtx } from '../agent/browser.js';

function outreachNote(profile, role, company) {
  const who = company ? ` at ${company}` : '';
  const links = [profile.links?.portfolio, profile.links?.linkedin].filter(Boolean)[0];
  return `Hi${profile.name ? '' : ''}, saw your post about the ${role || 'role'}${who}. I build production AI systems — RAG, agents, backend on AWS. Would love to be considered.${links ? ' ' + links : ''}`.slice(0, 290);
}

/** Try to DM the poster. Returns {ok, result:'dm_sent'|'no_dm'|'error'}. */
export async function linkedinDM({ profileUrl, role, company, timeoutMs = 45000 }) {
  const profile = getProfile();
  const ctx = await _getCtx();
  const page = await ctx.newPage();
  page.setDefaultTimeout(timeoutMs);
  try {
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await SLEEP(2500);
    // Find a "Message" button (only present for 1st-degree / open-profile)
    const msgBtn = page.locator("button:has-text('Message'), a:has-text('Message')").first();
    if (!await msgBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await page.close().catch(() => {});
      return { ok: true, result: 'no_dm', detail: 'No Message button (not connected) — use connect instead' };
    }
    await msgBtn.click(); await SLEEP(1500);
    const box = page.locator("div.msg-form__contenteditable[contenteditable='true'], div[aria-label*='message']").first();
    await box.click().catch(() => {});
    await box.fill(outreachNote(profile, role, company)).catch(() => {});
    await SLEEP(600);
    const send = page.locator("button.msg-form__send-button, button:has-text('Send')").first();
    await send.click({ timeout: 4000 });
    await SLEEP(1200);
    await page.close().catch(() => {});
    return { ok: true, result: 'dm_sent', detail: 'DM sent to poster' };
  } catch (e) {
    await page.close().catch(() => {});
    return { ok: false, result: 'error', detail: e.message.slice(0, 160) };
  }
}

/** Send a connection request with a note. Returns {ok, result:'connected'|'pending'|'error'}. */
export async function linkedinConnect({ profileUrl, role, company, timeoutMs = 45000 }) {
  const profile = getProfile();
  const ctx = await _getCtx();
  const page = await ctx.newPage();
  page.setDefaultTimeout(timeoutMs);
  try {
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await SLEEP(2500);
    // Connect may be behind the "More" menu
    let connect = page.locator("button:has-text('Connect'), button[aria-label*='Connect']").first();
    if (!await connect.isVisible({ timeout: 4000 }).catch(() => false)) {
      await page.locator("button:has-text('More'), button[aria-label*='More actions']").first().click({ timeout: 3000 }).catch(() => {});
      await SLEEP(800);
      connect = page.locator("div[role='button']:has-text('Connect'), button:has-text('Connect')").first();
    }
    if (!await connect.isVisible({ timeout: 4000 }).catch(() => false)) {
      await page.close().catch(() => {});
      return { ok: true, result: 'no_connect', detail: 'No Connect button available' };
    }
    await connect.click(); await SLEEP(1200);
    const addNote = page.locator("button:has-text('Add a note')").first();
    if (await addNote.isVisible({ timeout: 2500 }).catch(() => false)) {
      await addNote.click(); await SLEEP(600);
      await page.locator("textarea[name='message'], #custom-message").first().fill(outreachNote(profile, role, company)).catch(() => {});
      await SLEEP(500);
    }
    await page.locator("button:has-text('Send'), button:has-text('Send invitation'), button[aria-label*='Send']").first().click({ timeout: 4000 });
    await SLEEP(1200);
    await page.close().catch(() => {});
    return { ok: true, result: 'connected', detail: 'Connection request + note sent' };
  } catch (e) {
    await page.close().catch(() => {});
    return { ok: false, result: 'error', detail: e.message.slice(0, 160) };
  }
}
