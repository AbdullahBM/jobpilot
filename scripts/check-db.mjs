// check-db.mjs — quick DB state snapshot
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const SQL = await require('sql.js')();
const db = new SQL.Database(fs.readFileSync('data/jobs.db'));
const run = (q) => { const s = db.prepare(q); const out = []; while (s.step()) out.push(s.getAsObject()); s.free(); return out; };

const total = run('SELECT COUNT(*) n FROM jobs')[0].n;
const byStatus = run('SELECT status, COUNT(*) n FROM jobs GROUP BY status ORDER BY n DESC');
const withEmail = run("SELECT COUNT(*) n FROM jobs WHERE email != ''")[0].n;
const sentSet = run("SELECT DISTINCT email FROM jobs WHERE email != '' AND status IN ('emailed','draft','skipped_duplicate')");
const emailQueueNew = run("SELECT COUNT(*) n FROM jobs WHERE email != '' AND status = 'new'")[0].n;

console.log('=== DB State ===');
console.log('Total jobs:', total);
console.log('With email:', withEmail);
console.log('Email queue (new + has email):', emailQueueNew);
console.log('Already contacted (dedup set size):', sentSet.length);
console.log('\nStatus breakdown:');
byStatus.forEach(r => console.log(' ', r.status.padEnd(25), r.n));

// Sample of recent jobs
const recent = run('SELECT company, role, email, status FROM jobs WHERE email != "" ORDER BY id DESC LIMIT 10');
console.log('\nRecent jobs with email:');
recent.forEach(r => console.log(' ', r.status.padEnd(12), (r.company||'').slice(0,25).padEnd(25), (r.role||'').slice(0,30).padEnd(30), r.email));
