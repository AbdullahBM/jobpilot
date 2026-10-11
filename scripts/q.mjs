// q.mjs — run ad-hoc read-only SQL against data/jobs.db:  node scripts/q.mjs "select ..."
import { createRequire } from 'module';
import fs from 'fs';
const require = createRequire(import.meta.url);
const SQL = await require('sql.js')();
const db = new SQL.Database(fs.readFileSync(new URL('../data/jobs.db', import.meta.url)));
for (const sql of process.argv.slice(2)) {
  const r = db.exec(sql);
  console.log('>> ' + sql);
  if (!r[0]) { console.log('(no rows)'); continue; }
  console.log(r[0].columns.join(' | '));
  for (const v of r[0].values) console.log(v.map(x => String(x ?? '').slice(0, 70)).join(' | '));
}
