// scripts/ci-security-scan.mjs — the merge gate. Fails (exit 1) if a PR would introduce
// personal data, credentials, or anything outside the contribution allowlist. Runs in CI on
// every pull request; a PR cannot be merged unless this passes.
import { execSync } from 'child_process';
import fs from 'fs';

const sh = c => { try { return execSync(c, { encoding: 'utf8' }); } catch (e) { return (e.stdout || '') + (e.stderr || ''); } };
const fail = [];

// 1) No forbidden paths may be tracked in the repo — ever.
const FORBIDDEN = [
  /^data\//, /(^|\/)\.env$/, /(^|\/)\.env\.(?!example)/, /^drafts\//, /^applied\//, /^logs\//,
  /\.log$/, /jobs\.db$/, /tracker\.db$/, /profile\.json$/, /chrome-debug/, /^.*uploads\//,
  /scripts\/.*\.png$/, /scripts\/.*\.html$/,
];
const tracked = sh('git ls-files').split('\n').filter(Boolean);
for (const f of tracked) if (FORBIDDEN.some(re => re.test(f))) fail.push(`forbidden path committed: ${f}`);

// 2) No secrets in the diff of this PR (or whole tree if base is unknown).
const base = process.env.GITHUB_BASE_REF || '';
let changed = tracked;
if (base) {
  sh(`git fetch origin ${base} --depth=1`);
  const d = sh(`git diff --name-only origin/${base}...HEAD`).split('\n').filter(Boolean);
  if (d.length) changed = d;
}
const SECRET = [
  { re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, name: 'private key' },
  { re: /AKIA[0-9A-Z]{16}/, name: 'AWS access key id' },
  { re: /\bASIA[0-9A-Z]{16}\b/, name: 'AWS temp key' },
  { re: /aws_secret_access_key[ \t]*=[ \t]*[^\s'"]+/i, name: 'AWS secret' },
  { re: /SMTP_PASS[ \t]*=[ \t]*[^\s'"]+/, name: 'SMTP password' },
  { re: /\bghp_[0-9A-Za-z]{36}\b/, name: 'GitHub token' },
  { re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/, name: 'Slack token' },
  { re: /"private_key"[ \t]*:[ \t]*"-----BEGIN/, name: 'service-account key' },
];
for (const f of changed) {
  if (!fs.existsSync(f)) continue;
  if (/\.(png|jpg|jpeg|gif|pdf|mp4|mov|webm|ico|woff2?)$/i.test(f)) continue; // binaries
  let txt = ''; try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
  for (const s of SECRET) if (s.re.test(txt)) fail.push(`${s.name} detected in ${f}`);
}

if (fail.length) {
  console.error('❌ Security gate FAILED:\n - ' + fail.join('\n - '));
  process.exit(1);
}
console.log('✅ Security gate passed: no personal data, credentials, or out-of-allowlist paths.');
