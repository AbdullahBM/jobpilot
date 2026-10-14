// Lightweight regression checks for CV-grounded scoring and the approval gate.
import assert from 'node:assert/strict';
import { assessJob, ensureTailoredCv } from '../src/cv.js';

const profile = {
  skills: ['AWS', 'Terraform'],
  summary: 'Cloud infrastructure operations',
  preferences: { roles: ['Cloud Engineer'], allowTailoredCv: false },
};

const aligned = assessJob({ role: 'Cloud Engineer', description: 'AWS Terraform Kubernetes' }, profile);
assert.equal(aligned.roleAligned, true);
assert.equal(aligned.driftPercent, 13);
assert.deepEqual(aligned.missingTerms, ['kubernetes']);
assert.equal(aligned.tailoredEligible, true);

const outside = assessJob({ role: 'Frontend Developer', description: 'React TypeScript' }, profile);
assert.equal(outside.roleAligned, false);
assert.equal(outside.tailoredEligible, false);
assert.equal(assessJob({ role: 'AI Platform Engineer', description: 'Kubernetes' }, profile).roleAligned, false);
const hashtagRole = assessJob({
  role: '#DevOps #SeniorDevOpsEngineer',
  description: 'Lead DevOps Engineer — AWS, Kubernetes, Terraform, CI/CD',
}, { ...profile, preferences: { roles: ['DevOps Engineer'] } });
assert.equal(hashtagRole.roleAligned, true);

const gated = ensureTailoredCv({ role: 'Cloud Engineer', description: 'AWS Terraform Kubernetes' }, profile);
assert.equal(gated.generated, false);
assert.equal(gated.path, '');

console.log('cv feature checks passed');
