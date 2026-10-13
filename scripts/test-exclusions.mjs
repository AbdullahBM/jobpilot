import { excludedCompanyMatch, isExcludedCompany } from '../src/profile.js';

const profile = {
  currentCompany: 'Smart Working Solutions',
  preferences: { avoidCompanies: ['Acme Cloud'] },
};
let fail = 0;
const check = (name, value) => { console.log((value ? 'PASS' : 'FAIL') + ' - ' + name); if (!value) fail++; };

check('current employer is excluded', isExcludedCompany('Smart Working Solutions — DevOps Engineer', profile));
check('current employer match is returned', excludedCompanyMatch('Smart Working Solutions — Platform Engineer', profile) === 'Smart Working Solutions');
check('explicit company is excluded', isExcludedCompany('Acme Cloud — SRE', profile));
check('unrelated company remains eligible', !isExcludedCompany('Globex — Cloud Infrastructure Engineer', profile));

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
