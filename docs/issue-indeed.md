JobPilot cannot currently apply to **Indeed**-hosted postings. When a lead's apply flow
resolves to `indeed.com`, the page presents an anti-automation wall (CAPTCHA / Cloudflare
challenge / login gate), so the applier marks the lead `needs_manual` instead of submitting.

### Where it shows up
- `src/mcp/forms.js` → `applyForm()` detects `indeed.com` in the resolved URL and returns
  `needs_manual` ("redirected to login/aggregator").
- Surfaced in the dashboard **🧬 Evolution** tab as a `form` encounter on `indeed.com`.

### Why it's hard
Indeed aggressively fingerprints automation (navigator.webdriver, canvas/WebGL, timing),
gates "Apply" behind a login + often a CAPTCHA, and rotates DOM/class names. Reliable,
ToS-respecting automation of Indeed apply is not currently feasible from a driven browser.

### What would "done" look like
- Detect Indeed early and **route the lead to a better channel** (company careers page / the
  recruiter's email / LinkedIn) instead of dead-ending.
- Where the posting links to a real ATS behind Indeed, follow through to that ATS.
- Never attempt CAPTCHA solving or ToS-violating evasion.

### Good first contribution
Add an `indeed.com` branch in `forms.js` that extracts the employer's real careers/ATS link
from the Indeed posting (when present) and hands off to the existing ATS flow; otherwise mark
the lead `connect`/`email` so it still gets actioned.

_Labels: blocker, help wanted_
