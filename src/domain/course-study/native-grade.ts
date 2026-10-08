import type {AttemptBinding, AttemptSubmission} from '../learning-attempt';
import type {CourseDiagnostic, CourseEvaluationTrace} from './model';
import type {NativeCourseIdentity, NativeCourseCapture} from './native-source';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject, studyDigest, studyCount, studyId, studyText, studySize, studyHash} from '../sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseAttemptBinding, canonicalAttemptJson} from '../learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseNativeCourseIdentity, assertNativeCaptureBinding} from './native-source.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {courseIdentifier, parseCourseDiagnostic, parseCourseEvaluationTrace, courseDiagnosticHash, validateCourseDiagnostic, attemptEvaluationForDiagnostic} from './diagnostic.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {resolveCourseTask, resolveCourseSupportV2, chooseCourseRemediation, courseTaskHash} from './task.ts';

export type NativeGradeRequest = {
    schemaVersion: 1; action: 'evaluate' | 'self-assess'; requestId: string; binding: AttemptBinding;
    identity: NativeCourseIdentity; captureId: string; attemptId: string; purpose: 'first' | 'guided' | 'remediation';
    parentAttemptId: string | null; parentDiagnosticHash: string | null; taskId: string; taskHash: string;
    submission: AttemptSubmission; selfStatus?: 'correct' | 'partial' | 'incorrect';
};
export type NativeGradeReceipt = Omit<NativeGradeRequest, 'action' | 'selfStatus' | 'submission'> & {
    durable: true; originRequestId: string; answerRevision: number; diagnostic: CourseDiagnostic;
    trace: CourseEvaluationTrace | null; diagnosticHash: string; attemptEvaluationHash: string | null;
    remediationTaskId: string | null; receiptHash: string;
};
export type NativeClaimRequest = {
    schemaVersion: 1; binding: AttemptBinding; identity: NativeCourseIdentity; captureId: string; attemptId: string;
    diagnosticHash: string; attemptEvaluationHash: string; eventId: string; occurredAt: string;
    rating: 'again' | 'hard' | 'good' | 'easy';
};
export type NativeClaimReceipt = {
    schemaVersion: 1; durable: true; status: 'accepted' | 'duplicate'; eventId: string; claimHash: string;
};
function oneOf(raw: unknown, values: readonly string[]): boolean {return typeof raw === 'string' && values.includes(raw);}
/** Preserve the submitted timestamp; reject invalid calendar and timezone values. */
export function nativeCourseIso(raw: unknown): string {
    studyText(raw, 'native-course-time', 40);
    const parts = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,6})?(Z|[+-](\d\d):(\d\d))$/u.exec(raw);
    if (!parts) throw Error('invalid-native-course-time');
    const [year, month, day, hour, minute, second] = parts.slice(1, 7).map(Number);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
        || hour > 23 || minute > 59 || second > 59 || Number(parts[8] ?? 0) > 23 || Number(parts[9] ?? 0) > 59
        || !Number.isFinite(Date.parse(raw))) throw Error('invalid-native-course-time');
    return raw;
}
function nativeBinding(raw: unknown, identity: NativeCourseIdentity): AttemptBinding {
    const binding = parseAttemptBinding(raw);
    for (const key of ['ownerId', 'libraryId', 'snapshotId', 'itemKey', 'groupId', 'roundId'] as const) studyId(binding[key]);
    if (binding.snapshotId !== 'local' || binding.libraryId !== identity.libraryId
        || binding.itemKey !== identity.itemKey || binding.contentHash !== identity.contentHash) throw Error('native-course-attempt-source-binding');
    return binding;
}
function submission(raw: unknown): AttemptSubmission {
    const row = studyObject(raw, ['answer', 'answerRevision', 'submittedAt', 'assistance'], ['maxPreHintLevel', 'answerRevealed']);
    studyText(row.answer, 'native-course-answer', 32000, true); studyCount(row.answerRevision, 'answer-revision');
    nativeCourseIso(row.submittedAt);
    if (!oneOf(row.assistance, ['independent', 'observed', 'unknown'])) throw Error('invalid-native-course-assistance');
    if (row.maxPreHintLevel !== undefined) {
        studyCount(row.maxPreHintLevel, 'native-course-hint');
        if (row.maxPreHintLevel > 3) throw Error('invalid-native-course-hint');
    }
    if (row.answerRevealed !== undefined && typeof row.answerRevealed !== 'boolean') throw Error('invalid-native-course-reveal');
    return structuredClone(row) as AttemptSubmission;
}
const requestKeys = ['schemaVersion', 'action', 'requestId', 'binding', 'identity', 'captureId', 'attemptId', 'purpose',
    'parentAttemptId', 'parentDiagnosticHash', 'taskId', 'taskHash', 'submission'];
function parent(row: Record<string, unknown>): void {
    if (!oneOf(row.purpose, ['first', 'guided', 'remediation'])) throw Error('invalid-native-course-purpose');
    if (row.parentAttemptId !== null) {
        courseIdentifier(row.parentAttemptId, 120); studyDigest(row.parentDiagnosticHash);
        if (row.purpose !== 'remediation' || row.parentAttemptId === row.attemptId) throw Error('invalid-native-course-parent');
    } else if (row.parentDiagnosticHash !== null) throw Error('invalid-native-course-parent');
}
export function parseNativeGradeRequest(raw: unknown): NativeGradeRequest {
    studySize(raw, 262144);
    const row = studyObject(raw, requestKeys, ['selfStatus']);
    if (row.schemaVersion !== 1 || !oneOf(row.action, ['evaluate', 'self-assess'])) throw Error('invalid-native-course-grade');
    courseIdentifier(row.requestId, 120); courseIdentifier(row.attemptId, 120); courseIdentifier(row.taskId);
    studyDigest(row.captureId); studyDigest(row.taskHash); parent(row);
    if (row.action === 'self-assess' ? !oneOf(row.selfStatus, ['correct', 'partial', 'incorrect']) : row.selfStatus !== undefined)
        throw Error('invalid-native-course-self-status');
    const identity = parseNativeCourseIdentity(row.identity), binding = nativeBinding(row.binding, identity);
    return structuredClone({...row, identity, binding, submission: submission(row.submission)}) as NativeGradeRequest;
}
const receiptKeys = requestKeys.filter(key => !['action', 'submission'].includes(key)).concat(['durable', 'originRequestId', 'answerRevision',
    'diagnostic', 'trace', 'diagnosticHash', 'attemptEvaluationHash', 'remediationTaskId', 'receiptHash']);
export async function parseNativeGradeReceipt(raw: unknown): Promise<NativeGradeReceipt> {
    studySize(raw, 262144);
    const row = studyObject(raw, receiptKeys);
    if (row.schemaVersion !== 1 || row.durable !== true) throw Error('native-course-receipt-not-durable');
    courseIdentifier(row.requestId, 120); courseIdentifier(row.originRequestId, 120); courseIdentifier(row.attemptId, 120); courseIdentifier(row.taskId);
    for (const key of ['captureId', 'taskHash', 'diagnosticHash', 'receiptHash']) studyDigest(row[key]);
    studyCount(row.answerRevision, 'answer-revision'); parent(row);
    if (row.remediationTaskId !== null) courseIdentifier(row.remediationTaskId);
    const identity = parseNativeCourseIdentity(row.identity), binding = nativeBinding(row.binding, identity);
    const diagnostic = parseCourseDiagnostic(row.diagnostic), trace = parseCourseEvaluationTrace(row.trace);
    if (diagnostic.source === 'model' ? !trace || trace.requestId !== row.originRequestId : trace !== null) throw Error('native-course-trace-binding');
    if (await courseDiagnosticHash(diagnostic, trace) !== row.diagnosticHash) throw Error('native-course-diagnostic-integrity');
    const evaluation = attemptEvaluationForDiagnostic(diagnostic, binding.contentHash);
    let expectedHash: string | null = null;
    if (evaluation.status === 'resolved') {
        const {evaluationHash: ignored, ...body} = evaluation;
        void ignored; expectedHash = await studyHash(body);
    }
    if (expectedHash !== row.attemptEvaluationHash) throw Error('native-course-evaluation-integrity');
    const {receiptHash: ignored, ...body} = row;
    void ignored;
    if (await studyHash(body) !== row.receiptHash) throw Error('native-course-receipt-integrity');
    return structuredClone({...row, identity, binding, diagnostic, trace}) as NativeGradeReceipt;
}
export async function validateNativeGradeReceipt(raw: unknown, request: NativeGradeRequest, capture: NativeCourseCapture): Promise<NativeGradeReceipt> {
    const receipt = await parseNativeGradeReceipt(raw);
    assertNativeCaptureBinding(capture, request.binding);
    for (const key of ['requestId', 'captureId', 'attemptId', 'purpose', 'parentAttemptId', 'parentDiagnosticHash', 'taskId', 'taskHash'] as const)
        if (receipt[key] !== request[key]) throw Error('native-course-result-binding');
    if (receipt.captureId !== capture.captureId || receipt.answerRevision !== request.submission.answerRevision
        || canonicalAttemptJson(receipt.binding) !== canonicalAttemptJson(request.binding)
        || canonicalAttemptJson(receipt.identity) !== canonicalAttemptJson(request.identity)
        || canonicalAttemptJson(request.identity) !== canonicalAttemptJson(capture.identity)) throw Error('native-course-result-binding');
    const task = resolveCourseTask(capture.item, receipt.taskId);
    if (await courseTaskHash(task) !== receipt.taskHash) throw Error('native-course-task-hash-conflict');
    validateCourseDiagnostic(receipt.diagnostic, task, request.submission.answer);
    if (receipt.remediationTaskId !== (chooseCourseRemediation(resolveCourseSupportV2(capture.item), receipt.diagnostic)?.taskId ?? null))
        throw Error('native-course-remediation-binding');
    return receipt;
}
export function parseNativeClaimRequest(raw: unknown): NativeClaimRequest {
    const row = studyObject(raw, ['schemaVersion', 'binding', 'identity', 'captureId', 'attemptId', 'diagnosticHash',
        'attemptEvaluationHash', 'eventId', 'occurredAt', 'rating']);
    if (row.schemaVersion !== 1 || !oneOf(row.rating, ['again', 'hard', 'good', 'easy'])) throw Error('invalid-native-course-claim');
    courseIdentifier(row.attemptId, 120); courseIdentifier(row.eventId, 120); nativeCourseIso(row.occurredAt);
    for (const key of ['captureId', 'diagnosticHash', 'attemptEvaluationHash']) studyDigest(row[key]);
    const identity = parseNativeCourseIdentity(row.identity);
    return structuredClone({...row, identity, binding: nativeBinding(row.binding, identity)}) as NativeClaimRequest;
}
export async function validateNativeClaimReceipt(raw: unknown, request: NativeClaimRequest): Promise<NativeClaimReceipt> {
    const row = studyObject(raw, ['schemaVersion', 'durable', 'status', 'eventId', 'claimHash']);
    if (row.schemaVersion !== 1 || row.durable !== true || !oneOf(row.status, ['accepted', 'duplicate'])
        || row.eventId !== request.eventId || row.claimHash !== await studyHash(request)) throw Error('native-course-claim-receipt-invalid');
    return structuredClone(row) as NativeClaimReceipt;
}
