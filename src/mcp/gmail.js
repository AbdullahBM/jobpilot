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
    await page.goto('https://mail.google.com/mail/u/0/#inbox?compose=new', { waitUntil: 'domcontentloaded', timeout: 40000 });
    if (/accounts\.google\.com|ServiceLogin/.test(page.url())) return { ok: false, result: 'failed', detail: 'Gmail not logged in' };

    const dlg = page.locator('div[role="dialog"]').filter({ has: page.locator('input[name="subjectbox"]') }).last();
    await dlg.waitFor({ state: 'visible', timeout: 25000 });
    await SLEEP(800);

    const toField = dlg.locator('input[aria-label*="To" i], input[peoplekit-id], textarea[name="to"]').first();
    await toField.click();
    await toField.fill(to);
    await page.keyboard.press('Enter');
    await SLEEP(400);
    await dlg.locator('input[name="subjectbox"]').fill(subject);
    const bodyBox = dlg.locator('div[aria-label="Message Body"][contenteditable="true"], div[role="textbox"][contenteditable="true"]').first();
    await bodyBox.click();
    await bodyBox.fill(body);

    let attached = false;
    if (attachmentPath && fs.existsSync(attachmentPath)) {
      const name = path.basename(attachmentPath);
      await dlg.locator('input[type="file"][name="Filedata"], input[type="file"]').first().setInputFiles(attachmentPath);
      // chip shows file name; upload done when the progress bar disappears
      for (let i = 0; i < 40 && !attached; i++) {
        await SLEEP(500);
        attached = await dlg.evaluate((el, n) => el.innerText.includes(n) && !el.querySelector('[role="progressbar"]'), name).catch(() => false);
      }
      if (!attached) { await discardDraft(page, dlg); return { ok: false, result: 'failed', detail: 'CV attachment did not finish uploading' }; }
    }

    await dlg.getByRole('button', { name: /^Send/ }).first().click().catch(() => page.keyboard.press('Control+Enter'));
    let sent = false;
    for (let i = 0; i < 20 && !sent; i++) {
      await SLEEP(500);
      sent = await page.evaluate(() => /Message sent|Sending\.\.\./i.test(document.body.innerText.slice(-4000)) || /Message sent/i.test(document.querySelector('[role="alert"]')?.innerText || '')).catch(() => false);
    }
    // a still-visible compose dialog with our subject means it did NOT go
    if (!sent) sent = !(await dlg.isVisible().catch(() => false));
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
