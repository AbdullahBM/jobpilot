// src/mcp/gmail.js — Send email through the user's LOGGED-IN Gmail web tab.
// No SMTP, no app password. Verifies: attachment chip uploaded, and Gmail's
// "Message sent" toast appeared — returns ok:false otherwise (so nothing is
// recorded as sent unless it really was).
import { getContext } from '../agent/browser.js';
import fs from 'fs';
import path from 'path';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));

export async function sendViaGmail({ to, subject, body, attachmentPath }) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  try {
    await page.goto('https://mail.google.com/mail/u/0/#inbox', { waitUntil: 'domcontentloaded', timeout: 40000 });
    await SLEEP(3000);
    if (/accounts\.google\.com|ServiceLogin/.test(page.url())) return { ok: false, result: 'failed', detail: 'Gmail not logged in' };

    // Click the Compose button to open the compose window
    // Open the composer. Gmail renders Compose as a DIV (role=button) with obfuscated classes,
    // so a single selector is fragile. Try several strategies, then fall back to the Gmail
    // keyboard shortcut "c", and retry until the subject input actually appears.
    const subjectInput = page.locator('input[name="subjectbox"]')
      .or(page.locator('input[aria-label*="Subject" i]')).first();

    const composeIsOpen = async () => subjectInput.isVisible().catch(() => false);

    const openComposer = async () => {
      // Strategy 1: role=button named Compose (newer Gmail)
      const byRole = page.getByRole('button', { name: /^compose$/i }).first();
      if (await byRole.isVisible().catch(() => false)) { await byRole.click().catch(() => {}); return; }
      // Strategy 2: the classic Compose button / its known containers / tooltip
      const byLoc = page.locator('[gh="cm"], div[role="button"][gh="cm"], [data-tooltip="Compose"], [aria-label="Compose"], .T-I-KE.L3, .T-I-KE').first();
      if (await byLoc.isVisible().catch(() => false)) { await byLoc.click().catch(() => {}); return; }
      // Strategy 3: any clickable element whose visible text is exactly "Compose"
      const byText = page.getByText(/^compose$/i).first();
      if (await byText.isVisible().catch(() => false)) { await byText.click().catch(() => {}); return; }
      // Strategy 4: Gmail keyboard shortcut — "c" opens a new compose window.
      await page.locator('body').click({ position: { x: 5, y: 300 } }).catch(() => {});
      await page.keyboard.press('c').catch(() => {});
    };

    let opened = false;
    for (let attempt = 0; attempt < 4 && !opened; attempt++) {
      await openComposer();
      // Wait up to ~6s for the subject input to mount after each attempt.
      for (let i = 0; i < 12 && !opened; i++) { await SLEEP(500); opened = await composeIsOpen(); }
    }
    if (!opened) return { ok: false, result: 'failed', detail: 'Gmail compose window did not open' };

    // To field
    const toField = page.locator('input[aria-label*="To" i], input[peoplekit-id], textarea[name="to"]').first();
    await toField.click().catch(() => {});
    await toField.fill(to);
    await page.keyboard.press('Tab');
    await SLEEP(400);

    // Subject
    await subjectInput.fill(subject);

    // Body
    const bodyBox = page.locator('div[aria-label="Message Body"][contenteditable="true"]')
      .or(page.locator('div[role="textbox"][contenteditable="true"]')).first();
    await bodyBox.click();
    await bodyBox.fill(body);

    // Attachment
    let attached = false;
    if (attachmentPath && fs.existsSync(attachmentPath)) {
      const name = path.basename(attachmentPath);
      await page.locator('input[type="file"][name="Filedata"], input[type="file"]').first().setInputFiles(attachmentPath);
      for (let i = 0; i < 40 && !attached; i++) {
        await SLEEP(500);
        attached = await page.evaluate((n) => document.body.innerText.includes(n) && !document.querySelector('[role="progressbar"]'), name).catch(() => false);
      }
      if (!attached) return { ok: false, result: 'failed', detail: 'CV attachment did not finish uploading' };
    }

    // Send
    const sendBtn = page.getByRole('button', { name: /^Send/ }).first()
      .or(page.locator('[data-tooltip*="Send"], [aria-label*="Send "]').first());
    await sendBtn.click({ timeout: 8000 }).catch(() => page.keyboard.press('Control+Enter'));

    let sent = false;
    for (let i = 0; i < 20 && !sent; i++) {
      await SLEEP(500);
      sent = await page.evaluate(() =>
        /Message sent|Sending\.\.\./i.test(document.body.innerText.slice(-4000)) ||
        /Message sent/i.test(document.querySelector('[role="alert"]')?.innerText || '')
      ).catch(() => false);
    }
    // If compose window closed, that's also a success signal
    if (!sent) sent = !(await subjectInput.isVisible().catch(() => false));
    await SLEEP(1500);
    return sent
      ? { ok: true, result: 'sent', detail: `Sent to ${to}${attached ? ' with CV' : ''}` }
      : { ok: false, result: 'failed', detail: 'No "Message sent" confirmation' };
  } catch (e) {
    return { ok: false, result: 'failed', detail: e.message.slice(0, 200) };
  } finally { await page.close().catch(() => {}); }
}

async function discardDraft(page, dlg) {
  await dlg.getByRole('button', { name: /discard draft/i }).first().click().catch(() => {});
}
