// src/mcp/connect.js — LinkedIn connection request with a personalized note (2026 UI).
// Robust to the two profile layouts:
//   A) primary action = "Connect" / "Invite <name> to connect" (button or link) in the top card
//   B) primary action = "Follow"; Connect lives under the top-card "More" menu as a role=link
// Scopes to the MAIN column (x<850) so sidebar "Invite ... to connect" buttons are never clicked.
// Note is attached when LinkedIn allows it; if the free note quota is exhausted it sends without one.
// result: connected | connected_no_note | already_pending | already_connected | no_connect | limit | error
import { getContext } from '../agent/browser.js';
import { getProfile } from '../profile.js';
import { encounter } from '../evolve.js';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));

export function connectNote({ posterName, role, company }) {
  const p = getProfile();
  const first = (posterName || '').split(/\s+/)[0];
  const hi = /^[A-Z][a-z]{1,15}$/.test(first) ? `Hi ${first}, ` : 'Hi, ';
  const r = role && role.length < 45 ? role : 'the role';
  const co = company && company.length < 30 ? ` at ${company}` : '';
  const yrs = p.yearsExperience ? `${p.yearsExperience}+ yrs ` : '';
  const skills = (p.skills || []).slice(0, 3).join('/') || 'software';
  let note = `${hi}saw your post about ${r}${co}. I'm a ${p.headline || 'software engineer'} (${yrs}${skills}) and would love to be considered — happy to share my CV. ${p.links?.portfolio || ''}`;
  if (note.length > 200) note = `${hi}saw your post about ${r}${co}. ${p.headline || 'Engineer'}, ${yrs}${skills}. Would love to be considered. ${p.links?.portfolio || ''}`;
  return note.slice(0, 200);
}

// first matching button/link in the MAIN column (not the sidebar)
async function mainCol(page, re) {
  for (const role of ['button', 'link']) {
    const loc = page.getByRole(role, { name: re });
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const el = loc.nth(i);
      const inAside = await el.evaluate(e => !!e.closest('aside')).catch(() => true);
      if (inAside) continue;
      const b = await el.boundingBox().catch(() => null);
      if (b && b.x < 850 && b.y > 60) return el;
    }
  }
  return null;
}

export async function connect({ profileUrl, posterName, role, company, withNote = true, dryRun = false }) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(12000);
  try {
    await page.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await SLEEP(3000);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await SLEEP(800);

    const main = page.locator('main');
    if (await mainCol(page, /^pending$/i)) { await page.close(); return { ok: true, result: 'already_pending', detail: 'invite already pending' }; }
    const mtext = await main.innerText().catch(() => '');
    if (/\b1st\b|· 1st/.test(mtext.slice(0, 400))) { await page.close(); return { ok: true, result: 'already_connected', detail: '1st-degree already' }; }

    // A) direct Connect in the main column
    let connectEl = await mainCol(page, /^connect$|^invite .* to connect$/i);
    // B) under the main-column More menu
    if (!connectEl) {
      const more = await mainCol(page, /^more$/i);
      if (more) { await more.click().catch(() => {}); await SLEEP(1200); connectEl = page.getByRole('link', { name: /invite .* to connect|^connect$/i }).first(); if (!await connectEl.count().catch(() => 0)) connectEl = page.getByRole('menuitem', { name: /^connect/i }).first(); }
    }
    if (!connectEl || !(await connectEl.count().catch(() => 0))) {
      await encounter('connect', 'no Connect control (follow-only or restricted)', { url: profileUrl, page });
      await page.close(); return { ok: true, result: 'no_connect', detail: 'no Connect option (follow-only / limits)' };
    }
    await connectEl.click().catch(() => {});
    await SLEEP(2600);
    if (process.env.DEBUG_CONN) console.log('after connect click; addNote count', await page.getByRole('button', { name: /add a note/i }).count());

    // note dialog (may be in shadow — getByRole pierces it)
    let usedNote = false;
    const note = connectNote({ posterName, role, company });
    if (withNote) {
      const addNote = page.getByRole('button', { name: /add a note/i }).first();
      if (await addNote.isVisible().catch(() => false)) {
        await addNote.click(); await SLEEP(1000);
        const ta = page.locator('textarea').first();
        await ta.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        if (await ta.isVisible().catch(() => false)) { await ta.fill(note); await SLEEP(400); usedNote = true; }
        else if (process.env.DEBUG_CONN) console.log('textarea not visible after addNote');

        // LinkedIn opens a Premium upsell instead of the note editor once the
        // free custom-note quota is exhausted. Dismiss it and continue with a
        // normal invitation; a connection request should not fail just because
        // an optional note is unavailable.
        const premiumText = await page.locator('body').innerText().catch(() => '');
        const premiumCopy = page.getByText(/out of free custom notes|send unlimited personalized invites/i).first();
        const premiumDialog = premiumCopy.locator('xpath=ancestor::*[@role="dialog"][1]');
        const premiumVisible = await premiumDialog.isVisible().catch(() => false);
        if (premiumVisible || /out of free custom notes|send unlimited personalized invites|restart premium/i.test(premiumText)) {
          usedNote = false;
          const dismiss = premiumVisible
            ? premiumDialog.getByRole('button', { name: /dismiss|close/i }).first()
            : page.getByRole('button', { name: /dismiss|close/i }).last();
          await dismiss.click({ timeout: 2500 }).catch(() => page.keyboard.press('Escape').catch(() => {}));
          await SLEEP(800);
        }
      } else if (process.env.DEBUG_CONN) console.log('addNote not visible');
    }
    if (dryRun) { await page.keyboard.press('Escape').catch(() => {}); await SLEEP(400); await page.getByRole('button', { name: /discard/i }).first().click({ timeout: 2500 }).catch(() => {}); await page.close(); return { ok: true, result: usedNote ? 'dry_note_ready' : 'dry_ready', detail: 'reached send' + (usedNote ? ' with note' : ''), note: usedNote ? note : '' }; }

    // The invite dialog (role=dialog / artdeco modal, or the 2026 native <dialog>) carries the
    // Send control. Scope to it so we don't match a stray "Send" elsewhere (messaging/video),
    // and give it a moment to mount after the Connect/Add-note click.
    // 2026 LinkedIn uses a native <dialog open> — don't filter by has-text("invitation") since
    // that text may not be in the dialog; just find the dialog that has a send/connect button.
    const SEND_RE = /send without a note|send invitation|send now|^send$/i;
    const inviteDlg = page.locator(
      'div[role="dialog"], .artdeco-modal, dialog[open]'
    ).filter({ has: page.getByRole('button', { name: SEND_RE }) }).first();
    await inviteDlg.waitFor({ state: 'visible', timeout: 6000 }).catch(() => {});
    const dlgScope = (await inviteDlg.count().catch(() => 0)) ? inviteDlg : page;
    let send = dlgScope.getByRole('button', { name: SEND_RE }).first();
    // short retry: the button can be briefly disabled/animating right after the dialog opens
    let sendVisible = false;
    for (let i = 0; i < 6 && !sendVisible; i++) { sendVisible = await send.isVisible().catch(() => false); if (!sendVisible) await SLEEP(700); }
    if (!sendVisible) {
      // 2026 LinkedIn sometimes sends immediately on Connect click (no dialog / quota exhausted note path)
      // Check: Pending button, or "Pending" text anywhere in the top card area
      if (await mainCol(page, /^pending$/i)) { await page.close(); return { ok: true, result: 'connected_no_note', detail: 'invite sent instantly (no dialog)' }; }
      const bodyTxt = await page.locator('main').innerText().catch(() => '');
      if (/pending/i.test(bodyTxt.slice(0, 1000))) { await page.close(); return { ok: true, result: 'connected_no_note', detail: 'invite sent (pending state detected)' }; }
      // Also try a broader send button scan on the full page as last resort
      const pageSend = page.getByRole('button', { name: SEND_RE }).first();
      if (await pageSend.isVisible().catch(() => false)) {
        sendVisible = true;
        await pageSend.click({ timeout: 5000 }).catch(() => {});
        await SLEEP(2000);
        await page.close();
        return { ok: true, result: 'connected_no_note', detail: 'invite sent via page-level send button' };
      }
      await encounter('connect', 'send button not found in invite dialog', { url: profileUrl, page });
      await page.close(); return { ok: false, result: 'error', detail: 'send button not found in invite dialog' };
    }
    await send.scrollIntoViewIfNeeded().catch(() => {});
    let sent = await send.click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (!sent) sent = await send.click({ force: true, timeout: 3000 }).then(() => true).catch(() => false);
    if (!sent) await send.evaluate(el => el.click()).catch(() => {});
    await SLEEP(2200);
    const txt = await page.locator('body').innerText().catch(() => '');
    if (/weekly invitation limit|reached the weekly|you.?ve reached/i.test(txt)) { await page.close(); return { ok: false, result: 'limit', detail: 'LinkedIn weekly invitation limit reached' }; }
    const pending = !!(await mainCol(page, /^pending$/i)) || /invitation sent|pending/i.test(txt.slice(0, 3000));
    await page.close();
    return pending
      ? { ok: true, result: usedNote ? 'connected' : 'connected_no_note', detail: usedNote ? 'invite + note sent' : 'invite sent (note quota likely exhausted)', note: usedNote ? note : '' }
      : { ok: false, result: 'error', detail: 'no Pending state after send' };
  } catch (e) {
    await encounter('connect', 'exception: ' + e.message.split('\n')[0], { url: profileUrl, page }).catch(() => {});
    await page.close().catch(() => {});
    return { ok: false, result: 'error', detail: e.message.slice(0, 160) };
  }
}
