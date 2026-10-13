// src/mcp/outlook.js — Send email through the user's logged-in Outlook Web session.
// Uses the same dedicated Chrome profile as the other browser actions; no API keys or passwords.

import { getContext } from '../agent/browser.js';
import fs from 'fs';
import path from 'path';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));

function loggedOut(url) {
  return /login\.live\.com|login\.microsoftonline\.com|oauth|signin/i.test(url || '');
}

async function firstVisible(page, selectors, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const selector of selectors) {
      const loc = page.locator(selector).last();
      if (await loc.isVisible().catch(() => false)) return loc;
    }
    await SLEEP(250);
  }
  throw new Error(`Outlook control not found: ${selectors[0]}`);
}

async function discardDraft(page) {
  const discard = page.locator('button[aria-label*="Discard" i], button[title*="Discard" i]').last();
  if (await discard.isVisible().catch(() => false)) await discard.click().catch(() => {});
}

/**
 * Send an application email through Outlook Web and verify that the draft was sent.
 * @param {object} args - recipient, subject, body, and optional CV attachment
 * @returns {Promise<object>}
 */
export async function sendViaOutlook({ to, subject, body, attachmentPath }) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(30000);
  try {
    await page.goto('https://outlook.live.com/mail/0/deeplink/compose', { waitUntil: 'domcontentloaded', timeout: 40000 });
    await SLEEP(1200);
    if (loggedOut(page.url())) return { ok: false, result: 'failed', detail: 'Outlook not logged in' };

    const subjectSelectors = [
      'input[placeholder*="subject" i]',
      'input[aria-label*="subject" i]',
      'input[name="subject"]',
    ];
    let subjectField;
    try {
      subjectField = await firstVisible(page, subjectSelectors, 7000);
    } catch {
      const compose = await firstVisible(page, [
        'button[aria-label*="New mail" i]',
        'button[title*="New mail" i]',
      ], 12000);
      await compose.click();
      subjectField = await firstVisible(page, subjectSelectors, 20000);
    }

    const toField = await firstVisible(page, [
      'input[aria-label*="To" i]',
      'input[placeholder*="To" i]',
      'input[role="combobox"][aria-label*="recipient" i]',
    ]);
    await toField.fill(to);
    await toField.press('Enter').catch(() => {});
    await subjectField.fill(subject);

    const bodyField = await firstVisible(page, [
      'div[aria-label*="Message body" i][contenteditable="true"]',
      'div[aria-label*="Body" i][contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]',
    ]);
    await bodyField.fill(body);

    let attached = false;
    if (attachmentPath && fs.existsSync(attachmentPath)) {
      let fileInput = page.locator('input[type="file"]').last();
      if (!(await fileInput.count())) {
        const attach = await firstVisible(page, [
          'button[aria-label*="Attach" i]',
          'button[title*="Attach" i]',
        ], 10000);
        await attach.click();
        fileInput = page.locator('input[type="file"]').last();
      }
      if (!(await fileInput.count())) throw new Error('Outlook attachment control not found');
      await fileInput.setInputFiles(attachmentPath);
      const name = path.basename(attachmentPath);
      for (let i = 0; i < 40 && !attached; i++) {
        await SLEEP(500);
        attached = await page.locator('body').innerText().then(t => t.includes(name)).catch(() => false);
      }
      if (!attached) {
        await discardDraft(page);
        return { ok: false, result: 'failed', detail: 'CV attachment did not finish uploading in Outlook' };
      }
    }

    const send = await firstVisible(page, [
      'button[aria-label="Send"]',
      'button[aria-label*="Send" i]',
      'button[title*="Send" i]',
    ]);
    await send.click();

    let sent = false;
    for (let i = 0; i < 24 && !sent; i++) {
      await SLEEP(500);
      sent = await page.locator('[role="alert"], [aria-live="assertive"], [aria-live="polite"]')
        .allTextContents().then(xs => xs.some(t => /message sent|sent successfully/i.test(t))).catch(() => false);
      if (!sent) {
        const stillVisible = await subjectField.isVisible().catch(() => false);
        if (!stillVisible) sent = true;
      }
    }
    return sent
      ? { ok: true, result: 'sent', detail: `Sent to ${to}${attached ? ' with CV' : ''} via Outlook` }
      : { ok: false, result: 'failed', detail: 'No Outlook sent confirmation' };
  } catch (e) {
    return { ok: false, result: 'failed', detail: e.message.slice(0, 240) };
  } finally {
    await page.close().catch(() => {});
  }
}
