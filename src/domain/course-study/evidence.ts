import type {CourseEvidence, CourseEvidenceMutation, CourseEvidenceReceipt, CourseDiagnostic, CourseEvaluationTrace} from './model';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseAttemptBinding, canonicalAttemptJson} from '../learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject, studySize, studyDigest, studyCount, studyIso} from '../sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {courseIdentifier, parseCourseDiagnostic, parseCourseEvaluationTrace} from './diagnostic.ts';

const MAX_BYTES = 65536;
function digest(raw: unknown): string { studyDigest(raw); return raw; }
function count(raw: unknown, minimum = 0): number { studyCount(raw, 'course-revision', minimum); return raw; }
function timestamp(raw: unknown): string { studyIso(raw); return raw; }
function binding(raw: unknown) {
    studyObject(raw, ['ownerId', 'libraryId', 'snapshotId', 'itemKey', 'contentHash', 'groupId', 'roundId']);
    return parseAttemptBinding(raw);
}
function parent(rawId: unknown, rawHash: unknown, attemptId: string) {
    const parentAttemptId = rawId === null ? null : courseIdentifier(rawId, 120);
    const parentEvidenceHash = rawHash === null ? null : digest(rawHash);
    if ((parentAttemptId === null) !== (parentEvidenceHash === null) || parentAttemptId === attemptId)
        throw Error('invalid-course-evidence-parent');
    return {parentAttemptId, parentEvidenceHash};
}
function diagnosticState(diagnostic: CourseDiagnostic, trace: CourseEvaluationTrace | null, hash: unknown, evaluationHash: unknown) {
    const diagnosticHash = digest(hash), attemptEvaluationHash = evaluationHash === null ? null : digest(evaluationHash);
    if (diagnostic.source === 'model' && !trace) throw Error('course-model-trace-required');
    if ((diagnostic.status === 'undetermined') !== (attemptEvaluationHash === null)) throw Error('inconsistent-course-evaluation-hash');
    return {diagnostic, trace, diagnosticHash, attemptEvaluationHash};
}
export function parseCourseEvidence(raw: unknown): CourseEvidence {
    studySize(raw, MAX_BYTES);
    const row = studyObject(raw, ['schemaVersion', 'attemptId', 'binding', 'taskId', 'taskHash', 'parentAttemptId',
        'parentEvidenceHash', 'revision', 'answerRevision', 'diagnostic', 'trace', 'diagnosticHash', 'attemptEvaluationHash',
        'createdAt', 'updatedAt', 'operations']);
    if (row.schemaVersion !== 1) throw Error('unsupported-course-evidence');
    const attemptId = courseIdentifier(row.attemptId, 120), revision = count(row.revision, 1);
    if (!Array.isArray(row.operations) || row.operations.length > 1000 || row.operations.length !== revision)
        throw Error('invalid-course-evidence-operations');
    const operationIds = new Set<string>();
    const operations = Array.from(row.operations).map(entry => {
        const operation = studyObject(entry, ['operationId', 'fingerprint']);
        const operationId = courseIdentifier(operation.operationId, 120);
        if (operationIds.has(operationId)) throw Error('duplicate-course-evidence-operation');
        operationIds.add(operationId);
        return {operationId, fingerprint: digest(operation.fingerprint)};
    });
    const createdAt = timestamp(row.createdAt), updatedAt = timestamp(row.updatedAt);
    if (updatedAt < createdAt) throw Error('invalid-course-evidence-time-order');
    const answerRevision = row.answerRevision === null ? null : count(row.answerRevision);
    let state: Pick<CourseEvidence, 'diagnostic' | 'trace' | 'diagnosticHash' | 'attemptEvaluationHash'>;
    if (row.diagnostic === null) {
        if (answerRevision !== null || row.trace !== null || row.diagnosticHash !== null || row.attemptEvaluationHash !== null)
            throw Error('invalid-empty-course-evidence');
        state = {diagnostic: null, trace: null, diagnosticHash: null, attemptEvaluationHash: null};
    } else {
        if (answerRevision === null) throw Error('course-evidence-answer-revision-required');
        state = diagnosticState(parseCourseDiagnostic(row.diagnostic), parseCourseEvaluationTrace(row.trace), row.diagnosticHash, row.attemptEvaluationHash);
    }
    return {schemaVersion: 1, attemptId, binding: binding(row.binding), taskId: courseIdentifier(row.taskId), taskHash: digest(row.taskHash),
        ...parent(row.parentAttemptId, row.parentEvidenceHash, attemptId), revision, answerRevision, ...state, createdAt, updatedAt, operations};
}
export function parseCourseEvidenceMutation(raw: unknown): CourseEvidenceMutation {
    studySize(raw, MAX_BYTES);
    const value = raw as Record<string, unknown>;
    if (!['bind', 'diagnose'].includes(String(value?.kind))) throw Error('invalid-course-evidence-kind');
    const row = studyObject(raw, ['schemaVersion', 'kind', 'attemptId', 'binding', 'operationId', 'expectedRevision', 'updatedAt',
        ...(value.kind === 'bind' ? ['taskId', 'taskHash', 'parentAttemptId', 'parentEvidenceHash'] :
            ['answerRevision', 'diagnostic', 'trace', 'diagnosticHash', 'attemptEvaluationHash'])]);
    if (row.schemaVersion !== 1) throw Error('unsupported-course-evidence-mutation');
    const base = {schemaVersion: 1 as const, attemptId: courseIdentifier(row.attemptId, 120), binding: binding(row.binding),
        operationId: courseIdentifier(row.operationId, 120), expectedRevision: count(row.expectedRevision), updatedAt: timestamp(row.updatedAt)};
    if (row.kind === 'bind') return {...base, kind: 'bind', taskId: courseIdentifier(row.taskId), taskHash: digest(row.taskHash),
        ...parent(row.parentAttemptId, row.parentEvidenceHash, base.attemptId)};
    return {...base, kind: 'diagnose', answerRevision: count(row.answerRevision),
        ...diagnosticState(parseCourseDiagnostic(row.diagnostic), parseCourseEvaluationTrace(row.trace), row.diagnosticHash, row.attemptEvaluationHash)};
}
/** Pure CAS: caller verifies original submission, task, quotes and digests first. */
export function applyCourseEvidenceMutation(current: CourseEvidence | null, input: CourseEvidenceMutation, fingerprint: string): CourseEvidenceReceipt {
    const mutation = parseCourseEvidenceMutation(input);
    digest(fingerprint);
    if (current) current = parseCourseEvidence(current);
    const receipt = (status: CourseEvidenceReceipt['status'], evidence = current): CourseEvidenceReceipt =>
        ({schemaVersion: 1, status, durable: false, operationId: mutation.operationId, revision: evidence?.revision ?? 0,
            evidence: evidence ? structuredClone(evidence) : null});
    if (current && (current.attemptId !== mutation.attemptId || canonicalAttemptJson(current.binding) !== canonicalAttemptJson(mutation.binding)))
        return receipt('conflict');
    const known = current?.operations.find(row => row.operationId === mutation.operationId);
    if (known) return receipt(known.fingerprint === fingerprint ? 'duplicate' : 'conflict');
    if ((current?.revision ?? 0) !== mutation.expectedRevision || current && mutation.updatedAt < current.updatedAt) return receipt('conflict');
    const recordOperation = (evidence: CourseEvidence): CourseEvidenceReceipt => {
        if (evidence.operations.length >= 1000) throw Error('course-evidence-operation-limit');
        const next = {...structuredClone(evidence), revision: evidence.revision + 1, updatedAt: mutation.updatedAt,
            operations: [...evidence.operations, {operationId: mutation.operationId, fingerprint}]};
        return receipt('accepted', parseCourseEvidence(next));
    };
    if (mutation.kind === 'bind') {
        if (current) return current.taskId === mutation.taskId && current.taskHash === mutation.taskHash
            && current.parentAttemptId === mutation.parentAttemptId && current.parentEvidenceHash === mutation.parentEvidenceHash
            ? recordOperation(current) : receipt('conflict');
        const next: CourseEvidence = {schemaVersion: 1, attemptId: mutation.attemptId, binding: mutation.binding,
            taskId: mutation.taskId, taskHash: mutation.taskHash, parentAttemptId: mutation.parentAttemptId,
            parentEvidenceHash: mutation.parentEvidenceHash, revision: 1, answerRevision: null, diagnostic: null,
            trace: null, diagnosticHash: null, attemptEvaluationHash: null, createdAt: mutation.updatedAt, updatedAt: mutation.updatedAt,
            operations: [{operationId: mutation.operationId, fingerprint}]};
        return receipt('accepted', parseCourseEvidence(next));
    }
    if (!current || current.answerRevision !== null && current.answerRevision !== mutation.answerRevision) return receipt('conflict');
    if (current.diagnostic?.status !== 'undetermined' && current.diagnostic !== null) {
        const identical = current.diagnosticHash === mutation.diagnosticHash && current.attemptEvaluationHash === mutation.attemptEvaluationHash
            && canonicalAttemptJson(current.diagnostic) === canonicalAttemptJson(mutation.diagnostic)
            && canonicalAttemptJson(current.trace) === canonicalAttemptJson(mutation.trace);
        return identical ? recordOperation(current) : receipt('conflict');
    }
    if (current.operations.length >= 1000) throw Error('course-evidence-operation-limit');
    const next: CourseEvidence = {...structuredClone(current), answerRevision: mutation.answerRevision, diagnostic: mutation.diagnostic,
        trace: mutation.trace, diagnosticHash: mutation.diagnosticHash, attemptEvaluationHash: mutation.attemptEvaluationHash,
        revision: current.revision + 1, updatedAt: mutation.updatedAt,
        operations: [...current.operations, {operationId: mutation.operationId, fingerprint}]};
    return receipt('accepted', parseCourseEvidence(next));
}
