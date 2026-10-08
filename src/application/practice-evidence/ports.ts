import type { LearningAttempt } from '../../domain/learning-attempt';
import type { PracticeEvidenceAuthority, PracticeEvidenceDiagnostic, PracticeEvidenceHint, PracticeEvidenceMutationV1, PracticeEvidenceReceipt, PracticeEvidenceSource, PracticeEvidenceV1 } from '../../domain/practice-evidence';
export type PracticeEvidenceScope = {
    ownerId: string;
    libraryId: string;
};
export interface PracticeEvidenceAttemptPort {
    readAttempt(attemptId: string): Promise<LearningAttempt | null>;
    resolveSource?(attempt: LearningAttempt): Promise<PracticeEvidenceSource | null>;
}
/** Supplied only to controlled service composition; no user-selected trust flags. */
export interface PracticeEvidenceServiceWritePort {
    resolveModelDiagnostic?(input: {
        attempt: LearningAttempt;
        source: PracticeEvidenceSource;
        diagnostic: PracticeEvidenceDiagnostic;
    }): Promise<PracticeEvidenceDiagnostic | null>;
    resolveModelHint?(input: {
        attempt: LearningAttempt;
        hint: PracticeEvidenceHint;
    }): Promise<PracticeEvidenceHint | null>;
}
export interface PracticeEvidenceStorePort {
    read(attemptId: string): Promise<PracticeEvidenceV1 | null>;
    mutate(mutation: PracticeEvidenceMutationV1): Promise<PracticeEvidenceReceipt>;
}
export type PracticeEvidenceCloudResponse = PracticeEvidenceReceipt | {
    status: 'unsupported';
} | {
    status: 'incompatible';
};
export interface PracticeEvidenceCloudPort {
    mutate(mutation: PracticeEvidenceMutationV1): Promise<PracticeEvidenceCloudResponse>;
    list?(): Promise<unknown[]>;
}
export type PracticeEvidenceOutbox = {
    key: string[];
    scope: string[];
    mutation: PracticeEvidenceMutationV1;
    fingerprint: string;
};
export type PracticeEvidenceSyncState = 'device-only' | 'cloud-acked' | 'cloud-conflict' | 'cloud-unsupported' | 'cloud-incompatible';
export type PracticeEvidenceResolvedAuthority = PracticeEvidenceAuthority;
