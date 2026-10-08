// @ts-expect-error TS5097: standalone Node contracts.
import { AccountFailure as ApiFailure } from '../../domain/account-study/index.ts';
import type { AccountStudyDependencies, Authenticated } from './ports';
// @ts-expect-error TS5097: standalone Node contracts.
import { createAccountContext } from './context.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { readAccountAction } from './read.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { executeAccessAction } from './access-actions.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { executeAssistanceAction } from './assistance-actions.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { executePlanningAction } from './planning-actions.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { executeAiAction } from './ai-actions.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { executeRecordAction } from './record-actions.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { executeAttemptAction } from './attempt-actions.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {executeCourseAction} from '../course-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {executePracticeEvidenceAction} from '../practice-evidence/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {executeMathStudyAction,executeMathMappingAction} from '../math-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {executeCodeHintAction} from '../code-study/index.ts';
export function createAccountStudyApplication(deps: AccountStudyDependencies) {
    const context = createAccountContext(deps);
    return { get: (params: Record<string, string>, auth: Authenticated) => readAccountAction(params, auth, context),
        async post(body: Record<string, unknown>, auth: Authenticated, signal: AbortSignal) {
            context.expectedAccount(auth.principal, body.expectedUserId);
            delete body.expectedUserId;
            if (typeof body.action !== 'string')
                throw new ApiFailure(400, 'action-required');
            return await executeMathMappingAction(body,auth,context) ?? await executeMathStudyAction(body,auth,context,signal) ?? await executeCodeHintAction(body,auth,context,signal) ?? await executePracticeEvidenceAction(body,auth,context) ?? await executeCourseAction(body,auth,context,signal) ?? await executeAttemptAction(body, auth, context) ?? await executeAccessAction(body, auth, context) ?? await executeAssistanceAction(body, auth, context) ??
                await executePlanningAction(body, auth, context) ?? await executeAiAction(body, auth, context, signal) ?? await executeRecordAction(body, auth, context);
        } };
}
