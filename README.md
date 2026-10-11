# JobPilot 🧭

**A self-evolving, agent-driven job hunter that lives in your own browser.**

JobPilot is an [MCP](https://modelcontextprotocol.io) server with **no LLM of its own** — *your*
coding agent (Claude Code, Codex, Kiro, Crew, Grok CLI, …) is the brain. You point it at JobPilot
and say *“find and apply to AI jobs.”* The agent reasons; JobPilot provides the **hands** (it drives
*your* logged-in Chrome), the **memory** (a dedup database so you never double-apply), and a
**nervous system** that *learns from every failure and gets better on its own.*

It applies through **four channels** — email, LinkedIn Easy Apply, external ATS forms
(Greenhouse / Lever / Ashby / Workable), and LinkedIn connection requests — always **freshest jobs
first**. No API keys. No SMTP passwords. No scraping someone else’s data — it uses *your* real
LinkedIn and Gmail sessions, locally.

> 🎥 **Demo:** [`docs/demo.mp4`](docs/demo.mp4)

---

## Why JobPilot is different

| Most job bots | JobPilot |
|---|---|
| Ship their own brittle LLM prompts | **Agent-agnostic** — bring any MCP coding agent as the brain |
| One channel (usually just Easy Apply) | **Four channels**: email · Easy Apply · ATS forms · connect+note |
| Hard-code answers, break on new questions | **Self-evolving memory** — harvests your real answers, learns new ones, asks you *once* |
| Fail silently | **Encounter log** with screenshots + HTML snapshots your agent reads to *fix its own code* |
| Spam everything | **Dedup DB** + daily caps + relevance scoring, **freshest-posted first** |
| Need API keys / a second browser | **Your** Chrome, **your** logins, **your** Gmail — nothing leaves your machine |

### The self-evolution loop — the core idea

Every time JobPilot hits something it can’t handle — a weird Easy Apply question, a form with no
submit button, a login-gated ATS — it records an **encounter**: a normalized signature, a count, and
a saved **screenshot + HTML snapshot** under `data/evolution/`. It also:

- **harvests** the answers you’ve already filled on LinkedIn (your real years-of-experience, salary,
  work-authorization answers) and reuses them everywhere;
- turns anything it genuinely can’t infer into a **“question for you”**, asked **once** in the
  dashboard and then remembered forever;
- tracks which **search queries and ATS domains** actually convert, and reweights itself (UCB bandit)
  toward what works while auto-skipping dead ends.

Your coding agent reads the auto-generated `data/evolution/PLAYBOOK.md`, patches the relevant module,
and marks the encounter fixed. **The tool literally improves itself, session over session.**

---

## How it works

```
Your coding agent (Claude Code / Codex / Kiro / Crew / Grok)   ← the LLM brain
            │  speaks MCP (stdio)
            ▼
      JobPilot  (this server)                                  ← hands + memory + evolution
            │  Playwright over CDP (port 9222)
            ▼
      YOUR Chrome  (logged into LinkedIn / Gmail / ATS)
```

Or skip the conversation entirely and run the **always-on worker**, which drives all four channels
concurrently and never stops improving:

```bash
npm run worker
```

---

## 🚀 Getting started (zero human setup)

You do **not** install anything by hand. Clone the repo, add **one** entry to your agent’s MCP
config, and talk to your agent — it installs dependencies, launches your Chrome with the debug port,
and checks your logins through the bootstrap launcher (`start.js`).

### 1. Point your agent at JobPilot

**Claude Code / Claude Desktop** — `.mcp.json` or `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "jobpilot": { "command": "node", "args": ["ABSOLUTE/PATH/TO/start.js"] }
  }
}
```

**Codex CLI** — `~/.codex/config.toml`:
```toml
[mcp_servers.jobpilot]
command = "node"
args = ["ABSOLUTE/PATH/TO/start.js"]
```

**Kiro / Crew / any MCP client** — add an stdio server with `command: node`,
`args: ["ABSOLUTE/PATH/TO/start.js"]`.

> Point at **`start.js`**, not `mcp-server.js`. `start.js` self-installs dependencies on first run,
> launches your Chrome with the debug port + session restore, then starts the server.

### 2. Just talk to your agent

> *“find and apply to AI jobs”*

The agent (guided by [`AGENTS.md`](AGENTS.md)) will:
1. check setup (`onboard_status`);
2. launch your Chrome if needed (`launch_chrome`) — it relaunches Chrome with the debug port and
   restores your tabs/logins, so LinkedIn and Gmail come back automatically;
3. open a local **setup form** (`open_onboarding` → `http://127.0.0.1:7788/onboard`) where you
   **drag-and-drop your CV** and **paste your links/roles** — never type a file path in chat;
4. scrape, dedup, email, and apply — reporting live on the dashboard.

### 3. The setup form evolves with you

The only thing ever asked of you: fill the setup form once (CV + links + target roles). After that,
JobPilot keeps learning — the dashboard’s **🧠 Questions** tab surfaces any application question it
couldn’t answer; you answer it once, in the browser, and it’s reused on every future application.

---

## The dashboard

A local-only UI at **`http://127.0.0.1:7788`** (bound to localhost):

- **Pipeline view** — fresh email leads first, then per-channel queues (Easy Apply · Forms · Connect),
  all **newest-posted first**, with a live per-lane worker status.
- **🧠 Questions** — answer anything the agent couldn’t, inline. Remembered forever.
- **🧬 Evolution** — every open encounter with its screenshot + HTML snapshot, plus the growing table
  of learned answers.
- **Done log / Emails sent / Connects** — a full audit trail with over-contact warnings.

---

## Manual commands (optional)

```bash
npm run worker        # the always-on, four-lane, self-evolving engine
npm run doctor        # health check — what's ready, what's left
npm start             # run the bootstrap + MCP server by hand
npm run dashboard     # regenerate + open the dashboard
```

Worker env flags: `DRY=1` (scrape only, don’t send), `RUN_MS=<ms>` (time-box a run).

---

## Project structure

```
jobpilot/
├── start.js                # ← MCP config points HERE (self-installs, launches Chrome, starts server)
├── mcp-server.js           # the MCP server (31 fine-grained tools)
├── AGENTS.md               # the guide your agent reads to drive everything zero-touch
├── src/
│   ├── worker.js           # always-on engine: scout · mailer · applier · connector (concurrent)
│   ├── evolve.js           # self-evolution memory: encounters · learned answers · strategy bandit
│   ├── profile.js          # personalization (CV, links, roles, salary, work-auth) — read from data/
│   ├── tracker.js          # jobs DB + dedup guards + channel queues
│   ├── dashboard.js        # the pipeline + Questions + Evolution dashboard
│   ├── server.js           # local web server: onboarding form, dashboard, /api/answers, /evidence
│   ├── mcp/
│   │   ├── sources.js      # freshest-first lead sources (LinkedIn posts/jobs, HN, Reddit, boards)
│   │   ├── easyapply.js    # LinkedIn Easy Apply (harvests + answers + verifies)
│   │   ├── forms.js        # external ATS forms (resolves job-board → real ATS)
│   │   ├── connect.js      # connection request + personalized note
│   │   ├── answers.js      # profile-driven answer engine (+ learned memory)
│   │   ├── gmail.js        # send via the user's logged-in Gmail (CV auto-attached, verified)
│   │   └── chrome.js       # launch Chrome with the debug port on demand
│   └── agent/browser.js    # single CDP connection to your Chrome
├── data/                   # EVERYTHING personal lives here — gitignored
│   ├── profile.json  jobs.db  uploads/  evolution/  chrome-debug-profile/
└── docs/demo.mp4
```

---

## Privacy & safety

- **Your data never leaves your machine.** Profile, CV, scraped jobs, dedup history, harvested
  answers, and the logged-in Chrome profile all live under `data/`, which is **gitignored**.
- **No credentials in code.** No API keys, no SMTP passwords — JobPilot uses your existing browser
  sessions.
- **Dedup is permanent.** `data/jobs.db` means you never re-email, re-apply, or re-connect across
  runs or across different agents.
- **Caps & attempt limits** are enforced and recorded.

---

## Contributing

Issues and pull requests are very welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). Good first
contributions: new ATS adapters in `src/mcp/forms.js`, new lead sources in `src/mcp/sources.js`, and
resilience fixes driven by the encounters in your own `data/evolution/PLAYBOOK.md`.

## License

[MIT](LICENSE) © JobPilot contributors.
