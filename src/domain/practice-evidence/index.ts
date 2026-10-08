export type * from './model';
// @ts-expect-error TS5097: standalone Node contracts.
export { parsePracticeEvidenceDiagnostic, parsePracticeEvidenceHint, parsePracticeEvidence, parsePracticeEvidenceMutation, parsePracticeVariantRecovery, PRACTICE_EVIDENCE_LIMITS, validatePracticeEvidenceTree } from './parse.ts';
// @ts-expect-error TS5097: standalone Node contracts.
export { practiceEvidenceFingerprint, evidenceEqual, validatePracticeEvidenceAuthority } from './authority.ts';
// @ts-expect-error TS5097: standalone Node contracts.
export { applyPracticeEvidenceMutation } from './transition.ts';
