// test-sources.mjs — node scripts/test-sources.mjs [liPosts|liJobs|hn|reddit|boards] [query]
import { initDB } from '../src/tracker.js';
import * as S from '../src/mcp/sources.js';
await initDB();
const which = process.argv[2], q = process.argv[3] || 'hiring python remote';
const fn = { liPosts: () => S.liPosts(q), liJobs: () => S.liJobs(q), hn: () => S.hnHiring(), reddit: () => S.redditHiring(), boards: () => S.publicBoards() }[which];
const r = await fn();
console.log(r.detail);
const rows = r.leads.filter(l => !l.skip).sort((a, b) => (b.postedAt || '').localeCompare(a.postedAt || ''));
console.log('kept (not skipped):', rows.length, ' skipped:', r.leads.length - rows.length);
for (const l of rows.slice(0, 12)) console.log(`${(l.postedAt || '').slice(0, 16)} | ${l.channel} | rel ${l.relevance} | ${(l.role || '').slice(0, 40)} @ ${(l.company || '').slice(0, 25)} | ${l.email || l.applyUrl?.slice(0, 60) || l.posterUrl}`);
process.exit(0);
