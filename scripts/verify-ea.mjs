// verify-ea.mjs — check LinkedIn's own "Application submitted" state for needs_manual Easy Apply rows; fix status.
import { initDB, rows, setStatus } from '../src/tracker.js';
import { newPage } from '../src/agent/browser.js';
await initDB();
const list = rows(`SELECT url, role, company FROM jobs WHERE channel='easy_apply' AND status IN ('needs_manual','failed')`);
const pg = await newPage(30000);
let fixed = 0;
for (const j of list) {
  await pg.goto(j.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await pg.waitForTimeout(3000);
  const t = await pg.evaluate(() => (document.querySelector('main') || document.body).innerText.slice(0, 1500)).catch(() => '');
  const applied = /Application submitted|Applied \d+ (minute|hour|day)s? ago|You applied/i.test(t);
  console.log(applied ? 'APPLIED ' : 'not     ', j.role.slice(0, 50), '@', j.company.slice(0, 25));
  if (applied) { setStatus(j.url, 'applied', 'Easy Apply submitted (verified on LinkedIn)'); fixed++; }
}
console.log('fixed', fixed, 'of', list.length);
await pg.close(); process.exit(0);
