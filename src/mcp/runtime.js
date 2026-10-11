// src/mcp/runtime.js — Runtime extensibility: the agent can research the open
// web and author/run its own helper scripts when no existing tool fits.
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { emailsIn, detectPortal } from './scrape.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..', '..');
const GEN_DIR = path.join(ROOT, 'data', 'agent-scripts');  // where agent-written tools live
fs.mkdirSync(GEN_DIR, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

/**
 * Fetch any public URL (open internet) and extract hiring signals:
 * emails, ATS apply links, and the readable text. The agent decides what to do.
 */
export async function webResearch(url, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: ctrl.signal });
    clearTimeout(t);
    const html = await r.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const emails = emailsIn(text);
    const applyLinks = [...new Set((html.match(/https?:\/\/[^"'\s]*(?:greenhouse|lever\.co|ashby|workday)[^"'\s]*/gi) || []))].slice(0, 10);
    return {
      ok: true, finalUrl: r.url,
      emails, applyLinks,
      portal: detectPortal(r.url),
      text: text.slice(0, 4000),
      detail: `${emails.length} emails, ${applyLinks.length} apply links`,
    };
  } catch (e) {
    clearTimeout(t);
    return { ok: false, detail: e.message.slice(0, 160) };
  }
}

/**
 * The agent writes a Node ESM helper (e.g. a scraper for a site with no preset)
 * and runs it. Script gets access to the project's own modules via relative import.
 * Returns stdout/stderr. Scripts persist under data/agent-scripts so they can be reused.
 */
export async function runScript({ name, code, args = [], timeoutMs = 60000 }) {
  const safe = (name || `tool_${Date.now()}`).replace(/[^a-z0-9._-]/gi, '_');
  const file = path.join(GEN_DIR, safe.endsWith('.mjs') ? safe : `${safe}.mjs`);
  fs.writeFileSync(file, code, 'utf8');

  return new Promise(resolve => {
    const child = spawn('node', [file, ...args], { cwd: ROOT });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, detail: 'timeout', stdout: out, stderr: err, file }); }, timeoutMs);
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ ok: code === 0, exitCode: code, stdout: out.slice(0, 8000), stderr: err.slice(0, 2000), file, detail: `exit ${code}` });
    });
  });
}

/** List helper scripts the agent has written (so it can reuse, not recreate). */
export function listScripts() {
  try { return fs.readdirSync(GEN_DIR).filter(f => f.endsWith('.mjs')); } catch { return []; }
}
