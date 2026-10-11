// render the dashboard with a simulated loginNeeded state and confirm the banner appears
import fs from 'fs';
import path from 'path';
import { initDB } from '../src/tracker.js';
import { DATA } from '../src/config.js';
process.env.JOB_AGENT_PORT = '7788';
await initDB();
fs.writeFileSync(path.join(DATA, 'worker-state.json'), JSON.stringify({ ts: new Date().toISOString(), lanes: {}, loginNeeded: { LinkedIn: { url: 'https://www.linkedin.com/login', reason: 'security check', ts: new Date().toISOString() } } }));
const { writeDash } = await import('../src/dashboard.js');
writeDash();
const h = fs.readFileSync(new URL('../dashboard.html', import.meta.url), 'utf8');
console.log('login banner present:', h.includes('needs you to log in'));
console.log('one-click link present:', h.includes('https://www.linkedin.com/login') && h.includes('loginbtn'));
console.log('target _blank:', /loginbtn[^>]*target="_blank"/.test(h));
// clean the simulated state so a real run isn't confused
fs.writeFileSync(path.join(DATA, 'worker-state.json'), JSON.stringify({ ts: new Date().toISOString(), lanes: {} }));
process.exit(0);
