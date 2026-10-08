import type { AttemptMutation, AttemptReceipt, LearningAttempt } from './model';
// @ts-expect-error TS5097: standalone Node contracts.
import { canonicalAttemptJson } from './model.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { capRecallRating } from '../content/index.ts';
export function applyAttemptMutation(current: LearningAttempt | null, mutation: AttemptMutation, fingerprint = canonicalAttemptJson(mutation)): AttemptReceipt {
    const known = current?.operations.find(row => row.operationId === mutation.operationId);
    const receipt = (status: AttemptReceipt['status'], attempt = current): AttemptReceipt => ({ status, durable: false, operationId: mutation.operationId, revision: attempt?.revision ?? 0, attempt });
    if (known)
        return receipt(known.fingerprint === fingerprint ? 'duplicate' : 'conflict');
    if ((current?.revision ?? 0) !== mutation.expectedRevision)
        return receipt('conflict');
    if (current && (current.attemptId !== mutation.attemptId || canonicalAttemptJson(current.binding) !== canonicalAttemptJson(mutation.binding)))
        throw new Error('attempt-binding-conflict');
    if (!current && mutation.kind !== 'checkpoint')
        throw new Error('attempt-not-found');
    if ((current?.operations.length ?? 0) >= 2000)
        throw new Error('attempt-revision-limit');
    const next: LearningAttempt = current ? structuredClone(current) : { schemaVersion: 1, attemptId: mutation.attemptId, binding: mutation.binding, parentAttemptId: null, revision: 0, answerRevision: 0, answer: '', updatedAt: mutation.updatedAt,startedAt:mutation.updatedAt, checkpoint: { phase: 'answering', position: 0, traversed: false }, submitted: null, evaluation: { status: 'pending', reason: 'not-requested' }, formal: null, operations: [] };
    if (mutation.kind === 'checkpoint') {
        if (current && next.parentAttemptId !== mutation.parentAttemptId)
            throw new Error('attempt-parent-conflict');
        if (mutation.parentAttemptId === mutation.attemptId)
            throw new Error('attempt-parent-cycle');
        if (next.submitted && next.answer !== mutation.answer)
            throw new Error('submitted-answer-immutable');
        if (next.submitted && ['mode', 'intent', 'purpose'].some(key => canonicalAttemptJson(next.checkpoint[key as 'mode']) !== canonicalAttemptJson(mutation.checkpoint[key as 'mode'])))
            throw new Error('attempt-submitted-mode-immutable');
        if (next.answer !== mutation.answer)
            next.answerRevision++;
        next.answer = mutation.answer;
        next.checkpoint = mutation.checkpoint;
        next.parentAttemptId = mutation.parentAttemptId;
    }
    else if (mutation.kind === 'submit') {
        if (next.submitted)
            throw new Error('attempt-already-submitted');
        if (next.answerRevision !== mutation.answerRevision)
            throw new Error('attempt-answer-revision-conflict');
        const assisted = next.checkpoint.purpose === 'guided' || (mutation.maxPreHintLevel ?? 0) > 0 || mutation.answerRevealed === true;
        next.submitted = { answer: next.answer, answerRevision: next.answerRevision, submittedAt: mutation.updatedAt, assistance: assisted ? 'observed' : mutation.assistance,
            ...(mutation.maxPreHintLevel === undefined ? {} : { maxPreHintLevel: mutation.maxPreHintLevel }),
            ...(mutation.answerRevealed === undefined ? {} : { answerRevealed: mutation.answerRevealed }) };
        next.checkpoint.phase = 'submitted';
    }
    else if (mutation.kind === 'evaluate') {
        if (!next.submitted || next.submitted.answerRevision !== mutation.answerRevision)
            throw new Error('attempt-submission-binding');
        if (next.evaluation.status === 'resolved')
            throw new Error('attempt-evaluation-finalized');
        if (mutation.evaluation.status === 'resolved' && mutation.evaluation.referenceHash !== next.binding.contentHash)
            throw new Error('attempt-reference-conflict');
        next.evaluation = mutation.evaluation;
        next.checkpoint.phase = 'feedback';
    }
    else if (mutation.kind === 'claim-formal') {
        if (next.parentAttemptId || next.checkpoint.purpose === 'remediation' || next.checkpoint.purpose === 'guided')
            throw new Error('attempt-remediation-not-formal');
        if (next.evaluation.status !== 'resolved' || next.evaluation.evaluationHash !== mutation.evaluationHash)
            throw new Error('attempt-evaluation-pending');
        const rank = { again: 0, hard: 1, good: 2, easy: 3 };
        if (rank[mutation.rating] > rank[next.evaluation.rating] || (mutation.rating !== next.evaluation.rating && next.submitted?.assistance === 'independent'))
            throw new Error('attempt-formal-rating-increase');
        if (next.checkpoint.mode === 'recall' && next.submitted) {
            const level = next.submitted.answerRevealed === true ? 3 : next.submitted.maxPreHintLevel;
            if (level !== undefined && capRecallRating(mutation.rating, level) !== mutation.rating)
                throw new Error('attempt-formal-hint-cap');
        }
        if (next.formal)
            throw new Error('attempt-formal-already-claimed');
        next.formal = { eventId: mutation.eventId, occurredAt: mutation.occurredAt, evaluationHash: mutation.evaluationHash, rating: mutation.rating, status: 'claimed', coreHash: null, authoritativeRecord: null };
    }
    else {
        if (!next.formal || next.formal.eventId !== mutation.eventId)
            throw new Error('attempt-formal-binding');
        if (next.formal.status === 'linked')
            throw new Error('attempt-formal-finalized');
        next.formal.status = 'linked';
        next.formal.coreHash = mutation.coreHash;
    }
    next.revision++;
    next.updatedAt = mutation.updatedAt;
    next.operations.push({ operationId: mutation.operationId, fingerprint, revision: next.revision });
    return receipt('accepted', next);
}
