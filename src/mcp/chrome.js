// src/mcp/chrome.js — Chrome launcher, the PROVEN LEGACY WAY.
// Launches a SEPARATE Chrome instance on a dedicated data dir + debug port.
// It NEVER touches your day-to-day Chrome — both run side by side.
// You log into LinkedIn plus the selected mailbox (Gmail or Outlook) in this debug Chrome ONCE; it persists.
import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..', '..');

// Dedicated debug profile — separate from your real Chrome, lives with the app.
export const DEBUG_PROFILE_DIR = path.join(ROOT, 'data', 'chrome-debug-profile');

const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium',
];
function findChrome() { return CHROME_PATHS.find(p => fs.existsSync(p)) || null; }

function portOpen(port = 9222, host = '127.0.0.1', timeout = 1000) {
  return new Promise(resolve => {
    const s = new net.Socket();
    s.setTimeout(timeout);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
    s.connect(port, host);
  });
}

/**
 * Ensure a debug Chrome is up on :9222 using the dedicated profile dir.
 * If the port is already up → attach, touch nothing.
 * Else → launch a SEPARATE Chrome on data/chrome-debug-profile. Your real
 * Chrome is never closed or affected.
 */
export async function launchChrome() {
  if (await portOpen()) {
    return { ok: true, state: 'already_up', detail: 'Debug Chrome already on :9222 — attached, nothing else touched' };
  }

  const chrome = findChrome();
  if (!chrome) return { ok: false, state: 'no_chrome', detail: 'Chrome not found. Public-API scraping still works; logged-in sites need Chrome.' };

  fs.mkdirSync(DEBUG_PROFILE_DIR, { recursive: true });
  const firstRun = !fs.existsSync(path.join(DEBUG_PROFILE_DIR, 'Default'));

  // Separate instance, separate data dir, debug port. Does NOT touch your Chrome.
  const child = spawn(chrome, [
    '--remote-debugging-port=9222',
    `--user-data-dir=${DEBUG_PROFILE_DIR}`,
    '--no-first-run', '--no-default-browser-check',
    '--no-service-autorun', '--disable-sync',
  ], { detached: true, stdio: 'ignore' });
  child.unref();

  for (let i = 0; i < 20; i++) {
    if (await portOpen()) {
      return {
        ok: true,
        state: firstRun ? 'launched_fresh' : 'launched',
        firstRun,
        detail: firstRun
          ? 'Opened a dedicated debug Chrome (separate from your normal Chrome). FIRST RUN — log into LinkedIn plus your selected mailbox in THIS window once; it stays logged in for future runs.'
          : 'Opened the dedicated debug Chrome (your LinkedIn/mailbox logins persist here). Your normal Chrome is untouched.',
      };
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return { ok: false, state: 'timeout', detail: 'Launched debug Chrome but port 9222 did not bind in 20s — call launch_chrome again' };
}
