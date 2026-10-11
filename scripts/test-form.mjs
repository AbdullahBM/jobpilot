// test-form.mjs — node scripts/test-form.mjs <url> [submit]   (dry-run by default; screenshot to scripts/form.png)
import { applyForm } from '../src/mcp/forms.js';
import { getContext } from '../src/agent/browser.js';
const r = await applyForm({ url: process.argv[2], submit: process.argv[3] === 'submit' });
console.log(JSON.stringify(r, null, 1));
process.exit(0);
