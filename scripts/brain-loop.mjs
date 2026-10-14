// scripts/brain-loop.mjs — THE BRAIN. The always-on reasoning driver the whole pipeline runs under.
//
// ARCHITECTURE (the agreed inversion): the worker is NOT a peer that applies on its own. The worker
// runs DATA-ONLY (scrape leads into the DB + keep the dashboard fresh). THIS loop is the brain that
// sits on top: every tick it reasons over the fresh leads and performs the applies / emails /
// connects itself through the MCP tools, and also reasons over open encounters to improve the
// agent's own tools. So every job action goes THROUGH the brain — nothing acts without it.
//
// It drives whichever coding-agent CLIs are installed — Codex, Grok, Claude, Gemini — in headless
// mode, round-robin (rotation), handing each a batch of real pending leads + the top encounter.
//
// BRAIN CONTROL IS ALWAYS-ON AND NOT CONSENT-GATED. Brain-in-control is the core idea of the
// project, not an optional feature — like self-evolution, it is never bypassed. The ONLY consent
// that still applies is `consent.autoContribute` (whether CODE/DOCS get pushed to GitHub), which is
// about where code leaves the machine, NOT about whether the brain reasons and acts. The loop stops
// only on the user's explicit Stop (data/.stop) — same contract as the never-stop worker.
//
// STRICTLY CLIs — NEVER API KEYS. Only shells out to already-installed, already-logged-in CLIs; it
// strips every *_API_KEY / *_TOKEN from the child env so a brain can only run on its own CLI login.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DATA } from '../src/config.js';
import { getProfile } from '../src/profile.js';
import { initDB, rows } from '../src/tracker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STOPFILE = path.join(DATA, '.stop');
const STATEFILE = path.join(DATA, 'brain-loop-state.json');

const IDLE_HEARTBEAT_MS = 10 * 60 * 1000; // when there's no work, still re-check at least this often
const POLL_MS = 20 * 1000;                // how often we check the stop flag / backlog
const TURN_TIMEOUT_MS = 25 * 60 * 1000;   // hard cap on a single brain's turn
const LEADS_PER_TURN = 8;                 // how many fresh leads to hand the brain each turn

const SLEEP = ms => new Promise(r => setTimeout(r, ms));
const stopped = () => fs.existsSync(STOPFILE);
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('en-GB')}] brain-loop:`, ...a);

// ── Installed-brain registry. Absent brains are skipped; installation is not required. ──
// `stdin:true` → prompt delivered on STDIN (codex reads it when the prompt arg is '-'). `stdin:false`
// → prompt passed as a single argv entry (grok/gemini headless need it inline). Either way we never
// place the prompt on a shell command line, so the long multi-line prompt is never mangled.
const BRAINS = [
  { name: 'codex',  bin: 'codex',  stdin: true,  args: () => ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', ROOT, '-'] },
  { name: 'grok',   bin: 'grok',   stdin: false, args: p => ['--no-auto-update', '--cwd', ROOT, '-p', p] },
  { name: 'claude', bin: 'claude', stdin: false, args: p => ['-p', '--permission-mode', 'acceptEdits', p] },
  { name: 'gemini', bin: 'gemini', stdin: false, args: p => ['-p', p] },
];

function onPath(bin) { return !!resolveBin(bin); }
// Resolve a CLI to its concrete path (incl. Windows .cmd/.exe/.ps1 shims) so we can spawn WITHOUT
// shell:true — which is what mangled the multi-line prompt and triggered the arg-escaping warning.
function resolveBin(bin) {
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', '.ps1', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) for (const e of exts) {
    try { const full = path.join(d, bin + e); if (d && fs.existsSync(full)) return full; } catch {}
  }
  return null;
}
function installedBrains() { return BRAINS.filter(b => onPath(b.bin)); }

// Strip API keys/tokens so a brain runs purely on its own CLI login (subscription), never a key.
function sanitizedEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/(_API_KEY|_APIKEY|_SECRET|_TOKEN|OPENAI_KEY|ANTHROPIC_KEY|XAI_KEY|GEMINI_KEY)$/i.test(k)) delete env[k];
  }
  return env;
}

// ── What is there to reason about? Fresh leads to act on + open encounters to fix. ──
function freshLeads(limit = LEADS_PER_TURN) {
  // Newest first, same priority spirit as the worker queue (LinkedIn-post email leads first).
  try {
    return rows(
      `SELECT role, company, channel, email, apply_url, url, poster_url, poster_name, relevance, source
       FROM jobs WHERE status='new' AND COALESCE(attempts,0) < 3
       ORDER BY CASE WHEN channel='email' AND source='linkedin_post' THEN 0 ELSE 1 END,
                CASE WHEN posted_at='' OR posted_at IS NULL THEN 1 ELSE 0 END, posted_at DESC, relevance DESC
       LIMIT ?`, [limit]);
  } catch { return []; }
}
function backlog() {
  let encounters = 0, questions = 0, leads = 0;
  try { encounters = rows(`SELECT COUNT(*) n FROM encounters WHERE status IN ('open','regressed')`)[0]?.n || 0; } catch {}
  try { questions = rows(`SELECT COUNT(*) n FROM answers WHERE pending=1`)[0]?.n || 0; } catch {}
  try { leads = rows(`SELECT COUNT(*) n FROM jobs WHERE status='new' AND COALESCE(attempts,0) < 3`)[0]?.n || 0; } catch {}
  return { encounters, questions, leads, total: encounters + questions + leads };
}

// Build the standing instruction. The brain OWNS each application: it decides relevance, writes the
// outreach, picks the channel, and performs the action through the MCP tools. It also fixes the top
// tool-failure. The actual leads are embedded so the brain acts on real work, not an abstract task.
function buildPrompt(leads) {
  const leadLines = leads.length
    ? leads.map((j, i) => `  ${i + 1}. [${j.channel || '?'}] ${j.role || '(role?)'} @ ${j.company || '(company?)'}`
        + `${j.email ? ' · email ' + j.email : ''}${j.apply_url || j.url ? ' · ' + (j.apply_url || j.url) : ''}`
        + `${j.poster_url ? ' · poster ' + j.poster_url : ''}`).join('\n')
    : '  (none right now)';
  return [
    'You are the BRAIN driving JobPilot inside its own repo. The worker only scrapes; YOU perform every',
    'application by reasoning and calling the MCP tools. Do ONE productive cycle, then exit.',
    '',
    'PART A — act on these fresh leads (judge each; skip ones that do not fit the profile):',
    leadLines,
    '',
    'For each lead you judge relevant, act via the right MCP tool, after check_already_actioned:',
    '  • has an email → send_email (CV auto-attaches; omit subject/body to use the proven template).',
    '  • channel easy_apply / a LinkedIn job → apply_linkedin_easy.',
    '  • channel form / an ATS or job-board url → apply_portal.',
    '  • only a poster and no email/form → linkedin_connect with a short personalized note.',
    'Use set_job_status to record skips with a reason. Respect the profile (roles, skip list, salary,',
    'work-auth). Email is uncapped — pace yourself sensibly; do not burst Easy Apply (account safety).',
    '',
    'PART B — improve one tool: read evolution_report, pick the top OPEN encounter, open its',
    'screenshot+HTML under data/evolution/, fix the root cause in the relevant module (easyapply.js,',
    'forms.js, connect.js, sources.js, gmail.js, …) — you may modify or CREATE tools — verify it parses',
    '(node --check), then resolve_encounter and run contribute_improvements so it lands per AGENTS.md.',
    '',
    'Rules: never touch data/, .env*, uploads/, or credentials. Never re-email/re-apply/re-connect',
    '(check_already_actioned first). Do not start long-running processes. When the cycle is done, exit.',
  ].join('\n');
}

function readState() { try { return JSON.parse(fs.readFileSync(STATEFILE, 'utf8')); } catch { return { turn: 0, history: [] }; } }
function writeState(s) { try { fs.writeFileSync(STATEFILE, JSON.stringify(s, null, 2)); } catch {} }
function beat(phase, extra = {}) {
  const s = readState();
  s.phase = phase; s.ts = new Date().toISOString(); Object.assign(s, extra);
  writeState(s);
}

function runBrain(brain, prompt) {
  return new Promise(resolve => {
    log(`▶ dispatching ${brain.name} …`);
    const full = resolveBin(brain.bin) || brain.bin;
    const ext = (full.match(/\.(cmd|bat|ps1|exe)$/i) || [, ''])[1].toLowerCase();

    // Build the real command WITHOUT ever putting the prompt on a shell command line:
    //   • .exe (native, e.g. grok) → spawn directly, shell:false. argv (incl. a multi-line prompt
    //     arg) is passed to the process verbatim by the OS — no shell to mangle it.
    //   • .ps1 shim (e.g. codex) → run via pwsh -File; codex takes its prompt on STDIN ('-'), so
    //     no prompt ever appears as an arg anyway.
    //   • .cmd/.bat shim → run via cmd /c; prompt (if arg-mode) is passed as a separate argv entry.
    let cmd, argv;
    const promptArgs = brain.args(brain.stdin ? '-' : prompt);  // for stdin brains, '-' is ignored by our args()
    if (ext === 'ps1') { cmd = 'pwsh'; argv = ['-NoProfile', '-File', full, ...promptArgs]; }
    else if (ext === 'cmd' || ext === 'bat') { cmd = 'cmd'; argv = ['/c', full, ...promptArgs]; }
    else { cmd = full; argv = promptArgs; }   // .exe or extensionless → direct

    const child = spawn(cmd, argv, {
      cwd: ROOT, env: sanitizedEnv(), stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
    });
    let out = '', err = '';
    const timer = setTimeout(() => { log(`⏱ ${brain.name} exceeded ${Math.round(TURN_TIMEOUT_MS / 60000)}m — killing turn`); try { child.kill('SIGKILL'); } catch {} }, TURN_TIMEOUT_MS);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); log(`✗ ${brain.name} failed to launch: ${e.message}`); resolve({ ok: false, detail: e.message }); });
    child.on('close', code => {
      clearTimeout(timer);
      const tail = (out || err).toString().trim().split('\n').slice(-3).join(' | ').slice(0, 300);
      log(`■ ${brain.name} exited ${code}. ${tail}`);
      resolve({ ok: code === 0, code, tail });
    });
    // Deliver the prompt on stdin for stdin-brains; otherwise just close stdin.
    try { if (brain.stdin) child.stdin.write(prompt); child.stdin.end(); } catch (e) { log(`stdin write failed for ${brain.name}: ${e.message}`); }
  });
}

async function tick() {
  const brains = installedBrains();
  if (!brains.length) { beat('no brains installed'); log('no coding-agent CLIs on PATH — standing by (install codex/grok/claude/gemini to drive)'); return; }

  const leads = freshLeads();
  const bl = backlog();
  if (bl.total === 0) { beat('idle (no leads, no encounters)'); log('nothing to do this tick (0 leads, 0 encounters, 0 questions)'); return; }

  // ROTATION: next installed brain, round-robin.
  const state = readState();
  const brain = brains[(state.turn || 0) % brains.length];
  log(`work: ${bl.leads} leads · ${bl.encounters} encounters · ${bl.questions} questions · brains: ${brains.map(b => b.name).join(',')} · turn → ${brain.name}`);
  beat(`reasoning via ${brain.name} (${leads.length} leads + top encounter)`, { driver: brain.name });
  const result = await runBrain(brain, buildPrompt(leads));
  state.turn = ((state.turn || 0) + 1) % 1000;
  state.history = [{ ts: new Date().toISOString(), brain: brain.name, ...result, backlog: bl }, ...(state.history || [])].slice(0, 50);
  state.lastTick = new Date().toISOString();
  writeState(state);
  beat('idle (between turns)', { driver: brain.name });
  // Brief cooldown so a brain that fails instantly can't spin; real turns take minutes anyway.
  await SLEEP(15000);
}

async function main() {
  await initDB();
  const brains = installedBrains();
  log(`started (ALWAYS-ON brain driver). root=${ROOT}`);
  log(`installed brains: ${brains.length ? brains.map(b => b.name).join(', ') : '(none — standing by until one is installed)'}`);
  log(`brain control is NOT consent-gated; code-push still honors consent.autoContribute=${getProfile().consent?.autoContribute !== false}`);
  log(`drives every apply/email/connect through reasoning + fixes tools; stops only on data/.stop`);
  beat('started');

  let lastHeartbeat = 0;
  while (!stopped()) {
    const now = Date.now();
    const bl = backlog();
    // Always-on: dispatch whenever there is ANY work (leads to act on OR encounters to fix). The
    // idle heartbeat just guarantees a periodic re-check even if nothing changed. No consent gate.
    if (bl.total > 0 || now - lastHeartbeat >= IDLE_HEARTBEAT_MS) {
      lastHeartbeat = now;
      try { await tick(); } catch (e) { log('tick error (continuing): ' + ((e && e.message) || e)); beat('tick error (continuing)'); }
    }
    for (let i = 0; i < Math.ceil(POLL_MS / 1000) && !stopped(); i++) await SLEEP(1000);
  }
  log('⏹ data/.stop present — brain driver exiting cleanly.');
  beat('stopped');
  process.exit(0);
}

process.on('uncaughtException', e => log('⚠ uncaughtException (continuing): ' + ((e && e.stack) || e)));
process.on('unhandledRejection', e => log('⚠ unhandledRejection (continuing): ' + ((e && e.stack) || e)));
main();
