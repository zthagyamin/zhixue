import type { AttemptMutation, AttemptReceipt, LearningAttempt } from '../../domain/learning-attempt';
export type AttemptScope = {
    userId: string;
    libraryId: string;
};
export interface LearningAttemptStorePort {
    supported(): Promise<boolean>;
    read(scope: AttemptScope, attemptId: string): Promise<LearningAttempt | null>;
    list(scope: AttemptScope, groupId?: string): Promise<LearningAttempt[]>;
    mutate(scope: AttemptScope, mutation: AttemptMutation): Promise<AttemptReceipt>;
}
export interface AttemptCloudPort {
    read(attemptId: string): Promise<LearningAttempt | null>;
    list(groupId?: string): Promise<LearningAttempt[]>;
    mutate(mutation: AttemptMutation): Promise<AttemptReceipt>;
}
export type VerifiedFormalAttemptEvent = {
    eventId: string;
    coreHash: string;
    itemKey: string;
    contentHash: string;
    reviewedAt: string;
    rating: string;
    snapshotId?: string;
    authoritativeRecord?: {
        attemptId: string;
        roundId: string;
    };
};
export type LocalAttemptOptions = {
    verifyFormalEvent?: (eventId: string) => Promise<VerifiedFormalAttemptEvent | null>;
};
