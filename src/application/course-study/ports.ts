import type { AttemptBinding, LearningAttempt } from '../../domain/learning-attempt';
import type { CourseSourceItem } from '../../domain/course-study';
import type { CourseEvidence, CourseEvidenceMutation, CourseEvidenceReceipt, CourseDiagnostic, CourseEvaluationTrace, ResolvedCourseTask, NativeCourseCapture } from '../../domain/course-study';
import type { CourseGradeRequest } from '../../domain/course-ai';

export type CourseEvidenceScope = { userId: string; libraryId: string };
export interface CourseEvidenceStorePort {
    supported(): Promise<boolean>;
    read(scope: CourseEvidenceScope, attemptId: string): Promise<CourseEvidence | null>;
    mutate(scope: CourseEvidenceScope, mutation: CourseEvidenceMutation): Promise<CourseEvidenceReceipt>;
    /** Internal application path: a validated provider result, never a client body flag. */
    writeModel(scope: CourseEvidenceScope, mutation: CourseEvidenceMutation): Promise<CourseEvidenceReceipt>;
}
export interface CourseEvidenceCloudPort {
    read(attemptId: string): Promise<CourseEvidence | null>;
    mutate(mutation: CourseEvidenceMutation): Promise<CourseEvidenceReceipt>;
}
export interface CourseEvidenceOriginalPort {
    readAttempt(scope: CourseEvidenceScope, attemptId: string): Promise<LearningAttempt | null>;
    readItem(scope: CourseEvidenceScope, binding: AttemptBinding): Promise<CourseSourceItem | null>;
    readNativeCapture?(scope: CourseEvidenceScope, binding: AttemptBinding, attemptId: string): Promise<NativeCourseCapture | null>;
}
export interface CourseEvidenceLocalPort {
    read(attemptId: string): Promise<CourseEvidence | null>;
    mutate(mutation: CourseEvidenceMutation): Promise<CourseEvidenceReceipt>;
    pending(): Promise<readonly { mutation: CourseEvidenceMutation; fingerprint: string }[]>;
    status(attemptId: string): Promise<'device-only' | 'cloud-acked' | 'cloud-conflict' | null>;
    synchronize(cloud: CourseEvidenceCloudPort): Promise<void>;
    hydrate(evidence: CourseEvidence): Promise<void>;
}
export type CourseEvidenceLocalOptions = {
    cloud?: boolean;
    readAttempt: (attemptId: string) => Promise<LearningAttempt | null>;
    readItem: (binding: AttemptBinding) => Promise<CourseSourceItem | null>;
    readNativeCapture?: (binding: AttemptBinding, attemptId: string) => Promise<NativeCourseCapture | null>;
};
export interface CourseTaskProviderPort {
    run(request: CourseGradeRequest & { requestId: string }, task: ResolvedCourseTask, answer: string,
        budget: { maxOutputTokens: number }, signal?: AbortSignal): Promise<{
            diagnostic: CourseDiagnostic; trace: CourseEvaluationTrace; usageTokens?: number;
        }>;
}
/** Narrow plugin intent port; persistence/models/official events remain outside the component. */
export interface CourseLearningPort {
    readonly task: ResolvedCourseTask;
    originalAnswer(): string;
    /** Exposes only persisted diagnostics matching the current attempt evaluation and source. */
    evidence(): CourseEvidence | null;
    evaluate(signal?: AbortSignal): Promise<CourseEvidence>;
    selfAssess?(status: 'correct' | 'partial' | 'incorrect', signal?: AbortSignal): Promise<CourseEvidence>;
    remediationTaskId(): string | null;
    beforeFormal?():Promise<void>;
}
export interface CourseRequestJournalPort {
    request(key: string, makeId: () => string): Promise<string>;
    complete(key: string, requestId: string): Promise<void>;
}
