import type { AttemptSubmission, FormalResolution, LearningAttempt } from './model';
// @ts-expect-error TS5097: standalone Node contracts.
import { attemptId, parseAttemptBinding, parseAttemptEvaluation, parseAttemptMutation } from './parse.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { capRecallRating } from '../content/index.ts';

function closed(raw: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw Error('invalid-attempt-aggregate-object');
    const row = raw as Record<string, unknown>;
    if (required.some(key => !Object.hasOwn(row, key))
        || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) throw Error('invalid-attempt-aggregate-fields');
    return row;
}
function count(raw: unknown): number {
    if (!Number.isSafeInteger(raw) || Number(raw) < 0) throw Error('invalid-attempt-aggregate-revision');
    return raw as number;
}
function date(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length > 64 || !Number.isFinite(Date.parse(raw))) throw Error('invalid-attempt-aggregate-date');
    return raw;
}
function digest(raw: unknown): string {
    if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) throw Error('invalid-attempt-aggregate-hash');
    return raw;
}
function text(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length > 32000) throw Error('invalid-attempt-aggregate-answer');
    return raw;
}

/** Structural consistency only. Hash seals, source admission and durable formal receipts require external verification. */
export function parseLearningAttempt(raw: unknown): LearningAttempt {
    const row = closed(raw, ['schemaVersion', 'attemptId', 'binding', 'parentAttemptId', 'revision', 'answerRevision', 'answer',
        'updatedAt', 'checkpoint', 'submitted', 'evaluation', 'formal', 'operations'], ['startedAt']);
    if (row.schemaVersion !== 1) throw Error('unsupported-attempt-version');
    const id = attemptId(row.attemptId), binding = parseAttemptBinding(row.binding), revision = count(row.revision);
    const answerRevision = count(row.answerRevision), answer = text(row.answer), updatedAt = date(row.updatedAt);
    const parentAttemptId = row.parentAttemptId === null ? null : attemptId(row.parentAttemptId);
    if (parentAttemptId === id) throw Error('attempt-parent-cycle');
    if (answerRevision > revision) throw Error('attempt-answer-revision-conflict');
    const base = { schemaVersion: 1, attemptId: id, binding, operationId: 'aggregate-validation', expectedRevision: revision, updatedAt };
    const projected = parseAttemptMutation({ ...base, kind: 'checkpoint', parentAttemptId, answer, checkpoint: row.checkpoint });
    if (projected.kind !== 'checkpoint') throw Error('invalid-attempt-checkpoint');
    const checkpoint = projected.checkpoint;
    if (!Array.isArray(row.operations) || row.operations.length < 1 || row.operations.length > 2000 || row.operations.length !== revision)
        throw Error('invalid-attempt-operation-history');
    const operationIds = new Set<string>();
    const operations = row.operations.map((raw, index) => {
        const op = closed(raw, ['operationId', 'fingerprint', 'revision']), operationId = attemptId(op.operationId);
        if (operationIds.has(operationId) || count(op.revision) !== index + 1) throw Error('invalid-attempt-operation-history');
        operationIds.add(operationId);
        return { operationId, fingerprint: digest(op.fingerprint), revision: index + 1 };
    });
    let submitted: AttemptSubmission | null = null;
    if (row.submitted !== null) {
        const value = closed(row.submitted, ['answer', 'answerRevision', 'submittedAt', 'assistance'], ['maxPreHintLevel', 'answerRevealed']);
        const submission = parseAttemptMutation({ ...base, kind: 'submit', answerRevision: value.answerRevision, assistance: value.assistance,
            ...(value.maxPreHintLevel === undefined ? {} : { maxPreHintLevel: value.maxPreHintLevel }),
            ...(value.answerRevealed === undefined ? {} : { answerRevealed: value.answerRevealed }) });
        if (submission.kind !== 'submit' || text(value.answer) !== answer || submission.answerRevision !== answerRevision)
            throw Error('attempt-submission-binding');
        const assisted = checkpoint.purpose === 'guided' || (submission.maxPreHintLevel ?? 0) > 0 || submission.answerRevealed === true;
        if (assisted && submission.assistance !== 'observed') throw Error('attempt-submission-assistance-conflict');
        submitted = { answer, answerRevision, submittedAt: date(value.submittedAt), assistance: submission.assistance,
            ...(submission.maxPreHintLevel === undefined ? {} : { maxPreHintLevel: submission.maxPreHintLevel }),
            ...(submission.answerRevealed === undefined ? {} : { answerRevealed: submission.answerRevealed }) };
    }
    const evaluation = parseAttemptEvaluation(row.evaluation);
    if (evaluation.status === 'resolved' && (!submitted || evaluation.referenceHash !== binding.contentHash))
        throw Error('attempt-evaluation-source-binding');
    let formal: FormalResolution | null = null;
    if (row.formal !== null) {
        const value = closed(row.formal, ['eventId', 'occurredAt', 'evaluationHash', 'rating', 'status', 'coreHash', 'authoritativeRecord']);
        const claim = parseAttemptMutation({ ...base, kind: 'claim-formal', eventId: value.eventId, occurredAt: value.occurredAt,
            evaluationHash: value.evaluationHash, rating: value.rating });
        if (claim.kind !== 'claim-formal' || !submitted || evaluation.status !== 'resolved' || claim.evaluationHash !== evaluation.evaluationHash
            || parentAttemptId || checkpoint.purpose === 'guided' || checkpoint.purpose === 'remediation') throw Error('attempt-formal-evaluation-binding');
        const rank = { again: 0, hard: 1, good: 2, easy: 3 };
        if (rank[claim.rating] > rank[evaluation.rating] || submitted.assistance === 'independent' && claim.rating !== evaluation.rating)
            throw Error('attempt-formal-rating-increase');
        const hint = submitted.answerRevealed === true ? 3 : submitted.maxPreHintLevel;
        if (checkpoint.mode === 'recall' && hint !== undefined && capRecallRating(claim.rating, hint) !== claim.rating)
            throw Error('attempt-formal-hint-cap');
        if (value.status !== 'claimed' && value.status !== 'linked') throw Error('invalid-attempt-formal-status');
        const coreHash = value.coreHash === null ? null : digest(value.coreHash);
        if (value.status === 'linked' ? coreHash === null : coreHash !== null || value.authoritativeRecord !== null)
            throw Error('attempt-formal-core-binding');
        let authoritativeRecord: FormalResolution['authoritativeRecord'] = null;
        if (value.authoritativeRecord !== null) {
            const record = closed(value.authoritativeRecord, ['attemptId', 'roundId']);
            authoritativeRecord = { attemptId: attemptId(record.attemptId), roundId: attemptId(record.roundId) };
        }
        formal = { eventId: claim.eventId, occurredAt: claim.occurredAt, evaluationHash: claim.evaluationHash, rating: claim.rating,
            status: value.status, coreHash, authoritativeRecord };
    }
    return structuredClone({ schemaVersion: 1, attemptId: id, binding, parentAttemptId, revision, answerRevision, answer,
        updatedAt, ...(row.startedAt === undefined ? {} : { startedAt: date(row.startedAt) }), checkpoint, submitted, evaluation, formal, operations });
}
