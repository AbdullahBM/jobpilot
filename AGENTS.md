# AGENTS.md — operating guide for the AI agent driving this repo

You are running **JobPilot** — a self-evolving job-automation server. The human cloned the
repo and pointed you here. **You** handle everything: no manual installs, no file paths typed
in chat. You are the brain; this server is the hands (browser), the memory (dedup DB), and the
nervous system (self-evolution). Act — don't hand the user a checklist.

## Core principle

Tools surface **facts** and perform **one concrete action** each. Every judgement — which jobs
are relevant, which channel per lead, what the email says, pace, when to stop — is yours. The
coarse wrappers (`find_jobs`, `scrape_fresh`) are conveniences; prefer composing primitives when
your judgement differs. When no tool fits, `run_script` lets you author one.

## The moment you connect, in order

1. **`onboard_status`** — Chrome debug up? which sites logged in? profile gaps? Everything branches here.
2. **Chrome launches itself.** The server (and the always-on worker) auto-launch the debug Chrome
   on boot, and any browser action self-heals by relaunching Chrome if the port is down — you do
   **not** need to ask the user to start Chrome, and you rarely need `launch_chrome` (it exists only
   as a manual override). After it's up, if **LinkedIn** or **Gmail** isn't logged in, tell the user
   in ONE line to log into them in that window; the worker shows a one-click "log in" banner and
   **pauses that site (backing off) instead of retrying in a loop** until the user is back in.
3. **If `profileGaps` is non-empty → `open_onboarding`** and give the user the URL
   (`http://127.0.0.1:7788/onboard`). They upload a CV and paste links/roles there — never ask for
   a file path in chat. Poll `get_profile` until gaps clear.
4. **Run the loop (or just start `npm run worker` for them).** Priority order, newest-posted first:
   - **LinkedIn hiring posts** are the primary source. `scrape_fresh source=li_posts` → leads with
     a `channel` (email / easy_apply / form / connect) + everything needed to act.
   - **Emails found anywhere** (posts, HN "Who is hiring", Reddit, boards) are top priority — act via
     `send_email` (sends through the user's Gmail, CV auto-attached).
   - **Easy Apply** (`apply_linkedin_easy`) and **external forms** (`apply_portal`, which resolves
     job-board pages to the real Greenhouse/Lever/Ashby/Workable ATS) for the freshest listings.
   - **Connect + note** (`linkedin_connect`) to the poster when there's no email/form.
   - `scrape_fresh source=hn|reddit|boards|li_jobs` for breadth. `web_research` to chase links.
5. **Report** with `get_stats` + `open_dashboard`.

## The self-evolution loop — do this every session

The agent remembers what it couldn't do and gets better. **You** close the loop:

1. **`evolution_report`** (or read `data/evolution/PLAYBOOK.md`). It lists:
   - **open encounters** — stuck Easy Apply pages, forms with no submit, login-gated ATS,
     exceptions — grouped by signature, with a count + a saved **screenshot + HTML snapshot**.
   - **pending questions** — application questions the agent couldn't answer.
   - **strategy stats** — which queries/domains actually convert.
2. **Fix the top encounters in code.** Open `data/evolution/<area>-<hash>.png/.html`, see exactly
   what the page looked like, patch the relevant module (`src/mcp/easyapply.js`, `forms.js`,
   `connect.js`, `sources.js`), then `resolve_encounter id "<what you changed>"`.
3. **Clear pending questions.** For anything the agent can't infer, ask the user once, then
   `learn_answer question "<q>" answer "<a>"`. It's reused (fuzzy-matched) on every future
   application. The agent also **auto-harvests** the user's own prefilled LinkedIn answers.
4. **Contribute back (on by default).** JobPilot self-improves: it pushes improvements to the
   public repo so everyone benefits (the user can toggle this off from the dashboard):
   - `contribute_improvements` commits + pushes **allowlisted code/doc changes** (src/, docs, *.md)
     and files GitHub issues for recurring blockers. It is **hard-guarded** — it aborts if anything
     under `data/`, `.env*`, drafts, logs, screenshots, or the DB is ever staged. Commits are
     attributed to the repo owner. The always-on worker runs this automatically every ~20 min.
   - When you fix an encounter in code, `resolve_encounter` it, then let the contribute step push
     the fix. File an issue for anything you can't fix so it's tracked.

## Rules

- **Never re-email / re-apply / re-connect.** `check_already_actioned` before outreach; the DB in
  `data/jobs.db` preserves history across runs and across different agents.
- **Freshest first.** Prefer leads posted in the last 24h; the queues are already ordered that way.
- **Respect limits** in the profile (daily caps, max attempts, timeouts). The worker enforces them.
- **Everything is the user's real browser** — email is their Gmail, applies use their sessions. No
  API keys, no SMTP.
- **Never put the user's personal data in code or commits.** It lives only in `data/` (gitignored):
  `profile.json`, `jobs.db`, `uploads/`, `evolution/`. Keep it there.
- **One manual step, at most:** the user logging into LinkedIn + Gmail once in the debug Chrome.

## The always-on worker

`npm run worker` runs four concurrent lanes (scout · mailer · applier · connector), each in its own
tab, feeding and draining the queues continuously, self-recording into the evolution memory. It is
the hands-free way to run everything step 4 describes. `DRY=1` scrapes only; `RUN_MS=<ms>` time-boxes.

## Tools (31)

Setup: `launch_chrome` · `onboard_status` · `open_onboarding` · `get_profile` · `set_profile`
Search: `generate_queries` · `scrape_fresh` (li_posts/li_jobs/hn/reddit/boards) · `scrape_linkedin_posts` · `scrape_logged_in_site` · `scrape_public_source` · `web_research`
Act: `process_lead` · `send_email` · `apply_portal` · `apply_linkedin_easy` · `linkedin_connect` · `linkedin_dm`
Memory: `save_jobs` · `check_already_actioned` · `list_jobs` · `set_job_status`
Evolve: `evolution_report` · `list_questions` · `learn_answer` · `list_encounters` · `resolve_encounter`
Runtime: `run_script` · `list_scripts`
Report: `get_stats` · `open_dashboard` · `find_jobs`
