// src/agent/browser.js — Attach to the user's real Chrome over CDP.
// Playwright is the automation engine; CDP (:9222) is the transport that lets it
// drive YOUR Chrome with YOUR logins, instead of a fresh logged-out browser.
// Designed to run inside ONE long-lived process (the MCP server), which launches
// debug-Chrome once and keeps it alive for the whole scrape+apply session.
import { chromium } from 'playwright';
import fetch from 'node-fetch';
import { CDP } from '../config.js';

let _browser = null;

export async function cdpStatus() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(`${CDP}/json/version`, { signal: ctrl.signal }).catch(() => null);
    clearTimeout(t);
    if (!r || !r.ok) return { ok: false, reason: `CDP not reachable at ${CDP}` };
    const v = await r.json();
    return { ok: true, version: v.Browser, userAgent: v['User-Agent'] };
  } catch (e) { clearTimeout(t); return { ok: false, reason: e.message }; }
}

export async function getBrowser() {
  if (_browser && _browser.isConnected()) return _browser;
  const status = await cdpStatus();
  if (!status.ok) {
    throw new Error(`Chrome CDP not available (${status.reason}). The server launches it automatically; if this persists, call launch_chrome.`);
  }
  _browser = await chromium.connectOverCDP(CDP);
  return _browser;
}

export async function getContext() {
  const b = await getBrowser();
  return b.contexts()[0] || await b.newContext();
}

export async function newPage(timeout = 30000) {
  const ctx = await getContext();
  const p = await ctx.newPage();
  p.setDefaultTimeout(timeout);
  return p;
}

// Verify a REAL logged-in session by navigating and reading auth signals —
// not by checking whether a tab happens to be open (a fresh profile has none).
// Returns { linkedin: bool, gmail: bool, detail: {...} }.
export async function verifyLogins() {
  const out = { linkedin: false, gmail: false, detail: {} };
  let page;
  try {
    page = await newPage(35000);
  } catch (e) {
    out.detail.error = e.message;
    return out;
  }
  // LinkedIn: authenticated feed shows the member nav (Home/Jobs/Messaging/Me)
  // and the member's own name. authwall/login URL = logged out.
  try {
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(3000);
    const li = await page.evaluate(() => {
      const url = location.href;
      if (/\/login|\/uas\/login|authwall|\/signup/.test(url)) return { in: false, why: 'authwall/login url' };
      const txt = (document.body?.innerText || '');
      const hasNav = /\bMessaging\b/.test(txt) && /\bNotifications\b/.test(txt) && /\bJobs\b/.test(txt);
      const hasMe = !!document.querySelector('.global-nav__me, img.global-nav__me-photo, button.global-nav__primary-link-me-menu-trigger, [data-control-name="nav.settings_myprofile"]');
      return { in: hasNav || hasMe, why: hasNav ? 'member nav present' : hasMe ? 'me element' : 'no auth signal' };
    });
    out.linkedin = li.in;
    out.detail.linkedin = li.why;
  } catch (e) { out.detail.linkedin = 'error: ' + e.message; }

  // Gmail: inbox loads at mail.google.com/mail (no accounts.google.com redirect).
  try {
    await page.goto('https://mail.google.com/mail/u/0/#inbox', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(2500);
    const gurl = page.url();
    out.gmail = /mail\.google\.com\/mail/.test(gurl) && !/accounts\.google\.com|ServiceLogin|signin/.test(gurl);
    out.detail.gmail = out.gmail ? 'inbox loaded' : ('redirected: ' + gurl);
  } catch (e) { out.detail.gmail = 'error: ' + e.message; }

  await page.close().catch(() => {});
  return out;
}

export async function listTabs() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(`${CDP}/json`, { signal: ctrl.signal });
    clearTimeout(t);
    const tabs = await r.json();
    return tabs
      .filter(t => t.type === 'page' && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-untrusted://'))
      .map(t => ({ title: t.title?.slice(0, 60), url: t.url?.slice(0, 80) }));
  } catch { clearTimeout(t); return []; }
}
