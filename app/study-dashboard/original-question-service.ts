import type { LearningAttempt } from '../../src/domain/learning-attempt';
import { attemptFingerprint } from '../../src/infrastructure/learning-attempt';
import { updateWorkspaceRecord } from '../local-study-db';
type Result = {
    snapshotId: string;
    itemKey: string;
    contentHash: string;
    attemptId: string;
    text: string;
    verdict?: string;
    rating?: string;
    matchedPointIds?: string[];
    missedPointIds?: string[];
};
/** Reuse the original authenticated request journal and its immutable source identity. */
export function originalQuestionService(workspaceId: string, attempt: LearningAttempt, questionAi: (request: {
    requestId: string;
    request: unknown;
}) => Promise<Record<string, unknown>>) {
    return async (kind: 'hint' | 'tutor' | 'recall-grade', input: string) => {
        const b = attempt.binding, key = JSON.stringify([kind, b.snapshotId, b.itemKey, b.contentHash, input]);
        let requestId = '';
        await updateWorkspaceRecord<Record<string, string>>(workspaceId, 'account-question-ai-requests', {}, current => { requestId = current[key] ?? crypto.randomUUID(); return { ...current, [key]: requestId }; });
        const attemptId = `attempt:${await attemptFingerprint(JSON.parse(key))}`;
        const reply = await questionAi({ requestId, request: { kind, snapshotId: b.snapshotId, itemKey: b.itemKey, contentHash: b.contentHash, attemptId, input } }), result = reply.result as Result | undefined;
        if (!result || result.snapshotId !== b.snapshotId || result.itemKey !== b.itemKey || result.contentHash !== b.contentHash || result.attemptId !== attemptId || typeof result.text !== 'string')
            throw Error('原题核对回复与保存的版本不一致，原答案继续保留。');
        await updateWorkspaceRecord<Record<string, string>>(workspaceId, 'account-question-ai-requests', {}, current => {
            if (current[key] !== requestId)
                return current;
            const next = { ...current };
            delete next[key];
            return next;
        });
        return result;
    };
}
