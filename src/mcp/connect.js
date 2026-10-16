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

// ── Shared Send-button regex ──────────────────────────────────────────────────
// Matches all known LinkedIn 2026 Send-button labels. Used by findSendButton,
// the custom-invite block, and the classic dialog block so they all match the
// same label set. Never matches the ad-feedback "Submit" text.
const SEND_RE = /send without a note|send invitation|send now|^send$/i;

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

// ── Unified Send-button resolver ──────────────────────────────────────────────
// Returns the first matching Playwright Locator for the real Send control within
// `scope`, or null. Uses OR'd strategies in priority order, all excluding <aside>
// and the ad-feedback "Submit" buttons. This is shared by both the custom-invite
// and classic-dialog code paths so that encounter #20 has a single fix point.
//
// Strategies (tried in order):
//  1. role=button by accessible name (aria-label OR visible text matching SEND_RE)
//  2. aria-label containing "send" on buttons/links not in aside
//  3. button / role=button filtered by visible text matching SEND_RE, not in aside
//  4. LAST RESORT: button[type="submit"] / input[type="submit"] — ONLY when the
//     same scope also contains a <textarea> (the note form), AND the button is not
//     in <aside>. This prevents matching the ad-feedback "Submit" buttons that
//     caused encounter #20 (×48).
//
// When requireEnabled is true (default), candidates must also pass isEnabled().
async function findSendButton(scope, { requireEnabled = true } = {}) {
  // Strategy 1: role=button by accessible name (aria-label + visible text)
  const byRole = scope.getByRole('button', { name: SEND_RE });
  const byRoleCount = await byRole.count().catch(() => 0);
  for (let i = 0; i < byRoleCount; i++) {
    const el = byRole.nth(i);
    const inAside = await el.evaluate(e => !!e.closest('aside')).catch(() => true);
    if (inAside) continue;
    const vis = await el.isVisible().catch(() => false);
    if (!vis) continue;
    if (requireEnabled) {
      const en = await el.isEnabled().catch(() => false);
      if (!en) continue;
    }
    return el;
  }

  // Strategy 2: aria-label containing "send" on buttons/links not in aside
  const byAria = scope.locator('[aria-label*="send" i]:not(aside [aria-label*="send" i])');
  const byAriaCount = await byAria.count().catch(() => 0);
  for (let i = 0; i < byAriaCount; i++) {
    const el = byAria.nth(i);
    const vis = await el.isVisible().catch(() => false);
    if (!vis) continue;
    // Double-check not in aside (CSS :not may not cover all nesting)
    const inAside = await el.evaluate(e => !!e.closest('aside')).catch(() => true);
    if (inAside) continue;
    if (requireEnabled) {
      const en = await el.isEnabled().catch(() => false);
      if (!en) continue;
    }
    return el;
  }

  // Strategy 3: button / role=button filtered by visible text matching SEND_RE
  const allBtns = scope.locator('button, [role="button"]');
  const allBtnsCount = await allBtns.count().catch(() => 0);
  for (let i = 0; i < allBtnsCount; i++) {
    const el = allBtns.nth(i);
    const vis = await el.isVisible().catch(() => false);
    if (!vis) continue;
    const inAside = await el.evaluate(e => !!e.closest('aside')).catch(() => true);
    if (inAside) continue;
    const txt = await el.innerText().catch(() => '');
    if (!SEND_RE.test(txt.trim())) continue;
    if (requireEnabled) {
      const en = await el.isEnabled().catch(() => false);
      if (!en) continue;
    }
    return el;
  }

  // Strategy 4: type=submit ONLY when scope has a textarea (the note form)
  const hasTa = await scope.locator('textarea').count().catch(() => 0);
  if (hasTa > 0) {
    const submitBtns = scope.locator('button[type="submit"], input[type="submit"]');
    const submitCount = await submitBtns.count().catch(() => 0);
    for (let i = 0; i < submitCount; i++) {
      const el = submitBtns.nth(i);
      const inAside = await el.evaluate(e => !!e.closest('aside')).catch(() => true);
      if (inAside) continue;
      const vis = await el.isVisible().catch(() => false);
      if (!vis) continue;
      if (requireEnabled) {
        const en = await el.isEnabled().catch(() => false);
        if (!en) continue;
      }
      return el;
    }
  }

  return null;
}

// ── JS-evaluate Send-button finder (last resort, bypasses Playwright locators) ─
// Returns true if a send button was found and clicked, false otherwise.
// Mirrors the same label set and aside exclusion as findSendButton.
async function jsFindAndClickSend(page) {
  return page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, input[type="submit"], [role="button"]')];
    const sendRe = /^send$|send invitation|send without a note|send now/i;
    const target = btns.find(b => {
      if (b.offsetParent === null) return false;
      if (b.closest('aside')) return false;
      const txt = (b.textContent || b.value || b.getAttribute('aria-label') || '').trim();
      // Only match type=submit when inside a form/dialog with a textarea (invite note form)
      if (b.type === 'submit' && !sendRe.test(txt)) {
        const inNoteForm = !!b.closest('form:has(textarea), div[role="dialog"]:has(textarea), dialog:has(textarea)');
        return inNoteForm && !b.disabled;
      }
      return sendRe.test(txt) && !b.disabled;
    });
    if (target) { target.disabled = false; target.click(); return true; }
    return false;
  }).catch(() => false);
}

// LinkedIn opens a Premium upsell ("Send unlimited personalized invites with Premium" /
// "You're out of free custom notes") instead of the note editor once the free custom-note quota
// is exhausted — see the saved connect encounter (screenshot shows the modal with only a
// Dismiss/Close × and an "Upgrade to Premium" button; no Send/textarea). A connection request
// should not fail just because an optional note is unavailable, so detect + dismiss it everywhere
// an invite note path can be reached, then continue sending the invite note-less.
// Returns true when the upsell was present and dismissed, else false.
async function dismissPremiumUpsell(page) {
  const copyRe = /out of free custom notes|send unlimited personalized invites|unlimited personalized invites with premium|upgrade to premium|restart premium/i;
  const bodyText = await page.locator('body').innerText().catch(() => '');
  const premiumCopy = page.getByText(copyRe).first();
  const premiumDialog = premiumCopy.locator('xpath=ancestor::*[@role="dialog"][1]');
  const premiumVisible = await premiumDialog.isVisible().catch(() => false);
  if (!premiumVisible && !copyRe.test(bodyText)) return false;
  const dismiss = premiumVisible
    ? premiumDialog.getByRole('button', { name: /dismiss|close/i }).first()
    : page.getByRole('button', { name: /dismiss|close/i }).last();
  await dismiss.click({ timeout: 2500 }).catch(() => page.keyboard.press('Escape').catch(() => {}));
  await SLEEP(800);
  return true;
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
    // Step 6: fast-track follow-only profiles. When no Connect/Invite control was found
    // but a main-column "Follow" button exists, classify immediately as no_connect rather
    // than falling through into a dead invite path that later misfires as encounter #20.
    if (!connectEl || !(await connectEl.count().catch(() => 0))) {
      const hasFollow = await mainCol(page, /^follow /i);
      const detail = hasFollow
        ? 'no Connect option (follow-only profile)'
        : 'no Connect option (follow-only / limits)';
      await encounter('connect', 'no Connect control (follow-only or restricted)', { url: profileUrl, page });
      await page.close(); return { ok: true, result: 'no_connect', detail };
    }
    // LinkedIn 2026: the Connect control is often an <a href="/preload/custom-invite/?vanityName=...">
    // that NAVIGATES the page (full navigation, not an overlay). We capture the URL before clicking
    // so we can detect navigation and handle the custom-invite page directly.
    const urlBefore = page.url();
    // LinkedIn can leave a transparent/stale overlay over the visible top-card control. Retry
    // with a forced trusted click, then a DOM click, before waiting for the invite UI; otherwise
    // the driver waits on a dialog that the first click never opened.
    let connectClicked = await connectEl.click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (!connectClicked) connectClicked = await connectEl.click({ force: true, timeout: 3000 }).then(() => true).catch(() => false);
    if (!connectClicked) connectClicked = await connectEl.evaluate(el => { el.click(); return true; }).catch(() => false);
    // Wait up to 6 s for either: a dialog to appear, OR a navigation away from the profile page.
    // LinkedIn 2026 uses a SPA router that may change the URL without firing waitForNavigation —
    // so we poll the URL manually as well.
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 6000 }).catch(() => {}),
      page.waitForSelector('dialog[open], div[role="dialog"], [data-test-modal]', { timeout: 6000 }).catch(() => {}),
      // Poll for URL change (covers SPA navigation that doesn't fire waitForNavigation)
      (async () => {
        for (let i = 0; i < 12; i++) {
          await SLEEP(500);
          if (page.url() !== urlBefore) return;
        }
      })(),
    ]).catch(() => {});
    await SLEEP(1000);
    const urlAfter = page.url();
    // navigated is true when the URL changed. The extra guard `!urlAfter.includes(urlBefore)` is
    // intentionally relaxed: only keep it for non-linkedin domains where one URL could embed another.
    // For LinkedIn profile → custom-invite navigation, the URLs share the linkedin.com domain but
    // differ in path, so a simple inequality check is sufficient and more reliable.
    const navigated = urlAfter !== urlBefore;

    if (process.env.DEBUG_CONN) console.log('after connect click; url:', urlAfter, 'navigated:', navigated);

    // note dialog (may be in shadow — getByRole pierces it)
    let usedNote = false;
    const note = connectNote({ posterName, role, company });

    // ── Custom-invite page (LinkedIn 2026 navigation flow) ────────────────────────
    // When the connect <a> navigates to /preload/custom-invite/ (or similar), the page
    // renders a standalone invite form with a textarea (the note) and a submit button.
    // Fill the textarea directly — there is no "Add a note" intermediate button.
    // Also handle the case where `navigated` is false but we're already on the custom-invite page
    // (LinkedIn SPA router sometimes changes the URL without firing Playwright's waitForNavigation).
    // Only treat this as the custom-invite flow when the URL is specifically an invite page.
    // The previous `/connect/i` match was far too broad — it matched almost any LinkedIn URL
    // (including a follow-only profile that never navigated to a real invite form), which drove
    // the code into the submit-button retry loop against unrelated disabled feed "Submit"
    // buttons. That mismatch was the dominant cause of encounter #20 (×48 "send button not found").
    const isCustomInviteUrl = /custom-invite|invitation|\/preload\/.*invite/i.test(urlAfter);
    if (navigated && isCustomInviteUrl) {
      if (withNote) {
        const ta = page.locator('textarea').first();
        const taVisible = await ta.isVisible().catch(() => false);
        if (taVisible) {
          await ta.fill(note).catch(() => {});
          await SLEEP(600);
          usedNote = true;
        } else {
          // Wait up to 4 s for textarea to appear (form may still be rendering)
          await ta.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {});
          if (await ta.isVisible().catch(() => false)) {
            await ta.fill(note).catch(() => {});
            await SLEEP(600);
            usedNote = true;
          }
          // No note textarea on this custom-invite page: the note is optional / not offered.
          // Proceed note-less rather than looping until the (disabled) submit never enables —
          // this was the dominant cause of encounter #20 (×48 "send button not found").
          else if (process.env.DEBUG_CONN) console.log('custom-invite: no note textarea, sending note-less');
        }
      }
      // The note editor is frequently replaced by the "out of free custom notes" Premium upsell
      // (the saved encounter #20 screenshot). Dismiss it and send the invite note-less rather than
      // falling into the submit-retry loop against the upsell/ad-dialog Submit buttons.
      if (await dismissPremiumUpsell(page)) usedNote = false;
      if (dryRun) {
        await page.goBack().catch(() => {});
        await page.close();
        return { ok: true, result: usedNote ? 'dry_note_ready' : 'dry_ready', detail: 'reached custom-invite page' + (usedNote ? ' with note' : ''), note: usedNote ? note : '' };
      }
      // ── Find the send button using the unified resolver ─────────────────────────
      // Prefer scoping to the invite form (form/dialog containing textarea) when one exists;
      // fall back to the full page. Extra wait after fill to let React/Vue enable the submit.
      if (usedNote) await SLEEP(1000);
      const inviteForm = page.locator('form:has(textarea), div[role="dialog"]:has(textarea), dialog:has(textarea)').first();
      const inviteFormCount = await inviteForm.count().catch(() => 0);
      const primaryScope = inviteFormCount ? inviteForm : page;

      // Retry up to 20×500 ms for the send button to become visible and enabled
      let sendBtn = null;
      for (let i = 0; i < 20 && !sendBtn; i++) {
        // Try the unified resolver (enabled required)
        sendBtn = await findSendButton(primaryScope);
        if (!sendBtn && primaryScope !== page) {
          sendBtn = await findSendButton(page);
        }
        // Also try with requireEnabled=false on later iterations (button may be briefly disabled)
        if (!sendBtn && i >= 5) {
          sendBtn = await findSendButton(primaryScope, { requireEnabled: false });
          if (!sendBtn && primaryScope !== page) {
            sendBtn = await findSendButton(page, { requireEnabled: false });
          }
        }
        if (sendBtn) break;
        await SLEEP(500);
      }

      if (!sendBtn) {
        // Last-resort recovery: JS-click any visible send control (bypasses Playwright locators)
        const jsClicked = await jsFindAndClickSend(page);
        if (jsClicked) {
          await SLEEP(3000);
          const body = await page.locator('body').innerText().catch(() => '');
          if (/weekly invitation limit|reached the weekly|you.?ve reached/i.test(body)) {
            await page.close();
            return { ok: false, result: 'limit', detail: 'LinkedIn weekly invitation limit reached' };
          }
          const pendingNow = !!(await mainCol(page, /^pending$/i)) || /invitation sent|pending/i.test(body.slice(0, 2000));
          if (pendingNow) {
            await page.close();
            return { ok: true, result: usedNote ? 'connected' : 'connected_no_note', detail: 'invite sent via custom-invite JS fallback', note: usedNote ? note : '' };
          }
        }
        await encounter('connect', 'send button not found in invite dialog', { url: profileUrl, page });
        await page.close();
        return { ok: false, result: 'error', detail: 'send button not found on custom-invite page' };
      }
      let sent = await sendBtn.click({ timeout: 5000 }).then(() => true).catch(() => false);
      if (!sent) sent = await sendBtn.click({ force: true, timeout: 3000 }).then(() => true).catch(() => false);
      if (!sent) sent = await sendBtn.evaluate(el => el.click()).then(() => true).catch(() => false);
      await SLEEP(3000);
      const bodyAfter = await page.locator('body').innerText().catch(() => '');
      if (/weekly invitation limit|reached the weekly|you.?ve reached/i.test(bodyAfter)) {
        await page.close();
        return { ok: false, result: 'limit', detail: 'LinkedIn weekly invitation limit reached' };
      }
      await page.close();
      return { ok: true, result: usedNote ? 'connected' : 'connected_no_note', detail: usedNote ? 'invite + note sent via custom-invite page' : 'invite sent via custom-invite page', note: usedNote ? note : '' };
    }

    // ── Classic overlay / dialog flow (non-navigation, dialog appears on same page) ─
    await SLEEP(1000); // extra settle time if no navigation
    if (process.env.DEBUG_CONN) console.log('after connect click; addNote count', await page.getByRole('button', { name: /add a note/i }).count());

    if (withNote) {
      const addNote = page.getByRole('button', { name: /add a note/i }).first();
      if (await addNote.isVisible().catch(() => false)) {
        await addNote.click(); await SLEEP(1000);
        const ta = page.locator('textarea').first();
        await ta.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
        if (await ta.isVisible().catch(() => false)) { await ta.fill(note); await SLEEP(400); usedNote = true; }
        else if (process.env.DEBUG_CONN) console.log('textarea not visible after addNote');

        // Free custom-note quota exhausted → LinkedIn shows the Premium upsell instead of the
        // note editor. Dismiss it and continue with a note-less invitation.
        if (await dismissPremiumUpsell(page)) usedNote = false;
      } else {
        // LinkedIn 2026: no intermediate "Add a note" button — textarea may be directly visible in the dialog
        const ta = page.locator('dialog textarea, div[role="dialog"] textarea').first();
        if (await ta.isVisible().catch(() => false)) {
          await ta.fill(note).catch(() => {});
          await SLEEP(400);
          usedNote = true;
        } else if (await dismissPremiumUpsell(page)) {
          // No note textarea because the "out of free custom notes" Premium upsell took its place.
          // Dismiss it and continue to the Send/pending detection, sending note-less.
          usedNote = false;
        }
        // Step 5: When no "Add a note" and no textarea appeared, proceed directly to
        // findSendButton for a note-less invite. Don't loop waiting for a textarea that
        // will never appear — this dead-end was a contributor to encounter #20.
      }
    }
    if (dryRun) { await page.keyboard.press('Escape').catch(() => {}); await SLEEP(400); await page.getByRole('button', { name: /discard/i }).first().click({ timeout: 2500 }).catch(() => {}); await page.close(); return { ok: true, result: usedNote ? 'dry_note_ready' : 'dry_ready', detail: 'reached send' + (usedNote ? ' with note' : ''), note: usedNote ? note : '' }; }

    // ── Find the invite dialog ────────────────────────────────────────────────────
    // The invite dialog (role=dialog / artdeco modal, or the 2026 native <dialog>) carries the
    // Send control. Wait up to 8 s for ANY dialog/modal to appear after the Connect/Add-note click.
    // The 2026 LinkedIn UI uses obfuscated gfl* class names — we can't rely on .artdeco-modal.
    const inviteDlg = page.locator('div[role="dialog"], dialog[open], [data-test-modal], [data-artdeco-is-focused-dialog]').first();
    await inviteDlg.waitFor({ state: 'visible', timeout: 8000 }).catch(async () => {
      // 2026 LinkedIn may use a non-standard overlay without role=dialog.
      // Fall back: wait for any new visible button containing "send" text to appear.
      await page.waitForFunction(
        () => [...document.querySelectorAll('button')].some(b =>
          /send/i.test(b.textContent || b.getAttribute('aria-label') || '') &&
          b.offsetParent !== null && !b.disabled),
        { timeout: 5000 }
      ).catch(() => {});
    });
    // Build dialog scope — prefer narrowed scope but fall back to whole page
    const dlgCount = await inviteDlg.count().catch(() => 0);
    const dlgScope = dlgCount ? inviteDlg : page;

    // ── Unified Send-button search with retry ─────────────────────────────────────
    // Uses findSendButton with the dialog as primary scope and page as fallback.
    // Retry up to 14×800 ms — the send button starts disabled and enables after the
    // dialog animates in.
    let send = null;
    for (let i = 0; i < 14 && !send; i++) {
      // Primary: search within the dialog scope
      send = await findSendButton(dlgScope);
      // Fallback: search the full page (button may be outside dialog scope)
      if (!send) send = await findSendButton(page);
      // On later iterations, also try with requireEnabled=false (button may still be animating)
      if (!send && i >= 4) {
        send = await findSendButton(dlgScope, { requireEnabled: false });
        if (!send) send = await findSendButton(page, { requireEnabled: false });
      }
      if (send) break;
      await SLEEP(800);
    }

    if (!send) {
      // 2026 LinkedIn sometimes sends immediately on Connect click (no dialog / quota exhausted note path)
      // Check: Pending button, or "Pending" text anywhere in the top card area
      if (await mainCol(page, /^pending$/i)) { await page.close(); return { ok: true, result: 'connected_no_note', detail: 'invite sent instantly (no dialog)' }; }
      const bodyTxt = await page.locator('main').innerText().catch(() => '');
      if (/pending/i.test(bodyTxt.slice(0, 1000))) { await page.close(); return { ok: true, result: 'connected_no_note', detail: 'invite sent (pending state detected)' }; }

      // Last-resort JS-click (bypasses Playwright locators entirely)
      const jsSent = await jsFindAndClickSend(page);
      if (jsSent) {
        await SLEEP(3000);
        const pendingNow = !!(await mainCol(page, /^pending$/i));
        const bodyNow = await page.locator('body').innerText().catch(() => '');
        if (pendingNow || /pending|invitation sent/i.test(bodyNow.slice(0, 2000))) {
          await page.close();
          return { ok: true, result: 'connected_no_note', detail: 'invite sent via JS send button scan' };
        }
      }

      // Page-wide findSendButton one more time (may have appeared after JS interactions)
      const lateSend = await findSendButton(page);
      if (lateSend) {
        await lateSend.click({ timeout: 5000 }).catch(() => {});
        await SLEEP(3000);
        await page.close();
        return { ok: true, result: 'connected_no_note', detail: 'invite sent via late page-level send button' };
      }

      await encounter('connect', 'send button not found in invite dialog', { url: profileUrl, page });
      await page.close(); return { ok: false, result: 'error', detail: 'send button not found in invite dialog' };
    }
    await send.scrollIntoViewIfNeeded().catch(() => {});
    let sent = await send.click({ timeout: 5000 }).then(() => true).catch(() => false);
    if (!sent) sent = await send.click({ force: true, timeout: 3000 }).then(() => true).catch(() => false);
    if (!sent) await send.evaluate(el => el.click()).catch(() => {});
    // Wait up to 3000 ms for the dialog to close and the pending state to appear.
    await SLEEP(3000);
    const txt = await page.locator('body').innerText().catch(() => '');
    if (/weekly invitation limit|reached the weekly|you.?ve reached/i.test(txt)) { await page.close(); return { ok: false, result: 'limit', detail: 'LinkedIn weekly invitation limit reached' }; }
    // Check dialog-gone as an additional confirmation signal.
    // The 2026 LinkedIn UI dropped data-test-modal-id; check for any visible role=dialog instead.
    const dialogClosed = (await page.locator('div[role="dialog"]:visible, dialog[open]:visible').count().catch(() => 1)) === 0;
    const pending = !!(await mainCol(page, /^pending$/i)) || /invitation sent|pending/i.test(txt.slice(0, 3000)) || dialogClosed;
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
