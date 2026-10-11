// src/mcp/answers.js — Answer engine for application questions (Easy Apply + external forms).
// Resolution order (first hit wins):
//   1. evolution memory (answers you / your agent taught, or harvested from prefilled forms)
//   2. profile.answers keyword overrides
//   3. rules derived from the profile (years, salary, links, identity, work auth…)
//   4. null → caller records it as a "question for you" (asked once, remembered forever)
// Everything personal comes from data/profile.json — nothing about the user is hardcoded.
import { getProfile } from '../profile.js';
import { learnedAnswer, usedAnswer } from '../evolve.js';

function ans(p, key, dflt = '') { const a = p.answers || {}; return a[key] != null && a[key] !== '' ? String(a[key]) : dflt; }
const FX = { usd: 1, eur: 0.92, gbp: 0.79, pkr: 280, inr: 84, aed: 3.67, cad: 1.37 };

/** Salary in the asked currency/period from profile.salary {amount, currency, period}. */
function salaryFor(q, p, numeric) {
  const s = p.salary || {};
  const base = +s.amount || +ans(p, 'salary pkr monthly', 0) || 0;
  const baseCur = (s.currency || (ans(p, 'salary pkr monthly') ? 'pkr' : 'usd')).toLowerCase();
  const basePeriod = s.period || 'month';
  if (!base) return ans(p, 'salary', null) || (numeric ? null : 'Negotiable');
  const cur = Object.keys(FX).find(c => q.includes(c)) || (/\$|dollar/.test(q) ? 'usd' : /€/.test(q) ? 'eur' : /£/.test(q) ? 'gbp' : /rupee|\brs\b/.test(q) ? (baseCur === 'inr' ? 'inr' : 'pkr') : baseCur);
  const period = /annual|yearly|per year|per annum|\/yr|\blpa\b|\bctc\b/.test(q) ? 'year' : /hour|hourly|\/hr/.test(q) ? 'hour' : 'month';
  let monthly = basePeriod === 'year' ? base / 12 : basePeriod === 'hour' ? base * 160 : base;
  monthly = monthly / FX[baseCur] * FX[cur];
  const v = period === 'year' ? monthly * 12 : period === 'hour' ? monthly / 160 : monthly;
  const r = cur === 'pkr' || cur === 'inr' ? Math.round(v / 1000) * 1000 : period === 'hour' ? Math.round(v) : Math.round(v / 100) * 100;
  return numeric || /number|numeric|only digits/.test(q) ? String(r) : String(r);
}

/** Return the answer string for a free-text / numeric question, or null if unknown. */
export function textAnswer(question, { numeric = false } = {}) {
  const p = getProfile();
  const q = (question || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!q) return null;
  const L = p.links || {};
  const [first, ...rest] = (p.name || '').split(' ');

  const learned = learnedAnswer(question);
  if (learned != null && !(numeric && isNaN(parseFloat(learned)))) { usedAnswer(question); return learned; }

  for (const [key, val] of Object.entries(p.answers || {})) {
    const words = key.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length >= 2 && words.every(w => q.includes(w)) && !/^(cover hook|hook)$/.test(key)) return String(val);
  }

  const years = ans(p, 'years of experience', p.yearsExperience ? String(p.yearsExperience) : '');
  if (/how many years|years of (work |professional )?experience|years experience|experience (do you have|in years)/.test(q)) return years || null;
  if (/salary|compensation|expected pay|pay expectation|\bctc\b|remuneration|\brate\b|expectation/.test(q)) return salaryFor(q, p, numeric);
  if (/first name|given name/.test(q)) return p.firstName || first || null;
  if (/last name|surname|family name/.test(q)) return p.lastName || rest.join(' ') || null;
  if (/full name|^name\b|your name|legal name/.test(q)) return p.name || null;
  if (/e-?mail/.test(q)) return p.email || null;
  if (/phone|mobile|contact number|whatsapp/.test(q)) return numeric ? (p.phone || '').replace(/\D/g, '') : (p.phone || null);
  if (/linkedin/.test(q)) return L.linkedin || null;
  if (/github/.test(q)) return L.github || null;
  if (/portfolio|personal site|website|\burl\b/.test(q)) return L.portfolio || L.website || L.github || null;
  if (/\bcity\b|location|where.*(based|located)|address|country of residence/.test(q)) return p.location || null;
  if (/country/.test(q)) return p.country || (p.location || '').split(',').pop().trim() || null;
  if (/notice period|how soon|start date|when can you start|availability to start/.test(q)) return numeric ? String(parseInt(ans(p, 'notice period', '14')) || 14) : ans(p, 'notice period', '2 weeks');
  if (/hours.*(week|per)/.test(q)) return '40';
  if (/headline|current (title|role|position)|job title/.test(q)) return p.headline || p.currentTitle || null;
  if (/current (company|employer)|employer/.test(q)) return p.currentCompany || null;
  if (/cover letter|why .*(apply|interested|join|us)|motivation|tell us|about yourself|summary|additional information|anything else/.test(q)) return coverText(p);
  if (numeric && /how many|number of|years/.test(q)) return years || null;
  return null;
}

/** Choose among options (radio/select). Returns the option text to pick, or null if genuinely unknown. */
export function choiceAnswer(question, options) {
  const p = getProfile();
  const q = (question || '').toLowerCase();
  const opts = options.map(o => (o || '').trim()).filter(o => o && !/^select/i.test(o));
  if (!opts.length) return null;
  const find = re => opts.find(o => re.test(o.toLowerCase()));

  const learned = learnedAnswer(question);
  if (learned) { const m = opts.find(o => o.toLowerCase() === learned.toLowerCase()) || opts.find(o => o.toLowerCase().startsWith(learned.toLowerCase())); if (m) { usedAnswer(question); return m; } }

  const yes = find(/^yes\b/), no = find(/^no\b/);
  const wa = (p.workAuth || {});  // { needsSponsorship:bool, authorizedIn:["Pakistan"], willingToRelocate:bool }
  const authIn = (wa.authorizedIn || [(p.location || '').split(',').pop().trim()]).map(s => s.toLowerCase()).filter(Boolean);
  if (yes && no) {
    if (/sponsor|visa/.test(q)) return wa.needsSponsorship ? yes : no;
    if (/relocat/.test(q)) return wa.willingToRelocate ? yes : no;
    if (/legally|authori[sz]ed|right to work|eligible to work|work permit/.test(q))
      return authIn.some(c => q.includes(c)) || /remote|anywhere/.test(q) && !/(us|united states|uk|eu|canada)\b/.test(q) ? yes : no;
    if (/convicted|criminal|felony|non-?compete|related to anyone|previously (worked|employed)|currently employed by|been employed by/.test(q)) return no;
    if (/background check|drug test|agree|consent|acknowledge|comfortable|willing|able to|can you|do you have|have you|did you|are you|familiar|experience|worked (with|on|in)|built|shipped|proficient/.test(q)) return yes;
    return null; // unknown yes/no → ask the user once instead of guessing
  }
  if (/years/.test(q)) {
    const y = parseFloat(textAnswer('years of experience') || '0');
    const fit = opts.find(o => { const m = o.match(/(\d+)\s*[-–to]+\s*(\d+)/); return m && y >= +m[1] && y <= +m[2]; }) || opts.find(o => { const m = o.match(/(\d+)\s*\+/); return m && y >= +m[1]; });
    return fit || opts[opts.length - 1];
  }
  if (/english|proficien/.test(q)) return find(/native|bilingual|fluent|professional/) || opts[opts.length - 1];
  if (/gender|race|ethnic|veteran|disab|pronoun|sexual/.test(q)) return find(/decline|prefer not|don.?t wish|not to|rather not/) || null;
  if (/country|code/.test(q)) { const c = (p.country || (p.location || '').split(',').pop() || '').trim().toLowerCase(); return c ? opts.find(o => o.toLowerCase().includes(c)) || null : null; }
  if (/remote|work (type|arrangement)|workplace/.test(q)) return find(/remote/) || null;
  if (/hear about|source|how did you find/.test(q)) return find(/linkedin/) || find(/job board|online|other/) || opts[0];
  if (/notice/.test(q)) return find(/2 weeks|two weeks|immediate|less than|1 month/) || opts[0];
  if (/degree|education|qualification/.test(q)) return find(new RegExp((p.education || "bachelor").split(' ')[0], 'i')) || find(/bachelor/) || null;
  return null;
}

export function coverText(p = getProfile()) {
  const hook = (p.answers || {})['cover hook'] || p.summary || 'I build and ship production software end to end.';
  const proj = (p.projects || []).slice(0, 3).map(x => `${x.name} (${x.blurb})`).join('; ');
  const yrs = textAnswer('years of experience');
  const skills = (p.skills || []).slice(0, 6).join(', ');
  return [hook, proj && `Recent work: ${proj}.`, (yrs || skills) && `${yrs ? yrs + '+ years' : 'Experience'}${skills ? ' across ' + skills : ''}.`,
    p.links?.portfolio && `Portfolio: ${p.links.portfolio}`, p.links?.github && `GitHub: ${p.links.github}`].filter(Boolean).join(' ').slice(0, 1400);
}
