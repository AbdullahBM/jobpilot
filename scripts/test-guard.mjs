// test-guard.mjs — prove the self-contribution guard refuses sensitive paths.
import { execFileSync } from 'child_process';
import fs from 'fs';
const R = process.cwd();
const g = (...a) => { try { return execFileSync('git', a, { cwd: R }).toString().trim(); } catch (e) { return (e.stderr || e.stdout || '').toString(); } };

// 1. Try to force-stage a data/ file (simulate a leak) and run safeStage's logic.
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/__leak_test.txt', 'SECRET');
g('add', '-f', 'data/__leak_test.txt');
const staged = g('diff', '--cached', '--name-only').split('\n').filter(Boolean);
const DENY = [/^data\//, /^\.env$/, /jobs\.db$/, /profile\.json$/, /\.png$/];
const leaked = staged.filter(f => DENY.some(re => re.test(f)));
console.log('staged includes data/ leak?', leaked);
console.log(leaked.length ? 'GUARD WOULD ABORT ✔ (sensitive path detected)' : 'NO LEAK DETECTED ✖');
// cleanup
g('reset', '-q');
fs.rmSync('data/__leak_test.txt', { force: true });
console.log('cleaned up; staged now:', g('diff', '--cached', '--name-only').split('\n').filter(Boolean).length, 'files');
process.exit(0);
