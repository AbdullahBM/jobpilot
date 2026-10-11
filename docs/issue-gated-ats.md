Account-gated, multi-step ATSs — **Workday**, **iCIMS**, **Taleo**, **SuccessFactors**,
**Oracle Cloud**, **BrassRing** — require creating an account (email verification) and span
many pages with custom widgets. JobPilot currently detects these and marks the lead
`needs_manual` rather than attempting a brittle, partial application.

### Where it shows up
- `src/mcp/forms.js` → `applyForm()` matches `workday|myworkdayjobs|icims|taleo|successfactors|
  oraclecloud|brassring` and returns `needs_manual` ("account-gated ATS — one-click for you").

### Why it's hard
These ATSs gate applications behind account creation + email verification, use heavily dynamic
multi-step wizards, and vary per tenant. A reliable adapter needs per-ATS handling and a way to
complete the e-mail verification loop.

### What would "done" look like
- A per-ATS adapter module (start with **Workday**, the most common) that creates/reuses an
  account, completes the wizard from the profile + answer engine, and verifies submission.
- Email-verification handled via the user's logged-in Gmail (already automated for sending).

### Good first contribution
Pick **one** ATS (Workday recommended). Use the saved HTML snapshot in `data/evolution/` as a
fixture, build a step walker in a new `src/mcp/ats/<name>.js`, and dispatch to it from
`forms.js` when the host matches.

_Labels: ats-adapter, help wanted_
