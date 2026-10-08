/** Compatibility entrypoint; shared pure policy lives in the assessment domain. */
// @ts-expect-error TS5097: standalone Node contracts.
export {parseRecallPolicy,type RecallPolicyEvidence} from '../src/domain/assessment/index.ts';
