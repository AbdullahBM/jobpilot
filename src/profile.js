// src/profile.js — User personalization store.
// Holds CV path, contact info, links, portfolios, and custom Q&A answers.
// The agent reads this to personalize emails and fill application forms.
// Persisted as JSON so it survives restarts and is easy to hand-edit.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..');
const PROFILE_FILE = path.join(ROOT, 'data', 'profile.json');

fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });

// ── Default shape — everything the agent might need to personalize ────────────
const DEFAULT_PROFILE = {
  // Identity
  name: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  location: '',

  // Files
  cvPath: '',            // absolute path to CV/resume PDF
  coverLetterPath: '',   // optional default cover letter

  // Links (free-form — add as many as you like)
  links: {
    linkedin: '',
    github: '',
    portfolio: '',
    website: '',
    // user can add any: twitter, youtube, calendly, dribbble, etc.
  },

  // Projects to mention in outreach (headline achievements)
  projects: [],          // [{ name, url, blurb }]

  // What the agent looks for
  preferences: {
    roles: [],           // ["AI Engineer", "ML Engineer", "Backend Engineer"]
    skip: [],            // ["sales", "junior", "intern"]
    remoteOnly: true,
    minSalary: 0,
    locations: [],       // acceptable locations, empty = anywhere
    keywords: [],        // skill keywords for relevance
  },

  // Answers to common application questions (agent uses semantically)
  answers: {},           // free-form key -> value, agent matches by meaning

  // Sources the user is logged into (drives which scrapers run)
  loggedInSources: [],   // ["linkedin","indeed","glassdoor","x","gmail","wellfound"]

  // Email sending mode: "gmail_web" (via logged-in Chrome) or "smtp"
  emailMode: 'gmail_web',
  smtp: { user: '', pass: '', fromName: '' },

  // Safety caps
  limits: {
    maxEmailsPerRun: 25,
    maxAppliesPerRun: 15,
    maxAttemptsPerJob: 3,
    requestTimeoutMs: 30000,
    cooldownBetweenActionsMs: 4000,
  },

  _onboarded: false,
  _updatedAt: '',
};

function load() {
  if (!fs.existsSync(PROFILE_FILE)) return { ...DEFAULT_PROFILE };
  try {
    const saved = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    return {
      ...DEFAULT_PROFILE, ...saved,
      links: { ...DEFAULT_PROFILE.links, ...(saved.links || {}) },
      preferences: { ...DEFAULT_PROFILE.preferences, ...(saved.preferences || {}) },
      answers: { ...(saved.answers || {}) },
      limits: { ...DEFAULT_PROFILE.limits, ...(saved.limits || {}) },
    };
  } catch {
    return { ...DEFAULT_PROFILE };
  }
}

function persist(p) {
  p._updatedAt = new Date().toISOString();
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(p, null, 2), 'utf8');
  return p;
}

export function getProfile() {
  return load();
}

/** Deep patch. Pass nested objects to merge them. */
export function updateProfile(patch = {}) {
  const p = load();
  const merged = {
    ...p, ...patch,
    links:       { ...p.links,       ...(patch.links || {}) },
    preferences: { ...p.preferences, ...(patch.preferences || {}) },
    answers:     { ...p.answers,     ...(patch.answers || {}) },
    limits:      { ...p.limits,      ...(patch.limits || {}) },
    smtp:        { ...p.smtp,        ...(patch.smtp || {}) },
  };
  if (Array.isArray(patch.projects)) merged.projects = patch.projects;
  if (Array.isArray(patch.loggedInSources)) merged.loggedInSources = patch.loggedInSources;
  return persist(merged);
}

/** What's still missing before the agent can run well. */
export function profileGaps() {
  const p = load();
  const gaps = [];
  if (!p.name)                       gaps.push('name');
  if (!p.email)                      gaps.push('email');
  if (!p.cvPath)                     gaps.push('cvPath (path to your CV/resume PDF)');
  else if (!fs.existsSync(p.cvPath)) gaps.push(`cvPath points to a missing file: ${p.cvPath}`);
  if (!p.links.linkedin)             gaps.push('links.linkedin');
  if (!p.preferences.roles.length)   gaps.push('preferences.roles (what jobs to look for)');
  if (!p.loggedInSources.length)     gaps.push('loggedInSources (which sites you logged into in Chrome)');
  return gaps;
}

export function isOnboarded() {
  return profileGaps().length === 0;
}
