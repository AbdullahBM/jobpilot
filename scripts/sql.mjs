// sql.mjs — run a WRITE statement on data/jobs.db through the tracker (keeps evolve tables in sync)
//   node scripts/sql.mjs "delete from answers where ..."
import { initDB, getDB, save, rows } from '../src/tracker.js';
await initDB();
for (const s of process.argv.slice(2)) { if (/^\s*select/i.test(s)) console.log(JSON.stringify(rows(s))); else { getDB().run(s); console.log('ok:', s.slice(0, 80)); } }
save(); process.exit(0);
