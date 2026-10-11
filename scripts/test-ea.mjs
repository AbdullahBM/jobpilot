// test-ea.mjs — node scripts/test-ea.mjs <jobUrl> [submit]   (dry-run by default)
import { initDB } from '../src/tracker.js';
import { easyApply } from '../src/mcp/easyapply.js';
await initDB();
const r = await easyApply({ url: process.argv[2], dryRun: process.argv[3] !== 'submit' });
delete r.meta?.head;
console.log(JSON.stringify(r, null, 1));
process.exit(0);
