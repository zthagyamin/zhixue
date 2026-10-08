import type {AttemptBinding} from '../learning-attempt';
import type {CourseCriterion, CourseSource, CourseTaskKind, QuizSupportV2} from '../content';

export type ResolvedCourseTask = {
    schemaVersion: 1;
    taskId: string;
    mode: 'recall' | 'quiz';
    kind: CourseTaskKind;
    prompt: string;
    scope: string;
    conditions: string[];
    sources: CourseSource[];
    criteria: CourseCriterion[];
    answer: string;
    options?: QuizSupportV2['options'];
    selection?: 'single' | 'multiple';
    correctOptionIds?: string[];
};
export type CoursePointEvidence = {
    pointId: string;
    sourceId: string;
    sourceQuote: string;
    answerQuote: string;
    reason: string;
};
export type CourseDiagnostic = {
    schemaVersion: 1;
    status: 'correct' | 'partial' | 'incorrect';
    source: 'model' | 'deterministic' | 'self-assess';
    feedback: string;
    matchedPointIds: string[];
    missedPointIds: string[];
    errorPointIds: string[];
    wrongOptionIds: string[];
    missingOptionIds: string[];
    pointEvidence: CoursePointEvidence[];
} | {
    schemaVersion: 1;
    status: 'undetermined';
    source: 'model' | 'deterministic' | 'self-assess' | 'none';
    feedback: string;
    reason: 'unavailable' | 'offline' | 'cancelled' | 'source-insufficient' | 'source-conflict' | 'uncertain' | 'invalid-result';
    matchedPointIds: string[];
    missedPointIds: string[];
    errorPointIds: string[];
    wrongOptionIds: string[];
    missingOptionIds: string[];
    pointEvidence: CoursePointEvidence[];
};
export type CourseEvaluationTrace = {
    provider?: string;
    modelId: string;
    promptVersion: string;
    ruleVersion: string;
    requestId: string;
};
export type CourseEvidence = {
    schemaVersion: 1;
    attemptId: string;
    binding: AttemptBinding;
    taskId: string;
    taskHash: string;
    parentAttemptId: string | null;
    parentEvidenceHash: string | null;
    revision: number;
    answerRevision: number | null;
    diagnostic: CourseDiagnostic | null;
    trace: CourseEvaluationTrace | null;
    diagnosticHash: string | null;
    attemptEvaluationHash: string | null;
    createdAt: string;
    updatedAt: string;
    operations: {operationId: string; fingerprint: string}[];
};
type MutationBase = {
    schemaVersion: 1;
    attemptId: string;
    binding: AttemptBinding;
    operationId: string;
    expectedRevision: number;
    updatedAt: string;
};
export type CourseEvidenceMutation = MutationBase & ({
    kind: 'bind';
    taskId: string;
    taskHash: string;
    parentAttemptId: string | null;
    parentEvidenceHash: string | null;
} | {
    kind: 'diagnose';
    answerRevision: number;
    diagnostic: CourseDiagnostic;
    trace: CourseEvaluationTrace | null;
    diagnosticHash: string;
    attemptEvaluationHash: string | null;
});
export type CourseEvidenceReceipt = {
    schemaVersion: 1;
    status: 'accepted' | 'duplicate' | 'conflict';
    durable: boolean;
    operationId: string;
    revision: number;
    evidence: CourseEvidence | null;
};
