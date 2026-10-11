JobPilot cannot currently apply to **Glassdoor**-hosted postings. Glassdoor forces a login
wall + anti-bot challenge before the job detail / apply form is reachable, so the applier
cannot read or submit the form and marks the lead `needs_manual`.

### Where it shows up
- `src/mcp/forms.js` → `applyForm()` detects `glassdoor` in the resolved URL and bails to
  `needs_manual`.
- Appears in the **🧬 Evolution** tab as a `form` encounter on `glassdoor.com`.

### Why it's hard
Glassdoor requires an authenticated session for most job content, overlays a sign-up/contribute
wall, and uses bot detection. Even logged in, "Apply" usually bounces to the employer's own ATS.

### What would "done" look like
- When logged in, follow Glassdoor's "Apply on company site" link through to the real ATS and
  reuse the existing Greenhouse/Lever/Ashby/Workable flow.
- Otherwise route the lead to email/connect so it isn't lost.
- No ToS-violating evasion or CAPTCHA solving.

### Good first contribution
Add a `glassdoor` branch in `forms.js` that clicks "Apply on company site" and hands the
resulting ATS URL to `applyForm()` recursively.

_Labels: blocker, help wanted_
