import type { AttemptBinding, LearningAttempt } from '../learning-attempt';
import type { CodeRunReportV1 } from '../code-execution';
import type { CalculationSupport } from '../content';
import type { MathVariantMappingV1, TemplateId } from '../guided-math';
export type PracticeEvidenceHint = {
    runId: number;
    caseId?: string;
    text: string;
    source: 'preset' | 'model';
};
export type PreparedPracticeEvidenceChild = {
    instanceId: string;
    attemptId: string;
};
export type PracticeEvidenceDiagnostic = {
    answerRevision: number;
    stepRevision: number;
    stepId: string;
    sourceVersion: string;
    status: 'correct' | 'incorrect' | 'undetermined';
    source: 'deterministic' | 'model' | 'none';
    explanation: string;
};
export type PracticeVariantRecoveryV1 = {
    schemaVersion: 1;
    mappingId: string;
    parentItemKey: string;
    parentContentHash: string;
    hashKind: 'content' | 'visible-snapshot';
    templateVersion: 1;
    templateId: TemplateId;
    seed: number;
    parameters: Record<string, number>;
    variantHash: string;
};
export type PracticeEvidenceV1 = {
    schemaVersion: 1;
    attemptId: string;
    binding: AttemptBinding;
    revision: number;
    updatedAt: string;
    execution?: {
        first?: CodeRunReportV1;
        latest?: CodeRunReportV1;
        firstOutput?: string;
        latestOutput?: string;
        prepared?: PreparedPracticeEvidenceChild;
        hint?: PracticeEvidenceHint;
    };
    calculation?: {
        stepInput: {
            text: string;
            revision: number;
        };
        diagnostic?: PracticeEvidenceDiagnostic;
    };
    variant?: PracticeVariantRecoveryV1;
    operations: {
        operationId: string;
        fingerprint: string;
        revision: number;
    }[];
};
type Base = {
    schemaVersion: 1;
    operationId: string;
    attemptId: string;
    binding: AttemptBinding;
    expectedRevision: number;
    updatedAt: string;
};
export type PracticeEvidenceMutationV1 = Base & ({
    kind: 'execution-pointer';
    prepared: PreparedPracticeEvidenceChild;
} | {
    kind: 'code-report';
    report: CodeRunReportV1;
    output?: string;
} | {
    kind: 'code-hint';
    hint: PracticeEvidenceHint;
} | {
    kind: 'step-input';
    text: string;
} | {
    kind: 'step-diagnostic';
    diagnostic: PracticeEvidenceDiagnostic;
} | {
    kind: 'variant';
    variant: PracticeVariantRecoveryV1;
});
export type PracticeEvidenceReceipt = {
    status: 'accepted' | 'duplicate' | 'conflict';
    durable: boolean;
    operationId: string;
    revision: number;
    record: PracticeEvidenceV1 | null;
};
/** Only application source resolvers construct this from approved source material. */
export type PracticeEvidenceSource = {
    binding: AttemptBinding;
    calculation?: CalculationSupport;
    mapping?: MathVariantMappingV1;
};
export type PracticeEvidenceAuthority = {
    attempt: LearningAttempt;
    source?: PracticeEvidenceSource;
    /** Exact diagnostic returned by an explicit service authorization port, never a request flag. */
    modelDiagnostic?: PracticeEvidenceDiagnostic;
    modelHint?: PracticeEvidenceHint;
    preparedChild?: LearningAttempt;
    /** Existing navigation target, resolved independently before a retarget transition. */
    currentPreparedChild?: LearningAttempt;
    /** Actual submitted original resolved only for remediation variant authority. */
    parentAttempt?: LearningAttempt;
};
