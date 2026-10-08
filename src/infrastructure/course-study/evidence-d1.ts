import type { CourseEvidence, CourseEvidenceMutation, CourseEvidenceReceipt } from '../../domain/course-study';
import type { CourseEvidenceOriginalPort, CourseEvidenceScope, CourseEvidenceStorePort } from '../../application/course-study';
// @ts-expect-error TS5097: standalone Node contracts.
import { applyCourseEvidenceMutation, parseCourseEvidenceMutation } from '../../domain/course-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { attemptId } from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { courseEvidenceFingerprint } from './fingerprint.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { assertCourseScope, validateCourseAggregate, validateCourseOriginal, validateCourseDiagnosis } from './validation.ts';

export class D1CourseEvidenceStore implements CourseEvidenceStorePort {
    private database: Pick<D1Database, 'prepare'>;
    private original: CourseEvidenceOriginalPort;
    constructor(database: Pick<D1Database, 'prepare'>, original: CourseEvidenceOriginalPort) { this.database = database; this.original = original; }
    private q(sql: string, ...values: (string | number | null)[]) { return this.database.prepare(sql).bind(...values); }
    async supported(): Promise<boolean> {
        return Boolean(await this.q("SELECT name FROM sqlite_master WHERE type='table' AND name='course_evidence_v1'").first());
    }
    async read(scope: CourseEvidenceScope, id: string): Promise<CourseEvidence | null> {
        attemptId(scope.userId); attemptId(scope.libraryId); attemptId(id);
        if (!await this.supported()) throw Error('course-evidence-unsupported');
        const row = await this.q('SELECT evidence_json FROM course_evidence_v1 WHERE user_id=? AND library_id=? AND attempt_id=?',
            scope.userId, scope.libraryId, id).first<{ evidence_json: string }>();
        const evidence = row ? await validateCourseAggregate(scope, JSON.parse(row.evidence_json)) : null;
        if (evidence && evidence.attemptId !== id) throw Error('course-evidence-record-binding');
        return evidence;
    }
    mutate(scope: CourseEvidenceScope, mutation: CourseEvidenceMutation): Promise<CourseEvidenceReceipt> { return this.write(scope, mutation, false); }
    writeModel(scope: CourseEvidenceScope, mutation: CourseEvidenceMutation): Promise<CourseEvidenceReceipt> { return this.write(scope, mutation, true); }
    private async write(scope: CourseEvidenceScope, raw: CourseEvidenceMutation, model: boolean): Promise<CourseEvidenceReceipt> {
        const mutation = parseCourseEvidenceMutation(raw); assertCourseScope(scope, mutation);
        if (mutation.kind === 'diagnose' && mutation.diagnostic.source === 'model' && !model) throw Error('course-model-public-mutation-forbidden');
        if (model && (mutation.kind !== 'diagnose' || mutation.diagnostic.source !== 'model')) throw Error('course-model-internal-result-required');
        if (!await this.supported()) throw Error('course-evidence-unsupported');
        const b = mutation.binding;
        const member = await this.q('SELECT 1 FROM account_study_snapshot_members m JOIN account_study_snapshots s ON s.user_id=m.user_id AND s.library_id=m.library_id AND s.snapshot_id=m.snapshot_id WHERE m.user_id=? AND m.library_id=? AND m.snapshot_id=? AND m.item_key=? AND m.content_hash=? AND s.published=1',
            scope.userId, scope.libraryId, b.snapshotId, b.itemKey, b.contentHash).first();
        if (!member) throw Error('course-source-not-registered');
        const current = await this.read(scope, mutation.attemptId), identity = mutation.kind === 'bind' ? mutation : current;
        if (!identity) throw Error('course-evidence-not-bound');
        const context = await validateCourseOriginal(scope, identity, this.original, id => this.read(scope, id));
        if (mutation.kind === 'diagnose') await validateCourseDiagnosis(mutation, context);
        const fingerprint = await courseEvidenceFingerprint(mutation), next = applyCourseEvidenceMutation(current, mutation, fingerprint);
        if (next.status !== 'accepted') {
            const recorded = next.evidence?.operations.some(op => op.operationId === mutation.operationId && op.fingerprint === fingerprint);
            return { ...next, status: next.status === 'duplicate' && !recorded ? 'conflict' : next.status, durable: next.status === 'duplicate' && Boolean(recorded) };
        }
        const saved = next.evidence!, values = [scope.userId, scope.libraryId, saved.attemptId];
        if (!current)
            await this.q('INSERT INTO course_evidence_v1(user_id,library_id,attempt_id,revision,evidence_json,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING',
                ...values, saved.revision, JSON.stringify(saved), saved.updatedAt).run();
        else
            await this.q('UPDATE course_evidence_v1 SET revision=?,evidence_json=?,updated_at=? WHERE user_id=? AND library_id=? AND attempt_id=? AND revision=?',
                saved.revision, JSON.stringify(saved), saved.updatedAt, ...values, current.revision).run();
        const readback = await this.read(scope, mutation.attemptId);
        const operation = readback?.operations.find(op => op.operationId === mutation.operationId);
        if (operation?.fingerprint !== fingerprint) return { schemaVersion: 1, status: 'conflict', durable: false,
            operationId: mutation.operationId, revision: readback?.revision ?? 0, evidence: readback };
        return { ...next, durable: true, evidence: readback, revision: readback!.revision };
    }
}
