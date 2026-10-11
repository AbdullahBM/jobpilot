// src/mcp/scrape.js — Scraping capabilities.
// Browser scrapers drive YOUR logged-in Chrome tabs (LinkedIn, Indeed, Glassdoor, X).
// API scrapers hit public job boards (no login). Returns raw jobs for the agent to score.
import fetch from 'node-fetch';
import { getContext } from '../agent/browser.js';

const SLEEP = ms => new Promise(r => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

// ── Public API / RSS sources (no login) ───────────────────────────────────────
export const PUBLIC_SOURCES = {
  remotive:        { url: 'https://remotive.com/api/remote-jobs?category=software-dev&limit=100', type: 'json' },
  remoteok_ai:     { url: 'https://remoteok.com/api?tag=ai', type: 'json' },
  remoteok_python: { url: 'https://remoteok.com/api?tag=python', type: 'json' },
  remoteok_backend:{ url: 'https://remoteok.com/api?tag=backend', type: 'json' },
  himalayas:       { url: 'https://himalayas.app/jobs/api?q=AI+engineer&remote=true&limit=100', type: 'json' },
  arbeitnow:       { url: 'https://www.arbeitnow.com/api/job-board-api?tag=ai', type: 'json' },
  jobicy:          { url: 'https://jobicy.com/api/v2/remote-jobs?industry=engineering&tag=ai', type: 'json' },
  wwr_prog:        { url: 'https://weworkremotely.com/categories/remote-programming-jobs.rss', type: 'rss' },
  hn_hiring:       { url: 'https://hn.algolia.com/api/v1/search?query=AI+LLM+engineer+remote&tags=ask_hn&hitsPerPage=50', type: 'json' },
};

function emailsIn(text = '') {
  return [...(text.matchAll(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g))]
    .map(m => m[0])
    .filter(e => !['example.', 'sentry.', 'wix.', 'png', 'jpg', 'svg'].some(b => e.includes(b)));
}

function detectPortal(url = '') {
  const u = url.toLowerCase();
  if (u.includes('greenhouse')) return 'greenhouse';
  if (u.includes('lever.co'))   return 'lever';
  if (u.includes('ashby'))      return 'ashby';
  if (u.includes('linkedin'))   return 'linkedin';
  if (u.includes('indeed'))     return 'indeed';
  if (u.includes('glassdoor'))  return 'glassdoor';
  if (u.includes('workday'))    return 'workday';
  return 'other';
}

// ── API scraper: returns normalized jobs (agent scores them, not us) ──────────
export async function scrapePublicSource(name) {
  const src = PUBLIC_SOURCES[name];
  if (!src) throw new Error(`Unknown source: ${name}`);
  const r = await fetch(src.url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: 15000, redirect: 'follow' });

  if (src.type === 'rss') {
    const raw = await r.text();
    const jobs = [];
    for (const m of raw.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const item = m[1];
      const title = (item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) || item.match(/<title>(.*?)<\/title>/))?.[1] || '';
      const link = item.match(/<link>(.*?)<\/link>/)?.[1] || '';
      const desc = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)?.[1] || '';
      const [co, ...rest] = title.split(':');
      jobs.push({
        source: name, company: rest.length ? co.trim() : '', role: rest.length ? rest.join(':').trim() : title,
        url: link, description: desc.replace(/<[^>]+>/g, ' ').slice(0, 600), email: emailsIn(desc)[0] || '',
        portal: detectPortal(link), remote: true,
      });
    }
    return jobs;
  }

  const raw = await r.json();
  const rawJobs = raw.jobs || raw.data || raw.hits || (Array.isArray(raw) ? raw : []);
  return rawJobs.map(j => {
    const title = j.title || j.position || j.jobTitle || j.name || '';
    const company = j.company_name || j.companyName || j.company?.name || j.company || '';
    const url = j.url || j.applicationLink || j.apply || j.job_url || '';
    const desc = (j.description || j.jobExcerpt || j.jobDescription || '').replace(/<[^>]+>/g, ' ').slice(0, 600);
    return {
      source: name, company, role: title, url, description: desc,
      email: j.company_email || j.email || emailsIn(desc)[0] || '',
      portal: detectPortal(url), remote: true,
      salary: j.salary || j.salaryRange || '', location: j.location || '',
    };
  }).filter(j => j.role && j.url);
}

// ── Browser scraper: drives a LOGGED-IN tab (LinkedIn/Indeed/Glassdoor/X) ──────
// resultSelector / cardSelector are per-site; agent passes them or uses presets.
const SITE_PRESETS = {
  linkedin: {
    searchUrl: q => `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(q)}&f_WT=2&f_TPR=r604800&sortBy=DD`,
    resultSelector: '.jobs-search-results__list, .scaffold-layout__list, ul.jobs-search__results-list',
    cardSelector: '.job-search-card, .jobs-search-results__list-item, li.scaffold-layout__list-item, .base-card',
    title: '.job-search-card__title, .job-card-list__title, .base-search-card__title',
    company: '.job-search-card__company-name, .job-card-container__company-name, .base-search-card__subtitle',
    link: 'a[href*="/jobs/view/"]',
  },
};

export async function scrapeBrowserSite(site, query, { max = 25, timeoutMs = 30000 } = {}) {
  const preset = SITE_PRESETS[site];
  if (!preset) throw new Error(`No preset for site: ${site}. Supported: ${Object.keys(SITE_PRESETS).join(', ')}`);

  const ctx = await getContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(timeoutMs);
  const jobs = [];

  try {
    await page.goto(preset.searchUrl(query), { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    // Login wall detection
    const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 300) || '').catch(() => '');
    if (/sign in|log in|join now|create an account/i.test(bodyText) && !bodyText.toLowerCase().includes('job')) {
      await page.close().catch(() => {});
      return { ok: false, jobs: [], detail: `${site} requires login — log into ${site} in your Chrome` };
    }

    // Wait for results container
    await page.waitForSelector(preset.resultSelector, { timeout: Math.min(15000, timeoutMs) }).catch(() => {});

    // Scroll to lazy-load
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, 700)).catch(() => {});
      await SLEEP(600);
    }

    const cards = await page.locator(preset.cardSelector).all().catch(() => []);
    for (const card of cards.slice(0, max)) {
      try {
        const role = (await card.locator(preset.title).first().textContent().catch(() => '') || '').trim();
        const company = (await card.locator(preset.company).first().textContent().catch(() => '') || '').trim();
        let href = await card.locator(preset.link).first().getAttribute('href').catch(() => '');
        if (href && !href.startsWith('http')) href = new URL(href, page.url()).href;
        if (role && href) {
          jobs.push({
            source: site, company, role, url: href.split('?')[0],
            email: '', portal: detectPortal(href), remote: true, location: '', salary: '',
          });
        }
      } catch {}
    }

    await page.close().catch(() => {});
    const seen = new Set();
    return { ok: true, jobs: jobs.filter(j => j.url && !seen.has(j.url) && seen.add(j.url)), detail: `${jobs.length} jobs from ${site}` };
  } catch (e) {
    await page.close().catch(() => {});
    return { ok: false, jobs: [], detail: e.message.slice(0, 200) };
  }
}

// ── LinkedIn hiring-POST lead extractor ───────────────────────────────────────
// This is the PRIMARY lead source. For each hiring post it classifies HOW to
// apply and captures what's needed to act:
//   apply_method: 'email' | 'form' | 'easy_apply' | 'dm' | 'connect'
//   email        → address to send to
//   formUrl      → greenhouse/lever/ashby/workday link to submit
//   jobUrl       → linkedin.com/jobs/view link for Easy Apply
//   posterUrl    → the author's profile (for DM or connection request)
//   posterName   → author's name
//   postText     → the post body (for a personalized note)
export async function scrapeLinkedInPosts(query, { max = 25, timeoutMs = 35000 } = {}) {
  const ctx = await getContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(timeoutMs);
  const leads = [];
  const emails = new Set();

  try {
    await page.goto(
      `https://www.linkedin.com/search/results/content/?keywords=${encodeURIComponent(query)}&sortBy=%22date_posted%22`,
      { waitUntil: 'domcontentloaded', timeout: timeoutMs }
    );
    const body = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || '').catch(() => '');
    if (/^sign in|join now to/i.test(body)) {
      await page.close().catch(() => {});
      return { ok: false, leads: [], jobs: [], detail: 'LinkedIn not logged in — log into LinkedIn in Chrome' };
    }
    await page.waitForSelector('div[componentkey], .feed-shared-update-v2, .search-results__list, .update-components-text', { timeout: 12000 }).catch(() => {});
    for (let i = 0; i < 6; i++) { await page.evaluate(() => window.scrollBy(0, 900)).catch(() => {}); await SLEEP(700); }

    // LinkedIn content-search now wraps each post in div[componentkey]; the old
    // .feed-shared-update-v2/.occludable-update classes are gone. We over-select
    // and filter to nodes that actually look like a post (have actor + body text).
    let posts = await page.locator('div[componentkey]').all().catch(() => []);
    if (!posts.length) posts = await page.locator('.feed-shared-update-v2, .occludable-update').all().catch(() => []);
    for (const post of posts.slice(0, max)) {
      try {
        const text = (await post.textContent().catch(() => '') || '').replace(/\s+/g, ' ').trim();
        if (!text || text.length < 30) continue;

        const found = emailsIn(text);
        found.forEach(e => emails.add(e));

        // Poster identity (for DM / connect)
        let posterUrl = '', posterName = '';
        try {
          const a = post.locator('a.update-components-actor__meta-link, a[href*="/in/"]').first();
          posterUrl = (await a.getAttribute('href').catch(() => '') || '').split('?')[0];
          posterName = (await post.locator('.update-components-actor__title span[aria-hidden="true"], .update-components-actor__name').first().textContent().catch(() => '') || '').trim();
        } catch {}

        // Apply links inside the post
        let formUrl = '', jobUrl = '';
        const links = await post.locator('a[href*="greenhouse"], a[href*="lever.co"], a[href*="ashby"], a[href*="workday"], a[href*="linkedin.com/jobs/view"]').all().catch(() => []);
        for (const lnk of links) {
          const href = (await lnk.getAttribute('href').catch(() => '') || '').split('?')[0];
          if (!href) continue;
          if (/linkedin\.com\/jobs\/view/.test(href)) jobUrl = href;
          else formUrl = href;
        }

        // Keep any post with a hiring signal OR an actionable channel — the AGENT
        // decides relevance; we only surface facts.
        const isHiring = /hiring|we'?re looking|looking for|seeking|join (our|the) team|open (role|position)|apply|dm me|email your|send.{0,10}(cv|resume)/i.test(text);
        if (!isHiring && !found.length && !formUrl && !jobUrl) continue;

        const rolM = text.match(/(?:hiring|looking for|seeking)\s+(?:a\s+|an\s+)?([A-Za-z /+]{4,45}?)(?:\s+at|\s*[,.!\n])/i);
        const coM = text.match(/\bat\s+([A-Z][A-Za-z0-9 &.]{2,35}?)(?:\s+is|\s+we|\s*[!,.\n])/);
        const role = rolM?.[1]?.trim() || '';
        const company = coM?.[1]?.trim() || '';
        const asksDM = /dm me|message me|reach out|pm me/i.test(text);

        // availableChannels = raw facts. suggestedMethod = a HINT only; the agent
        // owns the final choice and may route however it judges best.
        const availableChannels = [];
        if (found[0])  availableChannels.push('email');
        if (formUrl)   availableChannels.push('form');
        if (jobUrl)    availableChannels.push('easy_apply');
        if (posterUrl) availableChannels.push(asksDM ? 'dm' : 'connect');
        if (!availableChannels.length) continue;
        const suggestedMethod = availableChannels[0];

        leads.push({
          source: 'linkedin_post', company, role,
          availableChannels,
          suggestedMethod,
          apply_method: suggestedMethod,
          url: found[0] ? `email:${found[0]}` : (formUrl || jobUrl || posterUrl),
          email: found[0] || '', formUrl, jobUrl, posterUrl, posterName, asksDM,
          postText: text.slice(0, 600),
          portal: formUrl ? detectPortal(formUrl) : (jobUrl ? 'linkedin' : found[0] ? 'email' : 'linkedin'),
          remote: true, location: '', salary: '',
        });
      } catch {}
    }
    await page.close().catch(() => {});
    const seen = new Set();
    const uniq = leads.filter(l => l.url && !seen.has(l.url) && seen.add(l.url));
    const byChannel = uniq.reduce((a, l) => { l.availableChannels.forEach(c => a[c] = (a[c] || 0) + 1); return a; }, {});
    return { ok: true, leads: uniq, jobs: uniq, emails: [...emails], byChannel, detail: `${uniq.length} leads · channels ${JSON.stringify(byChannel)} (agent decides how to act)` };
  } catch (e) {
    await page.close().catch(() => {});
    return { ok: false, leads: [], jobs: [], detail: e.message.slice(0, 200) };
  }
}

export { detectPortal, emailsIn, SITE_PRESETS };
