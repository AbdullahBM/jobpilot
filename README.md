<div align="center">

# 🧭 JobPilot

### The self-evolving, agent-driven job hunter that lives in *your* browser.

**Bring your own AI coding agent as the brain. JobPilot is the hands, the memory, and the
nervous system — it applies for you across four channels, learns from every failure, and ships
its own fixes back to this repo.**

[![MIT License](https://img.shields.io/badge/license-MIT-22c55e.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/protocol-MCP-3b82f6.svg)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-339933.svg)](https://nodejs.org)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-a855f7.svg)](CONTRIBUTING.md)
[![Self-evolving](https://img.shields.io/badge/%F0%9F%A7%AC-self--evolving-f59e0b.svg)](#-the-self-evolution-loop)

![JobPilot demo](docs/demo.gif)

</div>

---

## 💡 What is this?

JobPilot is an [MCP](https://modelcontextprotocol.io) server with **no LLM of its own**. *Your*
coding agent — Claude Code, Codex, Kiro, Crew, Grok CLI — is the brain. You point it at JobPilot
and say *“find and apply to AI jobs.”*

The agent reasons. JobPilot provides:

- **🖐 Hands** — it drives *your* already-logged-in Chrome (LinkedIn, Gmail, ATS) over the DevTools protocol.
- **🧠 Memory** — a local dedup database so you never double-apply, across runs or agents.
- **🧬 A nervous system** — it records every failure, *learns from it*, and gets measurably better each session.

No API keys. No SMTP passwords. No scraping of other people's data. Your sessions, your machine, your data.

---

## ⚡ What it actually does — four channels, freshest-first

| Channel | What happens |
|---|---|
| ✉️ **Email** | Finds hiring emails in LinkedIn posts, HN "Who is hiring", Reddit & boards → sends a tailored email from **your Gmail**, CV auto-attached & verified. |
| ⚡ **LinkedIn Easy Apply** | Walks the multi-page modal, answers every question, uploads your CV, and **verifies "Application submitted."** |
| 📋 **External ATS forms** | Greenhouse · Lever · Ashby · Workable — resolves job-board links to the real ATS, fills react-selects / radios / consent, submits, confirms. |
| 🔗 **LinkedIn connect + note** | When there's no email/form, sends the poster a personalized connection request. |

Everything is ordered **newest-posted first** — because the first applicant gets read.

---

## 🧬 The self-evolution loop

This is what makes JobPilot different from every other job bot.

Every time it hits something it can't handle — a weird Easy Apply question, a form with no submit
button, a login-gated ATS — it records an **encounter**: a normalized signature, a running count,
and a saved **screenshot + HTML snapshot** under `data/evolution/`. Then it:

1. **🪄 Harvests** the answers you've *already* filled on LinkedIn (your real years-of-experience,
   salary, work-authorization) and reuses them everywhere.
2. **🙋 Asks you once.** Anything it genuinely can't infer becomes a *“question for you”* in the
   dashboard — answer it one time, remembered forever (fuzzy-matched across all future applications).
3. **📈 Reweights itself.** It tracks which search queries and ATS domains actually convert and
   shifts toward what works (UCB bandit), auto-skipping dead ends.
4. **🔁 Contributes back.** It files GitHub issues for blockers it discovers and pushes code/doc
   improvements to this repo — **automatically, attributed to you, never leaking your data.**

> Your coding agent reads the auto-generated `data/evolution/PLAYBOOK.md`, patches the relevant
> module, marks the encounter fixed — and the fix is pushed back for everyone. **The repository
> literally improves itself, session over session.**

---

## 🏆 What's been achieved

- **All four channels working end-to-end** against the live 2026 LinkedIn / ATS DOM — including the
  shadow-DOM Easy Apply modal and the "Connect is hidden under the More menu" profile layout.
- **A real answer engine** that harvests your prefilled answers, converts currencies/periods for
  salary questions, handles yes/no work-authorization logic, and escalates the truly-unknown to you.
- **A concurrent worker** — scout · mailer · applier · connector run in parallel lanes, so scraping
  never blocks applying and email never blocks Easy Apply.
- **A pipeline dashboard** with per-lane live status, a 🧠 Questions tab, and a 🧬 Evolution tab that
  shows every blocker with its screenshot + HTML snapshot.
- **Zero personal data in the codebase** — everything about you lives in `data/` (gitignored).

---

## 🚀 Getting started (zero human setup)

You don't install anything by hand. Clone the repo, add **one** entry to your agent's MCP config,
and talk to your agent — it self-installs, launches your Chrome with the debug port, and checks
your logins through the bootstrap launcher (`start.js`).

### 1. Point your agent at JobPilot

**Claude Code / Claude Desktop** — `.mcp.json`:
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

**Kiro / Crew / any MCP client** — add an stdio server: `command: node`,
`args: ["ABSOLUTE/PATH/TO/start.js"]`.

> Point at **`start.js`**, not `mcp-server.js`. It self-installs dependencies on first run,
> relaunches Chrome with the debug port + session restore, then starts the server.

### 2. Just talk to your agent

> *“find and apply to AI jobs”*

The agent (guided by [`AGENTS.md`](AGENTS.md)) checks setup, launches your Chrome, opens a local
**setup form** where you drag-and-drop your CV and paste your links/roles (never a file path in
chat), then scrapes, dedups, emails and applies — reporting live on the dashboard.

### 3. Or run the always-on engine

```bash
npm run worker
```

Four concurrent lanes, freshest-first, self-evolving, with the dashboard + Questions tab live at
**http://127.0.0.1:7788**. Flags: `DRY=1` (scrape only), `RUN_MS=<ms>` (time-box).

---

## 📊 The dashboard

A local-only UI at **http://127.0.0.1:7788** (bound to localhost):

- **Pipeline** — fresh email leads first, then per-channel queues, newest-posted first, with live per-lane status.
- **🧠 Questions** — answer anything the agent couldn't, inline. Remembered forever.
- **🧬 Evolution** — every open encounter with its screenshot + HTML snapshot, plus the learned-answers table.
- **Done log / Emails sent / Connects** — a full audit trail with over-contact warnings.

---

## 🧱 Known blockers (help wanted!)

Some sites actively fight automation or gate applications behind accounts. JobPilot handles these
gracefully (routes the lead elsewhere / asks you) and we track them as open issues:

- **Indeed** — anti-bot / login wall ([#1](https://github.com/maazbin/jobpilot/issues/1))
- **Glassdoor** — login + anti-bot wall ([#2](https://github.com/maazbin/jobpilot/issues/2))
- **Workday / iCIMS / Taleo / SuccessFactors** — account-gated multi-step ATS ([#3](https://github.com/maazbin/jobpilot/issues/3))
- **Job-board redirects** (Arbeitnow / WeWorkRemotely / Himalayas) ([#4](https://github.com/maazbin/jobpilot/issues/4))

Want to knock one out? See [CONTRIBUTING.md](CONTRIBUTING.md) — these make great first PRs.

---

## 🗂 Project structure

```
jobpilot/
├── start.js                # ← MCP config points HERE (self-installs, launches Chrome, starts server)
├── mcp-server.js           # the MCP server (31 fine-grained tools)
├── AGENTS.md               # the guide your agent reads to drive everything zero-touch
├── src/
│   ├── worker.js           # always-on engine: scout · mailer · applier · connector (concurrent)
│   ├── evolve.js           # self-evolution memory: encounters · learned answers · strategy bandit
│   ├── contribute.js       # self-improving loop: files issues + pushes fixes (data-safe)
│   ├── profile.js          # personalization — read from data/ (gitignored)
│   ├── tracker.js          # jobs DB + dedup guards + channel queues
│   ├── dashboard.js        # pipeline + Questions + Evolution dashboard
│   ├── server.js           # local web server: onboarding, dashboard, /api/answers, /evidence
│   └── mcp/                # sources · easyapply · forms · connect · answers · gmail · chrome
├── data/                   # EVERYTHING personal lives here — gitignored
└── docs/demo.gif
```

---

## 🔒 Privacy & safety

- **Your data never leaves your machine.** Profile, CV, scraped jobs, dedup history, harvested
  answers, and the logged-in Chrome profile all live under `data/`, which is **gitignored**.
- **No credentials in code.** JobPilot uses your existing browser sessions — no API keys, no SMTP.
- **The self-contribution loop is data-safe by construction**: an allowlist + a sensitive-path
  tripwire abort any push that would include `data/`, `.env`, drafts, logs, screenshots or the DB.
- **Dedup is permanent**, and daily caps + attempt limits are enforced and recorded.

---

## 🤝 Contributing

Issues and PRs are very welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). Great first contributions:
a new ATS adapter in `src/mcp/forms.js`, a new lead source in `src/mcp/sources.js`, or a resilience
fix driven by a real encounter in `data/evolution/PLAYBOOK.md`.

## 📄 License

[MIT](LICENSE) © [maazbin](https://github.com/maazbin) and JobPilot contributors.
