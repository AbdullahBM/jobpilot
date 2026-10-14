// src/dashboard/partials/clientscripts.js — Browser-side JavaScript for the dashboard.
// Returned as a <script> block string. Handles tab switching, answer saving,
// consent toggle, worker stop, bank filtering, and answer override.
//
// API BASE: when the page is served over HTTP (the normal case — you open
// http://127.0.0.1:<port>/ from the server), all API calls use `location.origin`, so they ALWAYS
// hit the exact server that served the page. This fixes the previous bug where a baked-in port
// (sometimes wrong, e.g. the Chrome debug port, or a stale instance's port) broke saving answers.
// Only the file:// fallback uses the known port passed from the coordinator.

/**
 * Returns the inline <script> block for the dashboard.
 * @param {number} UIPORT - fallback dashboard port, used only when opened as a file:// URL
 * @returns {string} HTML <script>...</script>
 */
export function dashScripts(UIPORT) {
  return `<script>
// ── API base — always talk to the server that served this page ─────────────────
function apiBase(){
  // Served over http(s): use this page's own origin (correct port, every time).
  if (location.protocol === 'http:' || location.protocol === 'https:') return location.origin;
  // Opened as a local file: fall back to the known dashboard port.
  return 'http://127.0.0.1:${UIPORT}';
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(t){
  document.querySelectorAll('.pane').forEach(e => e.classList.toggle('on', e.id === 'p-' + t));
  document.querySelectorAll('.tabs button').forEach(e => e.classList.toggle('on', e.id === 'b-' + t));
  history.replaceState(null, '', '#tab-' + t);
}
(function(){
  const m = location.hash.match(/tab-(\\w+)/);
  switchTab(m ? m[1] : 'easy_apply');
})();

// ── Bank filter ───────────────────────────────────────────────────────────────
function flt(v){
  v = v.toLowerCase();
  document.querySelectorAll('#bank tbody tr').forEach(r => r.style.display = r.innerText.toLowerCase().includes(v) ? '' : 'none');
}

// ── Save a user-provided answer ───────────────────────────────────────────────
async function ans(qkey, value){
  if (!value) return;
  const base = apiBase();
  const btn = event && event.target;
  if (btn) { btn.disabled = true; btn.textContent = 'saving…'; }
  try {
    const r = await fetch(base + '/api/answers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ qkey, answer: value })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    location.hash = '#tab-questions';
    location.reload();
  } catch(e) {
    if (btn) { btn.disabled = false; btn.textContent = 'save'; }
    alert('Could not save — open the dashboard from the server URL (' + base + '), not the .html file.\\n\\nError: ' + e.message);
  }
}

// ── Override an agent-answered question ───────────────────────────────────────
function overrideAns(qkey, currentVal){
  const newVal = prompt('Override agent answer for this question:\\n\\n(current: ' + currentVal + ')', currentVal);
  if (newVal !== null && newVal.trim()) ans(qkey, newVal.trim());
}

// ── Consent toggle ────────────────────────────────────────────────────────────
async function consent(on){
  const base = apiBase();
  try {
    const r = await fetch(base + '/api/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoContribute: on })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    location.reload();
  } catch(e) {
    alert('Could not update consent — open the dashboard from the server URL (' + base + ').\\n\\nError: ' + e.message);
  }
}

// ── Multi-brain evolution loop toggle ─────────────────────────────────────────
async function brainLoop(on){
  const base = apiBase();
  const label = on
    ? 'Enable the multi-brain evolution loop?\\n\\nYour installed coding-agent CLIs (Codex, Grok, Claude, Gemini) will take turns autonomously reasoning over failures and pushing code/doc fixes to the repo. Strictly CLIs — no API keys are ever used. Hard-guarded: never your data or credentials.'
    : 'Turn off the multi-brain evolution loop? Installed brains will stop auto-improving the agent.';
  if (!confirm(label)) return;
  try {
    const r = await fetch(base + '/api/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoBrainLoop: on })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    location.reload();
  } catch(e) {
    alert('Could not update multi-brain loop consent — open the dashboard from the server URL (' + base + ').\\n\\nError: ' + e.message);
  }
}

// Explicit approval gate for job-specific CV drafts/uploads. Disabled by default.
async function tailoredConsent(on){
  const base = apiBase();
  const label = on ? 'Approve generating/uploading tailored CV drafts for slightly related roles?' : 'Disable tailored CV generation and uploads?';
  if (!confirm(label)) return;
  try {
    const r = await fetch(base + '/api/tailored-cv-consent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allowTailoredCv: on })
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    location.hash = '#tab-cv'; location.reload();
  } catch(e) { alert('Could not update tailored CV approval: ' + e.message); }
}

// ── Stop the worker ───────────────────────────────────────────────────────────
async function stopAll(){
  if (!confirm('Stop the JobPilot worker? All lanes halt within a few seconds. Your logged-in Chrome stays open.')) return;
  const base = apiBase();
  const b = event && event.target;
  if (b) { b.disabled = true; b.textContent = 'Stopping…'; }
  try {
    const r = await fetch(base + '/api/stop', { method: 'POST' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (b) b.textContent = 'Stopped ✓';
  } catch(e) {
    if (b) { b.disabled = false; b.textContent = '⏹ Stop worker'; }
    alert('Could not stop — open the dashboard from the server URL (' + base + ').\\n\\nError: ' + e.message);
  }
}
</script>`;
}
