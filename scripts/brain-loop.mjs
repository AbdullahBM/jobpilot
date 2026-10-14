// scripts/brain-loop.mjs — the REASONING loop (the "brain in a loop").
//
// JobPilot's worker is the HANDS (scrape/apply/email). This runner is how the BRAIN keeps
// improving the agent itself: it repeatedly invokes whichever coding-agent CLIs are installed —
// Codex, Grok, Claude, Gemini — in headless mode, handing each a standing self-evolution prompt:
//   "read evolution_report → fix the top open encounter in code → resolve_encounter → contribute".
//
// DESIGN (per the three decisions):
//   1. ROTATION  — brains take turns, one dispatch per tick, round-robin. No parallel git
//                  collisions; the value is diversity of reasoning, not raw throughput. Each fix is
//                  attributable to the brain that made it.
//   2. CONSENT   — only runs when profile.consent.autoBrainLoop === true (dashboard + onboarding
//                  toggle, OFF by default). The whole point is unattended code pushes, so it is gated.
//   3. TRIGGER   — event-driven PRIMARY (only dispatch when there are open encounters / pending
//                  questions to reason about) + a slow heartbeat SAFETY NET so it can't stall.
//
// STRICTLY CLIs — NEVER API KEYS. This runner only shells out to already-installed, already-logged-in
// CLIs. It never reads, writes, sets, or passes an API key, and it refuses to inject any *_API_KEY
// into the child environment.
//
// Stops on the same data/.stop flag the worker uses, so the dashboard ⏹ Stop halts the brain too.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DATA } from '../src/config.js';
import { getProfile } from '../src/profile.js';
import { initDB, rows } from '../src/tracker.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const STOPFILE = path.join(DATA, '.stop');
const STATEFILE = path.join(DATA, 'brain-loop-state.json');

const HEARTBEAT_MS = 15 * 60 * 1000;   // safety-net cadence: re-check at least every 15 min
const POLL_MS = 30 * 1000;             // how often we check the stop flag / backlog
const TURN_TIMEOUT_MS = 20 * 60 * 1000; // hard cap on a single brain's turn

const SLEEP = ms => new Promise(r => setTimeout(r, ms));
const stopped = () => fs.existsSync(STOPFILE);
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('en-GB')}] brain-loop:`, ...a);

// ── The brains. Each entry is a CLI we KNOW how to drive headlessly. We only use the ones that
//    are actually on PATH — absent brains are silently skipped (installation is not required). ──
const BRAINS = [
  {
    name: 'codex',
    bin: 'codex',
    // codex exec = non-interactive. --cd sets the repo. workspace-write sandbox lets it edit files
    // and run git, with approvals routed automatically (no TTY prompts).
    args: prompt => ['exec', '--skip-git-repo-check', '--sandbox', 'workspace-write', '-C', ROOT, prompt],
  },
  {
    name: 'grok',
    bin: 'grok',
    // grok -p = single-turn headless; --cwd sets the repo; --no-auto-update for scripted runs.
    args: prompt => ['--no-auto-update', '--cwd', ROOT, '-p', prompt],
  },
  {
    name: 'claude',
    bin: 'claude',
    // claude -p = print/headless. Permission mode kept non-interactive for unattended edits.
    args: prompt => ['-p', '--permission-mode', 'acceptEdits', prompt],
  },
  {
    name: 'gemini',
    bin: 'gemini',
    // gemini -p = headless prompt.
    args: prompt => ['-p', prompt],
  },
];

// The standing self-evolution instruction handed to each brain. It tells the brain to use the
// JobPilot MCP tools (which its own config wires up) and to follow the AGENTS.md contribution loop.
const PROMPT = [
  'You are one of several coding-agent brains improving the JobPilot repo you are running inside.',
  'Do ONE focused self-evolution iteration, then stop:',
  '1. Read the evolution report (the evolution_report MCP tool, or data/evolution/PLAYBOOK.md).',
  '2. Pick the single highest-impact OPEN encounter (a stuck form / Easy Apply page / connect flow / exception).',
  '3. Open its saved screenshot + HTML snapshot under data/evolution/ and diagnose the ROOT cause.',
  '4. Fix it in the relevant module (src/mcp/easyapply.js, forms.js, connect.js, sources.js, gmail.js, …).',
  '   You may modify, optimize, or CREATE NEW tools/modules — that liberty is the whole point.',
  '5. Verify your change at least parses (node --check) and keeps the worker booting.',
  '6. resolve_encounter it with a note of what you changed, then run the contribute flow',
  '   (contribute_improvements) so the fix lands as a PR / merge per AGENTS.md.',
  'Rules: never touch data/, .env*, uploads/, or credentials. Keep the change small and correct.',
  'Do not start long-running processes. When your one iteration is done, exit.',
].join('\n');

function onPath(bin) {
  const exts = process.platform === 'win32' ? ['.cmd', '.ps1', '.exe', '.bat', ''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const d of dirs) for (const e of exts) {
    try { if (d && fs.existsSync(path.join(d, bin + e))) return true; } catch {}
  }
  return false;
}

function installedBrains() { return BRAINS.filter(b => onPath(b.bin)); }

// Guard: strip any *_API_KEY / *_TOKEN from the child env so brains run purely on their own
// CLI login (subscription), never on an API key this process could leak in.
function sanitizedEnv() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/(_API_KEY|_APIKEY|_SECRET|_TOKEN|OPENAI_KEY|ANTHROPIC_KEY|XAI_KEY|GEMINI_KEY)$/i.test(k)) delete env[k];
  }
  return env;
}

function backlog() {
  let encounters = 0, questions = 0;
  try { encounters = rows(`SELECT COUNT(*) n FROM encounters WHERE status IN ('open','regressed')`)[0]?.n || 0; } catch {}
  try { questions = rows(`SELECT COUNT(*) n FROM answers WHERE pending=1`)[0]?.n || 0; } catch {}
  return { encounters, questions, total: encounters + questions };
}

function readState() { try { return JSON.parse(fs.readFileSync(STATEFILE, 'utf8')); } catch { return { turn: 0, history: [] }; } }
function writeState(s) { try { fs.writeFileSync(STATEFILE, JSON.stringify(s, null, 2)); } catch {} }

function runBrain(brain) {
  return new Promise(resolve => {
    log(`▶ dispatching ${brain.name} …`);
    const child = spawn(brain.bin, brain.args(PROMPT), {
      cwd: ROOT, env: sanitizedEnv(), stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32',
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
  });
}

async function tick() {
  const p = getProfile();
  if (p.consent?.autoBrainLoop !== true) { log('consent OFF (consent.autoBrainLoop) — standing by'); return; }
  const brains = installedBrains();
  if (!brains.length) { log('no coding-agent CLIs installed on PATH — nothing to dispatch (install codex/grok/claude/gemini to enable)'); return; }

  const bl = backlog();
  if (bl.total === 0) { log('backlog empty (0 encounters, 0 questions) — nothing to reason about this tick'); return; }

  // ROTATION: pick the next brain round-robin across the INSTALLED ones.
  const state = readState();
  const brain = brains[state.turn % brains.length];
  log(`backlog: ${bl.encounters} encounters, ${bl.questions} questions · installed brains: ${brains.map(b => b.name).join(', ')} · turn → ${brain.name}`);
  const result = await runBrain(brain);
  state.turn = (state.turn + 1) % Math.max(1, brains.length * 1000);
  state.history = [{ ts: new Date().toISOString(), brain: brain.name, ...result, backlog: bl }, ...(state.history || [])].slice(0, 50);
  state.lastTick = new Date().toISOString();
  writeState(state);
}

async function main() {
  await initDB();
  const brains = installedBrains();
  log(`started. root=${ROOT}`);
  log(`installed brains: ${brains.length ? brains.map(b => b.name).join(', ') : '(none — will stand by until one is installed)'}`);
  log(`consent.autoBrainLoop currently: ${getProfile().consent?.autoBrainLoop === true ? 'ON' : 'OFF'}`);
  log(`rotation + event-driven dispatch; heartbeat safety net every ${Math.round(HEARTBEAT_MS / 60000)}m; stops on data/.stop`);

  let lastHeartbeat = 0;
  while (!stopped()) {
    const now = Date.now();
    const bl = backlog();
    // Event-driven: dispatch as soon as there is a backlog. Heartbeat: also re-check on cadence.
    if (getProfile().consent?.autoBrainLoop === true && (bl.total > 0 || now - lastHeartbeat >= HEARTBEAT_MS)) {
      lastHeartbeat = now;
      try { await tick(); } catch (e) { log('tick error (continuing): ' + ((e && e.message) || e)); }
    }
    // Poll in short increments so Stop is honored promptly.
    for (let i = 0; i < Math.ceil(POLL_MS / 1000) && !stopped(); i++) await SLEEP(1000);
  }
  log('⏹ data/.stop present — brain-loop exiting cleanly.');
  process.exit(0);
}

process.on('uncaughtException', e => log('⚠ uncaughtException (continuing): ' + ((e && e.stack) || e)));
process.on('unhandledRejection', e => log('⚠ unhandledRejection (continuing): ' + ((e && e.stack) || e)));
main();
