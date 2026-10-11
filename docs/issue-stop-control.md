The always-on worker (`npm run worker`) runs four concurrent lanes plus a local web server. Today
there is **no visible UI control to stop it** — the user has to find the terminal and Ctrl+C, or
hunt down the Node process. If the dashboard was opened and the terminal is gone, the worker keeps
running in the background with no obvious off switch.

### Impact
- Confusing: the dashboard shows "Worker LIVE" but offers no way to turn it off.
- Risk: background runs can keep hitting LinkedIn/applying when the user thinks they stopped.

### What "done" looks like
- A visible **⏹ Stop all** button in the dashboard header that halts every lane gracefully.
- An endpoint (`POST /api/stop`) + a stop flag the worker checks each loop, so lanes finish the
  current action and exit cleanly (closing their browser tabs — but **not** the user's debug Chrome,
  whose logins must persist).
- An `npm run stop` convenience command for terminal users.
- The dashboard header reflects "Stopping… / Stopped" state.

### Notes
- Must not kill the user's logged-in debug Chrome (that holds LinkedIn/Gmail sessions).
- A fix for this is being implemented alongside this issue (dashboard Stop button + `/api/stop` +
  stop-flag the lanes honor).

_Labels: enhancement, good first issue_
