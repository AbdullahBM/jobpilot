// src/doctor.js — First-run health check & setup guide.
// Run: npm run doctor   (or: node src/doctor.js)
// Tells the user exactly what's ready and what to do next.
import fs from 'fs';
import { initDB, counts } from './tracker.js';
import { initAttempts } from './attempts.js';
import { getProfile, profileGaps, isOnboarded } from './profile.js';
import { cdpStatus, listTabs } from './agent/browser.js';

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', C = '\x1b[36m', B = '\x1b[1m', X = '\x1b[0m';
const ok = s => `${G}✓${X} ${s}`;
const warn = s => `${Y}⚠${X} ${s}`;
const bad = s => `${R}✗${X} ${s}`;
const h = s => `\n${B}${C}${s}${X}`;

console.log(`${B}${C}
╔══════════════════════════════════════════════════╗
║        Job Agent MCP — Setup Doctor              ║
╚══════════════════════════════════════════════════╝${X}`);

// ── 1. Dependencies ───────────────────────────────────────────────────────────
console.log(h('1. Dependencies'));
const deps = ['@modelcontextprotocol/sdk', 'playwright', 'sql.js', 'node-fetch'];
let depsOk = true;
for (const d of deps) {
  const present = fs.existsSync(`node_modules/${d}`);
  console.log('  ' + (present ? ok(d) : bad(`${d} — run: npm install`)));
  if (!present) depsOk = false;
}

// ── 2. Chrome debug session ───────────────────────────────────────────────────
console.log(h('2. Chrome (your logged-in browser)'));
const cdp = await cdpStatus();
if (cdp.ok) {
  console.log('  ' + ok(`Chrome debug port up: ${cdp.version}`));
  const tabs = await listTabs();
  const sites = ['linkedin', 'indeed', 'glassdoor', 'gmail', 'outlook', 'x.com', 'wellfound'];
  const loggedIn = sites.filter(s => tabs.some(t => t.url?.includes(s)));
  if (loggedIn.length) console.log('  ' + ok(`Logged-in sites detected: ${loggedIn.join(', ')}`));
  else console.log('  ' + warn('No job-site tabs open — open & log into LinkedIn plus your selected mailbox (Gmail or Outlook)'));
} else {
  console.log('  ' + bad(`Chrome debug port down (${cdp.reason})`));
  console.log(`     ${Y}→ Close Chrome, then run launch_chrome.bat${X}`);
}

// ── 3. Profile ────────────────────────────────────────────────────────────────
console.log(h('3. Your profile'));
const p = getProfile();
const gaps = profileGaps();
if (isOnboarded()) {
  console.log('  ' + ok(`Profile complete — ${p.name}`));
  console.log(`     CV: ${p.cvPath}`);
  console.log(`     Roles: ${(p.preferences.roles || []).join(', ')}`);
} else {
  console.log('  ' + warn('Profile incomplete. Missing:'));
  gaps.forEach(g => console.log(`     ${Y}•${X} ${g}`));
  console.log(`     ${C}→ Ask your agent: "set up my job profile" (it calls set_profile)${X}`);
}

// ── 4. Data (dedup history) ───────────────────────────────────────────────────
console.log(h('4. Saved data (dedup history — preserved)'));
await initDB();
await initAttempts();
const c = counts();
console.log('  ' + ok(`${c.total} jobs in bank · ${c.withEmail} with email`));
const emailed = c.byStatus.find(r => r.status === 'emailed')?.n || 0;
const applied = c.byStatus.find(r => r.status === 'applied')?.n || 0;
console.log('  ' + ok(`${emailed} already emailed · ${applied} applied (won't be re-contacted)`));

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(h('Next steps'));
if (!depsOk) console.log(`  1. ${Y}npm install${X}`);
if (!cdp.ok) console.log(`  ${!depsOk ? 2 : 1}. ${Y}Close Chrome → run launch_chrome.bat → log into your job sites${X}`);
if (!isOnboarded()) console.log(`  → ${Y}Tell your agent your CV path, links, and target roles${X}`);
if (depsOk && cdp.ok && isOnboarded()) {
  console.log(`  ${G}${B}All set!${X} Tell your agent: "find and apply to AI jobs"`);
}
console.log('');
