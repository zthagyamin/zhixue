import type { CourseEvidence, CourseEvidenceMutation, CourseEvidenceReceipt } from '../../domain/course-study';
import type { CourseEvidenceOriginalPort, CourseEvidenceScope } from '../../application/course-study';
import type { LearningAttempt } from '../../domain/learning-attempt';
import type { CourseSourceItem } from '../../domain/course-study';
import type { ResolvedCourseTask } from '../../domain/course-study';
// @ts-expect-error TS5097: standalone Node contracts.
import { canonicalAttemptJson, attemptId } from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { studyHash } from '../../domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { parseCourseEvidence, resolveCourseTask, resolveCourseSupportV2, courseTaskHash, chooseCourseRemediation, validateCourseDiagnostic, deterministicCourseDiagnostic, courseDiagnosticHash, attemptEvaluationForDiagnostic, parseNativeCourseCapture, assertNativeCaptureBinding } from '../../domain/course-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { courseEvidenceFingerprint, evaluationFingerprint } from './fingerprint.ts';

export function assertCourseScope(scope: CourseEvidenceScope, evidence: Pick<CourseEvidence, 'binding' | 'attemptId'>): void {
    attemptId(scope.userId); attemptId(scope.libraryId); attemptId(evidence.attemptId);
    if (evidence.binding.ownerId !== scope.userId || evidence.binding.libraryId !== scope.libraryId)
        throw Error('course-evidence-scope-mismatch');
}
export function courseIdentity(evidence: CourseEvidence | Extract<CourseEvidenceMutation, { kind: 'bind' }>): string {
    return canonicalAttemptJson({ attemptId: evidence.attemptId, binding: evidence.binding, taskId: evidence.taskId,
        taskHash: evidence.taskHash, parentAttemptId: evidence.parentAttemptId, parentEvidenceHash: evidence.parentEvidenceHash });
}
export async function validateCourseOriginal(scope: CourseEvidenceScope, evidence: CourseEvidence | Extract<CourseEvidenceMutation, { kind: 'bind' }>,
    original: CourseEvidenceOriginalPort, readEvidence: (id: string) => Promise<CourseEvidence | null>, ancestors = new Set<string>()): Promise<Context> {
    assertCourseScope(scope, evidence);
    if (ancestors.has(evidence.attemptId)) throw Error('course-parent-cycle');
    const seen = new Set(ancestors).add(evidence.attemptId);
    const attempt = await original.readAttempt(scope, evidence.attemptId);
    if (!attempt || attempt.attemptId !== evidence.attemptId || canonicalAttemptJson(attempt.binding) !== canonicalAttemptJson(evidence.binding))
        throw Error('course-original-attempt-binding');
    if (attempt.parentAttemptId !== evidence.parentAttemptId) throw Error('course-parent-attempt-binding');
    const item = await original.readItem(scope, evidence.binding);
    if (!item || item.itemKey !== evidence.binding.itemKey || item.contentHash !== evidence.binding.contentHash)
        throw Error('course-original-source-binding');
    if (evidence.binding.snapshotId === 'local') {
        if (!original.readNativeCapture) throw Error('course-native-source-capture-required');
        const raw = await original.readNativeCapture(scope, evidence.binding, evidence.attemptId);
        if (!raw) throw Error('course-native-source-capture-required');
        const capture = await parseNativeCourseCapture(raw);
        assertNativeCaptureBinding(capture, evidence.binding);
        if (await studyHash(item) !== await studyHash(capture.item)) throw Error('course-original-source-integrity');
    } else {
        const { contentHash, ...body } = item;
        if (await studyHash(body) !== contentHash) throw Error('course-original-source-integrity');
    }
    const support = resolveCourseSupportV2(item), task = resolveCourseTask(item, evidence.taskId);
    if (await courseTaskHash(task) !== evidence.taskHash) throw Error('course-task-hash-conflict');
    if (evidence.parentAttemptId) {
        const parent = await readEvidence(evidence.parentAttemptId);
        if (!parent?.diagnostic || !parent.diagnosticHash || parent.diagnosticHash !== evidence.parentEvidenceHash)
            throw Error('course-parent-evidence-binding');
        const parentContext = await validateCourseOriginal(scope, parent, original, readEvidence, seen);
        if (!parentContext.attempt.submitted || ['snapshotId', 'itemKey', 'contentHash', 'groupId', 'roundId'].some(key =>
            parent.binding[key as 'itemKey'] !== evidence.binding[key as 'itemKey'])) throw Error('course-parent-source-binding');
        await validateCourseDiagnosis(parent, parentContext);
        const selected = chooseCourseRemediation(support, parent.diagnostic);
        if (evidence.taskId !== (selected?.taskId ?? parent.taskId)) throw Error('course-parent-task-selection');
    } else if (evidence.parentEvidenceHash !== null || evidence.taskId !== support.task.taskId) {
        throw Error('course-original-task-binding');
    }
    return { attempt, item, task };
}
type Context = { attempt: LearningAttempt; item: CourseSourceItem; task: ResolvedCourseTask };
export async function validateCourseDiagnosis(value: CourseEvidence | Extract<CourseEvidenceMutation, { kind: 'diagnose' }>, context: Context): Promise<void> {
    if (!value.diagnostic) return;
    if (!context.attempt.submitted || context.attempt.submitted.answerRevision !== value.answerRevision)
        throw Error('course-answer-revision-conflict');
    const diagnostic = validateCourseDiagnostic(value.diagnostic, context.task, context.attempt.submitted.answer);
    if (diagnostic.source === 'model' ? !value.trace : value.trace !== null) throw Error('course-diagnostic-trace-conflict');
    if (diagnostic.source === 'deterministic' && diagnostic.status !== 'undetermined'
        && canonicalAttemptJson(diagnostic) !== canonicalAttemptJson(deterministicCourseDiagnostic(context.task, context.attempt.submitted.answer)))
        throw Error('course-deterministic-diagnostic-conflict');
    if (await courseDiagnosticHash(diagnostic, value.trace) !== value.diagnosticHash) throw Error('course-diagnostic-hash-conflict');
    const evaluation = attemptEvaluationForDiagnostic(diagnostic, context.item.contentHash);
    const hash = evaluation.status === 'resolved' ? await evaluationFingerprint(evaluation) : null;
    if (value.attemptEvaluationHash !== hash) throw Error('course-attempt-evaluation-hash-conflict');
}
export async function validateCourseAggregate(scope: CourseEvidenceScope, raw: unknown): Promise<CourseEvidence> {
    const evidence = parseCourseEvidence(raw); assertCourseScope(scope, evidence);
    if (evidence.diagnostic) {
        if (evidence.diagnostic.source === 'model' ? !evidence.trace : evidence.trace !== null) throw Error('course-diagnostic-trace-conflict');
        if (await courseDiagnosticHash(evidence.diagnostic, evidence.trace) !== evidence.diagnosticHash)
            throw Error('course-diagnostic-hash-conflict');
        const evaluation = attemptEvaluationForDiagnostic(evidence.diagnostic, evidence.binding.contentHash);
        if (evidence.attemptEvaluationHash !== (evaluation.status === 'resolved' ? await evaluationFingerprint(evaluation) : null))
            throw Error('course-attempt-evaluation-hash-conflict');
    }
    return evidence;
}
export async function validateCourseReceipt(scope: CourseEvidenceScope, raw: unknown, mutation: CourseEvidenceMutation): Promise<CourseEvidenceReceipt> {
    const row = raw as CourseEvidenceReceipt;
    if (!row || row.schemaVersion !== 1 || !['accepted', 'duplicate', 'conflict'].includes(row.status)
        || typeof row.durable !== 'boolean' || row.operationId !== mutation.operationId || !Number.isSafeInteger(row.revision) || row.revision < 0
        || Object.keys(row).some(key => !['schemaVersion', 'status', 'durable', 'operationId', 'revision', 'evidence'].includes(key)))
        throw Error('course-cloud-receipt-invalid');
    const evidence = row.evidence === null ? null : await validateCourseAggregate(scope, row.evidence);
    if (row.revision !== (evidence?.revision ?? 0) || evidence && (evidence.attemptId !== mutation.attemptId
        || canonicalAttemptJson(evidence.binding) !== canonicalAttemptJson(mutation.binding))) throw Error('course-cloud-receipt-binding');
    if (row.status === 'conflict') {
        if (row.durable) throw Error('course-cloud-receipt-invalid');
    } else {
        const fingerprint = await courseEvidenceFingerprint(mutation);
        if (!row.durable || !evidence || !evidence.operations.some(op => op.operationId === mutation.operationId && op.fingerprint === fingerprint))
            throw Error('course-cloud-receipt-fingerprint');
    }
    return { ...row, evidence };
}
