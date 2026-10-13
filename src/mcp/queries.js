// src/mcp/queries.js — Generate diverse search queries from the user profile.
// Covers ALL the user's roles (backend, python, system design, product eng, AI, …),
// not just AI, so lead sourcing spans everything they'd actually take.
import { getProfile } from '../profile.js';

// Phrasings that surface HIRING POSTS (not just listings) on LinkedIn content search.
const HIRING_PHRASES = ['hiring', 'we are hiring', 'looking for', 'join our team', 'open role', 'now hiring'];
const APPLY_SIGNALS = ['email your cv', 'dm me', 'apply', 'remote'];

/**
 * Build a deduped list of search queries from the profile's roles + keywords.
 * Each role gets a few phrasings; country-scoped profiles also inject location terms
 * so LinkedIn content search surfaces local hiring posts.
 */
export function buildQueries({ limit = 30 } = {}) {
  const p = getProfile();
  const roles = (p.preferences?.roles || []).length
    ? p.preferences.roles
    : ['AI Engineer', 'Backend Engineer', 'Python Engineer', 'Software Engineer'];
  const kws = p.preferences?.keywords || [];
  const skills = p.skills || p.preferences?.skills || [];
  const remote = p.preferences?.remoteOnly ? ' remote' : '';

  // Country-scoped: append location terms so LinkedIn content search surfaces local hiring posts.
  const isCountryScope = p.preferences?.locationScope === 'country';
  const isPakistan = isCountryScope && String(p.country || '').toLowerCase() === 'pakistan';
  const locationVariants = isPakistan ? [' Pakistan', ' Karachi', ' Lahore', ''] : [''];

  const out = new Set();
  for (const role of roles) {
    for (const loc of locationVariants) {   // all location variants per role
      out.add(`hiring ${role}${loc}${remote}`);
      out.add(`we are hiring ${role}${loc}${remote}`);
    }
    out.add(`looking for ${role}${remote} email your cv`);
  }

  // Pakistan-specific hiring phrases that local recruiters use on LinkedIn.
  if (isPakistan) {
    for (const role of roles.slice(0, 4)) {
      out.add(`${role} job Pakistan`);
      out.add(`hiring ${role} Pakistan email cv`);
    }
    out.add('AI Engineer Pakistan hiring');
    out.add('Backend Engineer Pakistan hiring');
    out.add('Python developer Pakistan hiring');
    out.add('LLM engineer Pakistan');
    out.add('FastAPI developer Pakistan');
    out.add('Machine Learning Engineer Karachi');
    out.add('AI Engineer remote Pakistan');
  }

  // Keyword-driven (langchain, fastapi, system design, …)
  for (const k of kws.slice(0, 8)) out.add(`hiring ${k} engineer${remote}`);
  // SKILLS-driven — match on what they can DO, not only titled roles (steering).
  for (const s of skills.slice(0, 8)) out.add(`hiring ${s}${remote}`);
  // Freelance / contract — a whole separate lane the user explicitly wants.
  out.add(`freelance developer${remote} hiring`);
  out.add(`contract engineer${remote} dm me`);
  out.add(`looking for freelance${remote} email your cv`);
  // Generic high-yield outreach phrasings
  out.add(`hiring software engineer${remote} dm me`);
  out.add(`founding engineer${remote} hiring`);

  return [...out].slice(0, limit);
}

/** Queries for LinkedIn JOB LISTINGS (jobs/search), roles + skills + freelance. */
export function buildListingQueries({ limit = 18 } = {}) {
  const p = getProfile();
  const roles = (p.preferences?.roles || []).length ? p.preferences.roles : ['AI Engineer', 'Backend Engineer'];
  const skills = p.skills || p.preferences?.skills || [];
  const remote = p.preferences?.remoteOnly ? ' remote' : '';
  const out = new Set();
  for (const r of roles) out.add(`${r}${remote}`);
  for (const s of skills.slice(0, 6)) out.add(`${s}${remote}`);
  out.add(`freelance${remote}`);
  out.add(`contract${remote}`);
  return [...out].slice(0, limit);
}

/** Freelance/marketplace listing queries (login-free boards too). */
export function buildFreelanceQueries() {
  const p = getProfile();
  const skills = (p.skills || p.preferences?.skills || []).slice(0, 6);
  const base = ['freelance', 'contract', 'part-time remote'];
  const out = new Set(base);
  for (const s of skills) out.add(`freelance ${s}`);
  return [...out];
}

/**
 * Relevance by SKILLS + EXPERIENCE, not fixed role titles (steering).
 * Returns a 0..1 score: fraction of the user's skills/keywords/role-words that
 * appear in the job text. The AGENT sets its own threshold; this is a signal.
 */
export function relevantBySkills(text = '') {
  const p = getProfile();
  const t = (text || '').toLowerCase();
  if (!t) return 0;
  const terms = new Set();
  for (const s of (p.skills || p.preferences?.skills || [])) terms.add(s.toLowerCase());
  for (const k of (p.preferences?.keywords || [])) terms.add(k.toLowerCase());
  for (const r of (p.preferences?.roles || [])) r.toLowerCase().split(/\s+/).forEach(w => w.length > 2 && terms.add(w));
  if (!terms.size) return 0;
  let hit = 0;
  for (const term of terms) if (t.includes(term)) hit++;
  return hit / terms.size;
}
