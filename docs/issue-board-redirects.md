Several aggregator / job-board hosts don't host a real application form on the posting page —
they link out to the employer's own careers page or a non-standard ATS. JobPilot resolves the
"Apply" link but, when the destination isn't one of the supported ATSs
(Greenhouse/Lever/Ashby/Workable), it can't find a form and marks the lead `needs_manual`.

### Observed hosts (from the Evolution memory)
- `arbeitnow.com` / `arbeitnow.ch` / `arbeitnow.co.uk` / `arbeitnow.fr`
- `weworkremotely.com`
- `himalayas.app`
- `remoteok.com` (apply link bounces back to the listing)
- `lnkd.in` shortlinks that resolve to a company page without a standard form

### Where it shows up
- `src/mcp/sources.js` → `publicBoards()` emits these leads with `channel: 'form'`.
- `src/mcp/forms.js` → `toForm()` follows the apply link; when no known ATS/form is found it
  records a `form` encounter and returns `needs_manual`.

### What would "done" look like
- A small resolver that, for each board, extracts the **employer domain** and finds the real
  careers/ATS page (e.g., detect Greenhouse/Lever/Ashby embeds, or a `careers.<company>` link).
- Prefer an email channel when the posting exposes a contact address.

### Good first contribution
Add a host → resolver map in `toForm()` for **one** board (WeWorkRemotely is the easiest: its
"Apply" opens the employer URL in a known place). Use the saved HTML snapshot in
`data/evolution/` as a fixture.

_Labels: ats-adapter, good first issue_
