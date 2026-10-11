// src/config.js — paths + endpoints only. ZERO personal data lives here.
// Everything about the user (name, CV, links, answers, salary, roles) lives in
// data/profile.json (gitignored) and is read through src/profile.js.
import { fileURLToPath } from 'url';
import path from 'path';

const __dir = path.dirname(fileURLToPath(import.meta.url));
export const ROOT    = path.resolve(__dir, '..');
export const DATA    = path.join(ROOT, 'data');
export const LOGS    = path.join(ROOT, 'logs');
export const SHOTS   = path.join(ROOT, 'applied');
export const DRAFTS  = path.join(ROOT, 'drafts');
export const DB_FILE = path.join(DATA, 'jobs.db');
export const DASH    = path.join(ROOT, 'dashboard.html');

// CDP — connects Playwright to the user's real Chrome (with their logins).
// Chrome is launched on demand by src/mcp/chrome.js on debug port 9222.
export const CDP = process.env.CDP_ENDPOINT || 'http://127.0.0.1:9222';

// Polite inter-action delays (ms).
export const D = { page: 2500, action: 1200, between: 8000, li: 12000 };
