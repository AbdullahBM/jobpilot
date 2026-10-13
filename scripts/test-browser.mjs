// test-browser.mjs — Quick sanity check for CDP + LinkedIn session
// Run: node test-browser.mjs
import { cdpStatus, getContext, listTabs } from '../src/agent/browser.js';

console.log('─── CDP Health Check ───────────────────────────────');
const status = await cdpStatus();
console.log(status.ok ? `✓ Chrome CDP up: ${status.version}` : `✗ CDP down: ${status.reason}`);
if (!status.ok) process.exit(1);

console.log('\n─── Open Tabs ──────────────────────────────────────');
const tabs = await listTabs();
tabs.slice(0, 10).forEach(t => console.log(`  ${t.title?.slice(0, 55).padEnd(55)} ${t.url?.slice(0, 50)}`));

console.log('\n─── LinkedIn Login Check ───────────────────────────');
const liTabs = tabs.filter(t => t.url?.includes('linkedin.com'));
if (liTabs.length) {
  console.log(`✓ LinkedIn session active (${liTabs.length} tabs)`);
} else {
  console.log('⚠ No LinkedIn tabs — open LinkedIn in Chrome and log in');
}

console.log('\n─── Context Check ──────────────────────────────────');
const ctx = await getContext();
const pages = ctx.pages();
console.log(`✓ Context has ${pages.length} open pages`);

// Try opening a fresh page and loading LinkedIn jobs
console.log('\n─── Quick LinkedIn Job Search Test ─────────────────');
const page = await ctx.newPage();
page.setDefaultTimeout(20000);
try {
  await page.goto('https://www.linkedin.com/jobs/search/?keywords=AI+engineer+remote&f_WT=2&sortBy=DD', {
    waitUntil: 'domcontentloaded', timeout: 20000
  });

  // Wait for results
  const gotResults = await page.waitForSelector(
    '.jobs-search-results__list, .scaffold-layout__list, .base-card',
    { timeout: 12000 }
  ).then(() => true).catch(() => false);

  if (gotResults) {
    const cards = await page.locator('.job-search-card, .jobs-search-results__list-item, .base-card').count();
    console.log(`✓ LinkedIn jobs page loaded. Cards found: ${cards}`);
  } else {
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || '');
    if (/sign in|log in|join now/i.test(bodyText)) {
      console.log('✗ LinkedIn requires login — this Chrome profile is NOT logged in');
      console.log('  → Close Chrome, run launch_chrome.bat to open with your real profile');
    } else {
      console.log('⚠ Results container not found. Page text:', bodyText.slice(0, 100));
    }
  }
} finally {
  await page.close().catch(() => {});
}

console.log('\n─── Done ────────────────────────────────────────────');
