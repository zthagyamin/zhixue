import type { AttemptBinding, AttemptCheckpoint, AttemptEvaluation, AttemptMutation } from './model';
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('invalid-attempt-object');
    const row = value as Record<string, unknown>;
    if (required.some(key => !(key in row)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key)))
        throw new Error('invalid-attempt-fields');
    return row;
}
export function attemptId(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 128 || Array.from(value).some(char => char.charCodeAt(0) < 32))
        throw new Error('invalid-attempt-id');
    return value;
}
function count(value: unknown): number {
    if (!Number.isSafeInteger(value) || Number(value) < 0)
        throw new Error('invalid-attempt-revision');
    return value as number;
}
function digest(value: unknown): string {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
        throw new Error('invalid-attempt-hash');
    return value;
}
function date(value: unknown): string {
    if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))
        throw new Error('invalid-attempt-date');
    return value;
}
function answer(value: unknown): string {
    if (typeof value !== 'string' || value.length > 32000)
        throw new Error('invalid-attempt-answer');
    return value;
}
export function parseAttemptBinding(value: unknown): AttemptBinding {
    const row = object(value, ['ownerId', 'libraryId', 'snapshotId', 'itemKey', 'contentHash', 'groupId', 'roundId']);
    return { ownerId: attemptId(row.ownerId), libraryId: attemptId(row.libraryId), snapshotId: attemptId(row.snapshotId), itemKey: attemptId(row.itemKey), contentHash: digest(row.contentHash), groupId: attemptId(row.groupId), roundId: attemptId(row.roundId) };
}
function checkpoint(value: unknown): AttemptCheckpoint {
    const row = object(value, ['phase', 'position', 'traversed'], ['mode', 'intent', 'purpose', 'pluginFields', 'visited', 'pending', 'skipped', 'activeSeconds', 'startActiveSeconds', 'targetMinutes', 'view']);
    if (!['answering', 'submitted', 'feedback', 'lesson'].includes(String(row.phase)) || typeof row.traversed !== 'boolean')
        throw new Error('invalid-attempt-checkpoint');
    const result: AttemptCheckpoint = { phase: row.phase as AttemptCheckpoint['phase'], position: count(row.position), traversed: row.traversed };
    if (row.view !== undefined) {
        const view = object(row.view, ['purpose', 'lessonStep', 'paused', 'referenceSeen'], ['instanceId']);
        if (!['first', 'guided', 'remediation'].includes(String(view.purpose)) || !['reading', 'guided', 'independent'].includes(String(view.lessonStep)) || typeof view.paused !== 'boolean' || typeof view.referenceSeen !== 'boolean')
            throw Error('invalid-attempt-view');
        result.view = { purpose: view.purpose as 'first', lessonStep: view.lessonStep as 'reading', paused: view.paused, referenceSeen: view.referenceSeen, ...(view.instanceId === undefined ? {} : { instanceId: attemptId(view.instanceId) }) };
    }
    if (row.view !== undefined) {
        const view = object(row.view, ['purpose', 'lessonStep', 'paused', 'referenceSeen'], ['instanceId']);
        if (!['first', 'guided', 'remediation'].includes(String(view.purpose)) || !['reading', 'guided', 'independent'].includes(String(view.lessonStep)) || typeof view.paused !== 'boolean' || typeof view.referenceSeen !== 'boolean')
            throw Error('invalid-attempt-view');
        result.view = { purpose: view.purpose as 'first', lessonStep: view.lessonStep as 'reading', paused: view.paused, referenceSeen: view.referenceSeen, ...(view.instanceId === undefined ? {} : { instanceId: attemptId(view.instanceId) }) };
    }
    for (const key of ['activeSeconds', 'startActiveSeconds', 'targetMinutes'] as const) {
        if (row[key] !== undefined) {
            const number = count(row[key]);
            if (number > (key === 'targetMinutes' ? 180 : 86400))
                throw Error('invalid-attempt-time');
            result[key] = number;
        }
    }
    if (result.startActiveSeconds !== undefined && result.activeSeconds !== undefined && result.startActiveSeconds > result.activeSeconds)
        throw Error('invalid-attempt-time-order');
    if (row.mode !== undefined) {
        if (!['quiz', 'recall', 'code', 'lesson', 'paper', 'calculation', 'flashcard'].includes(String(row.mode)))
            throw new Error('invalid-attempt-mode');
        result.mode = row.mode as 'quiz';
    }
    if (row.purpose !== undefined) {
        if (!['first', 'guided', 'remediation'].includes(String(row.purpose)))
            throw new Error('invalid-attempt-purpose');
        result.purpose = row.purpose as 'first';
    }
    if (row.intent !== undefined) {
        if (!['practice', 'lesson'].includes(String(row.intent)))
            throw new Error('invalid-attempt-intent');
        result.intent = row.intent as 'practice';
    }
    if (row.pluginFields !== undefined) {
        const allowed = { quiz: ['answer', 'choice', 'selection', 'phase'], recall: ['answer', 'revealed', 'phase', 'hintLevel', 'policyAttemptId'], code: ['answer', 'code', 'stdin', 'phase', 'firstRunKind', 'firstNeedsReview'], lesson: ['notes', 'phase'], paper: ['answer', 'notes', 'phase'], calculation: ['value', 'phase'], flashcard: ['isFlipped', 'phase', 'flashcardRating'] };
        if (!result.mode)
            throw new Error('attempt-mode-required');
        const fields = object(row.pluginFields, [], allowed[result.mode]);
        if (Object.values(fields).some(value => typeof value !== 'string' || value.length > 32000) || JSON.stringify(fields).length > 64000)
            throw new Error('invalid-attempt-plugin-fields');
        if (result.mode === 'recall') {
            if (fields.hintLevel !== undefined && !/^[0-3]$/.test(String(fields.hintLevel)))
                throw Error('invalid-attempt-hint-level');
            if (fields.policyAttemptId !== undefined)
                attemptId(fields.policyAttemptId);
        }
        result.pluginFields = fields as Record<string, string>;
    }
    for (const key of ['visited', 'pending', 'skipped'] as const) {
        if (row[key] === undefined)
            continue;
        if (!Array.isArray(row[key]) || row[key].length > 500)
            throw new Error('invalid-attempt-round-keys');
        result[key] = row[key].map(attemptId);
        if (new Set(result[key]).size !== result[key].length)
            throw new Error('duplicate-attempt-round-key');
    }
    return result;
}
export function parseAttemptEvaluation(value: unknown): AttemptEvaluation {
    const raw = value as Record<string, unknown>;
    if (raw?.status === 'pending') {
        const row = object(value, ['status', 'reason'], ['feedback']);
        if (!['offline', 'invalid', 'no-reference', 'not-requested'].includes(String(row.reason)))
            throw new Error('invalid-attempt-pending');
        return { status: 'pending', reason: row.reason as 'offline', ...(row.feedback === undefined ? {} : { feedback: answer(row.feedback) }) };
    }
    const row = object(value, ['status', 'rating', 'correct', 'outcome', 'source', 'feedback', 'evaluationHash', 'referenceHash']);
    if (row.status !== 'resolved' || !['again', 'hard', 'good', 'easy'].includes(String(row.rating)) || typeof row.correct !== 'boolean')
        throw new Error('invalid-attempt-evaluation');
    if (!['correct', 'partial', 'incorrect'].includes(String(row.outcome)) || !['deterministic', 'model', 'self-assess'].includes(String(row.source)) || row.correct !== (row.outcome === 'correct') || (row.outcome === 'incorrect' && ['good', 'easy'].includes(String(row.rating))) || (row.outcome === 'partial' && ['good', 'easy'].includes(String(row.rating))))
        throw new Error('inconsistent-attempt-evaluation');
    if (row.source === 'model' && row.rating !== { correct: 'good', partial: 'hard', incorrect: 'again' }[row.outcome as 'correct'])
        throw new Error('inconsistent-attempt-model-evaluation');
    return { status: 'resolved', rating: row.rating as 'again', correct: row.correct, outcome: row.outcome as 'correct', source: row.source as 'model', feedback: answer(row.feedback), evaluationHash: digest(row.evaluationHash), referenceHash: digest(row.referenceHash) };
}
export function parseAttemptMutation(value: unknown): AttemptMutation {
    const raw = value as Record<string, unknown>, baseKeys = ['schemaVersion', 'operationId', 'attemptId', 'binding', 'expectedRevision', 'updatedAt', 'kind'];
    const extra: Record<string, string[]> = { checkpoint: ['answer', 'checkpoint', 'parentAttemptId'], submit: ['answerRevision', 'assistance'], evaluate: ['answerRevision', 'evaluation'], 'claim-formal': ['eventId', 'occurredAt', 'evaluationHash', 'rating'], 'link-formal': ['eventId', 'coreHash'] };
    if (!extra[String(raw?.kind)])
        throw new Error('invalid-attempt-kind');
    const row = object(value, [...baseKeys, ...extra[String(raw.kind)]], raw.kind === 'submit' ? ['maxPreHintLevel', 'answerRevealed'] : []);
    if (row.schemaVersion !== 1)
        throw new Error('unsupported-attempt-version');
    const base = { schemaVersion: 1 as const, operationId: attemptId(row.operationId), attemptId: attemptId(row.attemptId), binding: parseAttemptBinding(row.binding), expectedRevision: count(row.expectedRevision), updatedAt: date(row.updatedAt) };
    if (row.kind === 'checkpoint')
        return { ...base, kind: 'checkpoint', answer: answer(row.answer), checkpoint: checkpoint(row.checkpoint), parentAttemptId: row.parentAttemptId === null ? null : attemptId(row.parentAttemptId) };
    if (row.kind === 'submit') {
        if (!['independent', 'observed', 'unknown'].includes(String(row.assistance)))
            throw new Error('invalid-attempt-assistance');
        if (row.maxPreHintLevel !== undefined && (!Number.isInteger(row.maxPreHintLevel) || Number(row.maxPreHintLevel) < 0 || Number(row.maxPreHintLevel) > 3))
            throw new Error('invalid-attempt-hint-level');
        if (row.answerRevealed !== undefined && typeof row.answerRevealed !== 'boolean')
            throw new Error('invalid-attempt-answer-revealed');
        return { ...base, kind: 'submit', answerRevision: count(row.answerRevision), assistance: row.assistance as 'unknown',
            ...(row.maxPreHintLevel === undefined ? {} : { maxPreHintLevel: row.maxPreHintLevel as 0 | 1 | 2 | 3 }),
            ...(row.answerRevealed === undefined ? {} : { answerRevealed: row.answerRevealed as boolean }) };
    }
    if (row.kind === 'evaluate')
        return { ...base, kind: 'evaluate', answerRevision: count(row.answerRevision), evaluation: parseAttemptEvaluation(row.evaluation) };
    if (row.kind === 'claim-formal') {
        if (!['again', 'hard', 'good', 'easy'].includes(String(row.rating)))
            throw new Error('invalid-attempt-rating');
        return { ...base, kind: 'claim-formal', eventId: attemptId(row.eventId), occurredAt: date(row.occurredAt), evaluationHash: digest(row.evaluationHash), rating: row.rating as 'again' };
    }
    return { ...base, kind: 'link-formal', eventId: attemptId(row.eventId), coreHash: digest(row.coreHash) };
}
