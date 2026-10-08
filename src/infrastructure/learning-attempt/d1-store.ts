import type { AttemptMutation, AttemptReceipt, LearningAttempt } from '../../domain/learning-attempt';
import type { AttemptScope, LearningAttemptStorePort } from '../../application/learning-attempt';
// @ts-expect-error TS5097: standalone Node contracts.
import { applyAttemptMutation, parseAttemptMutation, attemptId } from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { attemptFingerprint, evaluationFingerprint } from './fingerprint.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { requireCourseEvaluationProof } from '../course-proof/index.ts';
export class D1LearningAttemptStore implements LearningAttemptStorePort {
    private database: Pick<D1Database, 'prepare'>;
    constructor(database: Pick<D1Database, 'prepare'>) { this.database = database; }
    private q(sql: string, ...values: (string | number | null)[]) { return this.database.prepare(sql).bind(...values); }
    async supported(): Promise<boolean> { return Boolean(await this.q("SELECT name FROM sqlite_master WHERE type='table' AND name='learning_attempts_v1'").first()); }
    async read(scope: AttemptScope, id: string): Promise<LearningAttempt | null> {
        attemptId(scope.userId);
        attemptId(scope.libraryId);
        attemptId(id);
        const row = await this.q('SELECT attempt_json FROM learning_attempts_v1 WHERE user_id=? AND library_id=? AND attempt_id=?', scope.userId, scope.libraryId, id).first<{
            attempt_json: string;
        }>();
        return row ? JSON.parse(row.attempt_json) as LearningAttempt : null;
    }
    async list(scope: AttemptScope, group?: string): Promise<LearningAttempt[]> {
        attemptId(scope.userId);
        attemptId(scope.libraryId);
        if (group !== undefined)
            attemptId(group);
        const rows = await this.q('SELECT attempt_json FROM learning_attempts_v1 WHERE user_id=? AND library_id=?' + (group ? ' AND group_id=?' : '') + ' ORDER BY updated_at DESC, attempt_id LIMIT 500', scope.userId, scope.libraryId, ...(group ? [group] : [])).all<{
            attempt_json: string;
        }>();
        return rows.results.map(row => JSON.parse(row.attempt_json) as LearningAttempt);
    }
    async mutate(scope: AttemptScope, raw: AttemptMutation): Promise<AttemptReceipt> {
        const mutation = parseAttemptMutation(raw), b = mutation.binding;
        if (b.ownerId !== scope.userId || b.libraryId !== scope.libraryId)
            throw new Error('attempt-scope-mismatch');
        if (mutation.kind === 'evaluate' && mutation.evaluation.status === 'resolved' && mutation.evaluation.evaluationHash !== await evaluationFingerprint(mutation.evaluation))
            throw new Error('attempt-evaluation-hash-conflict');
        // Exact published snapshot membership remains valid after the current head changes.
        const member = await this.q('SELECT 1 FROM account_study_snapshot_members m JOIN account_study_snapshots s ON s.user_id=m.user_id AND s.library_id=m.library_id AND s.snapshot_id=m.snapshot_id WHERE m.user_id=? AND m.library_id=? AND m.snapshot_id=? AND m.item_key=? AND m.content_hash=? AND s.published=1', scope.userId, scope.libraryId, b.snapshotId, b.itemKey, b.contentHash).first();
        if (!member)
            throw new Error('attempt-source-not-registered');
        const current = await this.read(scope, mutation.attemptId), next = applyAttemptMutation(current, mutation, await attemptFingerprint(mutation));
        if (next.status !== 'accepted')
            return { ...next, durable: next.status === 'duplicate' };
        if (current && (mutation.kind === 'evaluate' && mutation.evaluation.status === 'resolved' || mutation.kind === 'claim-formal'))
            await requireCourseEvaluationProof(this.database, scope, current, mutation.kind === 'evaluate' ? mutation.evaluation : current.evaluation, evaluationFingerprint, mutation.kind === 'claim-formal');
        if (mutation.kind === 'checkpoint' && mutation.parentAttemptId && !current) {
            const parent = await this.read(scope, mutation.parentAttemptId);
            if (!parent || !parent.submitted || parent.binding.itemKey !== b.itemKey || parent.binding.contentHash !== b.contentHash || parent.binding.roundId !== b.roundId || parent.binding.groupId !== b.groupId)
                throw new Error('attempt-parent-binding');
        }
        if (mutation.kind === 'link-formal') {
            const row = await this.q('SELECT event_id,core_hash,record_json FROM account_study_records WHERE user_id=? AND library_id=? AND event_id=?', scope.userId, scope.libraryId, mutation.eventId).first<{
                event_id: string;
                core_hash: string;
                record_json: string;
            }>();
            if (!row)
                throw new Error('attempt-formal-not-durable');
            const record = JSON.parse(row.record_json), formal = current?.formal;
            if (!formal || row.event_id !== formal.eventId || record.event.eventId !== formal.eventId || row.core_hash !== mutation.coreHash || record.contentHash !== b.contentHash || record.snapshotId !== b.snapshotId || record.provenanceMode !== 'verified-round' || record.event.item.key !== b.itemKey || record.event.scheduling?.reviewedAt !== formal.occurredAt || record.event.attempt.rating !== formal.rating)
                throw new Error('attempt-formal-record-binding');
            next.attempt!.formal!.authoritativeRecord = { attemptId: record.attemptId, roundId: record.roundId };
        }
        const saved = next.attempt!, values = [scope.userId, scope.libraryId, saved.attemptId];
        try {
            const logicalKey = saved.formal ? JSON.stringify([b.groupId, b.roundId, b.itemKey, b.contentHash]) : null;
            if (!current)
                await this.q('INSERT INTO learning_attempts_v1(user_id,library_id,attempt_id,group_id,revision,attempt_json,formal_event_id,formal_logical_key,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING', ...values, b.groupId, saved.revision, JSON.stringify(saved), saved.formal?.eventId ?? null, logicalKey, saved.updatedAt).run();
            else
                await this.q('UPDATE learning_attempts_v1 SET revision=?,attempt_json=?,formal_event_id=?,formal_logical_key=?,updated_at=? WHERE user_id=? AND library_id=? AND attempt_id=? AND revision=?', saved.revision, JSON.stringify(saved), saved.formal?.eventId ?? null, logicalKey, saved.updatedAt, ...values, current.revision).run();
        }
        catch (error) {
            if (error instanceof Error && /UNIQUE constraint failed/.test(error.message))
                throw new Error('attempt-formal-event-conflict');
            throw error;
        }
        const readback = await this.read(scope, mutation.attemptId);
        const operation = readback?.operations.find(row => row.operationId === mutation.operationId);
        if (!operation || operation.fingerprint !== saved.operations.at(-1)?.fingerprint)
            return { status: 'conflict', durable: false, operationId: mutation.operationId, revision: readback?.revision ?? 0, attempt: readback };
        return { ...next, durable: true, attempt: readback, revision: readback!.revision };
    }
}
