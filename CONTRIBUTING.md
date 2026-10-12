# Contributing to JobPilot

Thanks for your interest — contributions are very welcome! JobPilot gets better the more adapters,
lead sources, and resilience fixes the community adds.

## Ground rules

- **Never commit personal data.** Everything under `data/` is gitignored (profile, CV, scraped jobs,
  the logged-in Chrome profile, evolution snapshots). Double-check `git status` before you commit.
- **No credentials in code.** JobPilot deliberately uses the user's own browser sessions — don't add
  API keys, SMTP passwords, or tokens.
- Keep the agent-agnostic design: tools expose **facts** and perform **one concrete action**; the
  reasoning stays in the user's coding agent.

## Dev setup

```bash
git clone https://github.com/<you>/jobpilot
cd jobpilot
npm install
npx playwright install chromium   # if your agent hasn't already
npm run doctor                    # health check
```

Run the MCP server by hand with `npm start`, or the always-on engine with `npm run worker`
(use `DRY=1` to scrape without sending, `RUN_MS=60000` to time-box).

## Great first contributions

- **New ATS adapters** in `src/mcp/forms.js` — add detection + field mapping for an ATS that
  currently lands in "needs you". Use the saved snapshot in `data/evolution/` as your fixture.
- **New lead sources** in `src/mcp/sources.js` — another board or community, returning the standard
  lead shape (`{ role, company, url, email, applyUrl, posterUrl, postedAt, channel, relevance }`).
- **Resilience fixes** — pick an open encounter from your own `data/evolution/PLAYBOOK.md`, reproduce
  it from the saved HTML snapshot, fix the selector/flow, and note it in the PR.

## Pull requests

1. Branch from `main`, keep the change focused.
2. Make sure `node --check` passes on changed files and `npm run doctor` is happy.
3. If you fixed an encounter, describe which signature it addressed.
4. Open the PR with a clear before/after. Screenshots of the dashboard help.

## Automated self-evolution PRs & the security gate

JobPilot contributes its own improvements back as **pull requests to this repo** (never direct
pushes from forks). Every PR — human or automated — is gated by `.github/workflows/self-evolve-review.yml`:

- **Security gate** (`node scripts/ci-security-scan.mjs`): the merge is blocked if the PR introduces
  any path under `data/`, `.env`, `drafts/`, `applied/`, `logs/`, screenshots, or the DB, or if any
  changed file contains a secret (private key, AWS key, SMTP password, GitHub/Slack token, …).
- **Syntax check** on every changed `.js`/`.mjs`, plus a **boot smoke test** of the MCP server.
- Clean PRs labeled `self-evolve` **auto-merge** once the `review` check is green (branch protection
  on `main` requires it).

When a fork's agent learns something, it opens the PR **upstream to this repo immediately**, and
keeps its own branch in sync (rebased on `upstream/main`) so contributions never drift. If you'd
rather it stayed local, toggle self-contribution off from the dashboard.

## Reporting bugs

Open an issue using the templates. For a stuck page, attach the (personal-data-redacted) HTML
snapshot or a screenshot from `data/evolution/` — that's exactly what the fix needs.
