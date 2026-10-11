// scripts/stop.mjs — stop the always-on worker from the terminal (same flag the UI uses).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, '.stop'), new Date().toISOString());
console.log('⏹ Stop flag written — the worker will halt within a few seconds. Your logged-in Chrome stays open.');
