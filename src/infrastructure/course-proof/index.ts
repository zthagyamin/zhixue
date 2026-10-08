import type { AttemptEvaluation, LearningAttempt } from '../../domain/learning-attempt';
import type { CourseEvidence } from '../../domain/course-study';
import type { StudyItemVersion, StudyRecordEnvelope } from '../../domain/sync';
// @ts-expect-error TS5097: standalone Node contracts.
import { canonicalAttemptJson } from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { studyHash } from '../../domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { parseCourseEvidence, resolveCourseSupportV2, resolveCourseTask, courseTaskHash, validateCourseDiagnostic, deterministicCourseDiagnostic, courseDiagnosticHash, attemptEvaluationForDiagnostic, chooseCourseRemediation } from '../../domain/course-study/index.ts';

type Scope = { userId: string; libraryId: string };
type Database = Pick<D1Database, 'prepare'>;
type ResolvedEvaluation = Extract<AttemptEvaluation, { status: 'resolved' }>;
type EvaluationFingerprint = (evaluation: ResolvedEvaluation) => Promise<string>;
function q(database: Database, sql: string, ...values: (string | number | null)[]) { return database.prepare(sql).bind(...values); }
function isCourseV2(item: StudyItemVersion): boolean {
    return item.schemaVersion === 2 && item.learningSupport?.schemaVersion === 2 && 'task' in item.learningSupport
        && ['quiz', 'recall'].includes(item.learningSupport.type);
}
function isFirstAttempt(attempt: LearningAttempt): boolean {
    return !attempt.parentAttemptId && !['guided', 'remediation'].includes(attempt.checkpoint.purpose ?? '');
}
async function publishedItem(database: Database, scope: Scope, attempt: LearningAttempt): Promise<StudyItemVersion | null> {
    const b = attempt.binding;
    const row = await q(database, 'SELECT v.item_json FROM account_study_snapshot_members m JOIN account_study_item_versions v ON v.user_id=m.user_id AND v.library_id=m.library_id AND v.item_key=m.item_key AND v.content_hash=m.content_hash JOIN account_study_snapshots s ON s.user_id=m.user_id AND s.library_id=m.library_id AND s.snapshot_id=m.snapshot_id WHERE m.user_id=? AND m.library_id=? AND m.snapshot_id=? AND m.item_key=? AND m.content_hash=? AND s.published=1',
        scope.userId, scope.libraryId, b.snapshotId, b.itemKey, b.contentHash).first<{ item_json: string }>();
    return row ? JSON.parse(row.item_json) as StudyItemVersion : null;
}
async function requireTables(database: Database): Promise<void> {
    for (const table of ['learning_attempts_v1', 'course_evidence_v1']) {
        if (!await q(database, "SELECT name FROM sqlite_master WHERE type='table' AND name=?", table).first())
            throw Error('course-evidence-unsupported');
    }
}
async function readEvidence(database: Database, scope: Scope, attemptId: string): Promise<CourseEvidence | null> {
    const row = await q(database, 'SELECT evidence_json FROM course_evidence_v1 WHERE user_id=? AND library_id=? AND attempt_id=?',
        scope.userId, scope.libraryId, attemptId).first<{ evidence_json: string }>();
    if (!row) return null;
    try { return parseCourseEvidence(JSON.parse(row.evidence_json)); }
    catch { throw Error('course-evaluation-mismatch'); }
}
async function validateOriginalEvidence(database: Database, scope: Scope, attempt: LearningAttempt, evidence: CourseEvidence,
    item: StudyItemVersion, fingerprint: EvaluationFingerprint): Promise<ResolvedEvaluation> {
    if (!evidence.diagnostic || evidence.diagnostic.status === 'undetermined') throw Error('course-evidence-required');
    let expected: AttemptEvaluation;
    try {
        const b = attempt.binding, support = resolveCourseSupportV2(item), task = resolveCourseTask(item, evidence.taskId);
        const { contentHash, ...body } = item;
        if (b.ownerId !== scope.userId || b.libraryId !== scope.libraryId || evidence.attemptId !== attempt.attemptId
            || canonicalAttemptJson(evidence.binding) !== canonicalAttemptJson(b) || evidence.parentAttemptId !== attempt.parentAttemptId
            || !attempt.submitted || evidence.answerRevision !== attempt.submitted.answerRevision || evidence.taskHash !== await courseTaskHash(task)
            || contentHash !== b.contentHash || item.itemKey !== b.itemKey || await studyHash(body) !== contentHash)
            throw Error('course-evaluation-mismatch');
        const diagnostic = validateCourseDiagnostic(evidence.diagnostic, task, attempt.submitted.answer);
        if (diagnostic.source === 'model' ? !evidence.trace : evidence.trace !== null) throw Error('course-evaluation-mismatch');
        if (diagnostic.source === 'deterministic' && canonicalAttemptJson(diagnostic) !== canonicalAttemptJson(deterministicCourseDiagnostic(task, attempt.submitted.answer)))
            throw Error('course-evaluation-mismatch');
        if (evidence.diagnosticHash !== await courseDiagnosticHash(diagnostic, evidence.trace)) throw Error('course-evaluation-mismatch');
        if (!attempt.parentAttemptId && (evidence.parentEvidenceHash !== null || task.taskId !== support.task.taskId)) throw Error('course-evaluation-mismatch');
        expected = attemptEvaluationForDiagnostic(diagnostic, contentHash);
    } catch { throw Error('course-evaluation-mismatch'); }
    if (attempt.parentAttemptId) {
        const parent = await readEvidence(database, scope, attempt.parentAttemptId);
        const row = await q(database, 'SELECT attempt_json FROM learning_attempts_v1 WHERE user_id=? AND library_id=? AND attempt_id=?',
            scope.userId, scope.libraryId, attempt.parentAttemptId).first<{ attempt_json: string }>();
        try {
            const original = row ? JSON.parse(row.attempt_json) as LearningAttempt : null;
            if (!parent?.diagnostic || !original?.submitted || parent.attemptId !== original.attemptId
                || parent.diagnosticHash !== evidence.parentEvidenceHash || canonicalAttemptJson(parent.binding) !== canonicalAttemptJson(original.binding)
                || ['ownerId', 'libraryId', 'snapshotId', 'itemKey', 'contentHash', 'groupId', 'roundId'].some(key => parent.binding[key as 'itemKey'] !== attempt.binding[key as 'itemKey'])
                || parent.answerRevision !== original.submitted.answerRevision) throw Error('course-evaluation-mismatch');
            const task = resolveCourseTask(item, parent.taskId);
            const diagnostic = validateCourseDiagnostic(parent.diagnostic, task, original.submitted.answer);
            if (parent.taskHash !== await courseTaskHash(task) || parent.diagnosticHash !== await courseDiagnosticHash(diagnostic, parent.trace)
                || (diagnostic.source === 'model' ? !parent.trace : parent.trace !== null)) throw Error('course-evaluation-mismatch');
            const selection = chooseCourseRemediation(resolveCourseSupportV2(item), diagnostic);
            if (evidence.taskId !== (selection?.taskId ?? parent.taskId)) throw Error('course-evaluation-mismatch');
        } catch { throw Error('course-evaluation-mismatch'); }
    }
    if (expected.status !== 'resolved' || evidence.attemptEvaluationHash !== await fingerprint(expected)) throw Error('course-evaluation-mismatch');
    return { ...expected, evaluationHash: evidence.attemptEvaluationHash };
}
/** No writer is imported: the caller injects the existing V1 fingerprint rule. */
export async function requireCourseEvaluationProof(database: Database, scope: Scope, attempt: LearningAttempt, evaluation: AttemptEvaluation,
    fingerprint: EvaluationFingerprint, formal = false): Promise<void> {
    const item = await publishedItem(database, scope, attempt);
    if (!item) throw Error('course-evaluation-mismatch');
    if (!isCourseV2(item)) return;
    // Navigation may point at a child after a first attempt's immutable claim.
    // It constrains a new claim, never replay or delivery of an existing claim.
    if (formal && (!isFirstAttempt(attempt) || !attempt.formal && ['guided', 'remediation'].includes(attempt.checkpoint.view?.purpose ?? '')))
        throw Error('course-formal-binding');
    await requireTables(database);
    const evidence = await readEvidence(database, scope, attempt.attemptId);
    if (!evidence) throw Error('course-evidence-required');
    const expected = await validateOriginalEvidence(database, scope, attempt, evidence, item, fingerprint);
    if (evaluation.status !== 'resolved' || evaluation.evaluationHash !== expected.evaluationHash
        || await fingerprint(evaluation) !== expected.evaluationHash || canonicalAttemptJson(evaluation) !== canonicalAttemptJson(expected))
        throw Error('course-evaluation-mismatch');
}
/** Runs only for a new published course record, after the historical retry path. */
export async function requireCourseFormalProof(database: Database, scope: Scope, item: StudyItemVersion, record: StudyRecordEnvelope,
    fingerprint: EvaluationFingerprint): Promise<void> {
    if (!isCourseV2(item)) return;
    if (record.provenanceMode !== 'verified-round' || record.parentEventId !== null || record.libraryId !== scope.libraryId)
        throw Error('course-formal-binding');
    await requireTables(database);
    const row = await q(database, 'SELECT attempt_id,attempt_json FROM learning_attempts_v1 WHERE user_id=? AND library_id=? AND formal_event_id=?',
        scope.userId, scope.libraryId, record.event.eventId).first<{ attempt_id: string; attempt_json: string }>();
    let original: LearningAttempt;
    try { original = JSON.parse(row?.attempt_json ?? 'null') as LearningAttempt; }
    catch { throw Error('course-formal-binding'); }
    const formal = original?.formal, b = original?.binding;
    if (!original || row?.attempt_id !== original.attemptId || !formal || !original.submitted || !isFirstAttempt(original)
        || b.ownerId !== scope.userId || b.libraryId !== scope.libraryId
        || b.itemKey !== record.event.item.key || b.contentHash !== record.contentHash || b.snapshotId !== record.snapshotId
        || formal.eventId !== record.event.eventId || formal.occurredAt !== record.event.occurredAt
        || formal.occurredAt !== record.event.scheduling?.reviewedAt || formal.rating !== record.event.attempt.rating
        || original.checkpoint.mode && original.checkpoint.mode !== record.practiceMode) throw Error('course-formal-binding');
    if (original.evaluation.status !== 'resolved' || formal.evaluationHash !== original.evaluation.evaluationHash
        || record.event.attempt.correct && !original.evaluation.correct) throw Error('course-evaluation-mismatch');
    const rank = { again: 0, hard: 1, good: 2, easy: 3 };
    if (rank[formal.rating] > rank[original.evaluation.rating]) throw Error('course-evaluation-mismatch');
    await requireCourseEvaluationProof(database, scope, original, original.evaluation, fingerprint);
}
