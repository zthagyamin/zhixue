export type AttemptBinding = {
    ownerId: string;
    libraryId: string;
    snapshotId: string;
    itemKey: string;
    contentHash: string;
    groupId: string;
    roundId: string;
};
export type AttemptCheckpoint = {
    phase: 'answering' | 'submitted' | 'feedback' | 'lesson';
    position: number;
    traversed: boolean;
    mode?: 'quiz' | 'recall' | 'code' | 'lesson' | 'paper' | 'calculation' | 'flashcard';
    intent?: 'practice' | 'lesson';
    purpose?: 'first' | 'guided' | 'remediation';
    pluginFields?: Record<string, string>;
    visited?: string[];
    pending?: string[];
    skipped?: string[];
    view?: {
        purpose: 'first' | 'guided' | 'remediation';
        instanceId?: string;
        lessonStep: 'reading' | 'guided' | 'independent';
        paused: boolean;
        referenceSeen: boolean;
    };
    activeSeconds?: number;
    startActiveSeconds?: number;
    targetMinutes?: number;
};
export type AttemptEvaluation = {
    status: 'pending';
    reason: 'offline' | 'invalid' | 'no-reference' | 'not-requested';
    feedback?: string;
} | {
    status: 'resolved';
    rating: 'again' | 'hard' | 'good' | 'easy';
    correct: boolean;
    outcome: 'correct' | 'partial' | 'incorrect';
    source: 'deterministic' | 'model' | 'self-assess';
    feedback: string;
    evaluationHash: string;
    referenceHash: string;
};
export type AttemptSubmission = {
    answer: string;
    answerRevision: number;
    submittedAt: string;
    assistance: 'independent' | 'observed' | 'unknown';
    maxPreHintLevel?: 0 | 1 | 2 | 3;
    answerRevealed?: boolean;
};
export type FormalResolution = {
    eventId: string;
    occurredAt: string;
    evaluationHash: string;
    rating: 'again' | 'hard' | 'good' | 'easy';
    status: 'claimed' | 'linked';
    coreHash: string | null;
    authoritativeRecord: {
        attemptId: string;
        roundId: string;
    } | null;
};
export type LearningAttempt = {
    schemaVersion: 1;
    attemptId: string;
    binding: AttemptBinding;
    parentAttemptId: string | null;
    revision: number;
    answerRevision: number;
    answer: string;
    updatedAt: string;
    /** Immutable first checkpoint time; absent on older aggregates means unknown. */
    startedAt?:string;
    checkpoint: AttemptCheckpoint;
    submitted: AttemptSubmission | null;
    evaluation: AttemptEvaluation;
    formal: FormalResolution | null;
    operations: {
        operationId: string;
        fingerprint: string;
        revision: number;
    }[];
};
type MutationBase = {
    schemaVersion: 1;
    operationId: string;
    attemptId: string;
    binding: AttemptBinding;
    expectedRevision: number;
    updatedAt: string;
};
export type AttemptMutation = MutationBase & ({
    kind: 'checkpoint';
    answer: string;
    checkpoint: AttemptCheckpoint;
    parentAttemptId: string | null;
} | {
    kind: 'submit';
    answerRevision: number;
    assistance: AttemptSubmission['assistance'];
    maxPreHintLevel?: 0 | 1 | 2 | 3;
    answerRevealed?: boolean;
} | {
    kind: 'evaluate';
    answerRevision: number;
    evaluation: AttemptEvaluation;
} | {
    kind: 'claim-formal';
    eventId: string;
    occurredAt: string;
    evaluationHash: string;
    rating: 'again' | 'hard' | 'good' | 'easy';
} | {
    kind: 'link-formal';
    eventId: string;
    coreHash: string;
});
export type AttemptReceipt = {
    status: 'accepted' | 'duplicate' | 'conflict';
    durable: boolean;
    operationId: string;
    revision: number;
    attempt: LearningAttempt | null;
};
export function canonicalAttemptJson(value: unknown): string {
    if (Array.isArray(value))
        return '[' + value.map(canonicalAttemptJson).join(',') + ']';
    if (value !== null && typeof value === 'object')
        return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => JSON.stringify(key) + ':' + canonicalAttemptJson(entry)).join(',') + '}';
    return JSON.stringify(value);
}
