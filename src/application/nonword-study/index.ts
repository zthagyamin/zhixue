export type NonWordOutcome = {
    status: 'correct' | 'partial' | 'incorrect' | 'undetermined';
    source: 'deterministic' | 'model' | 'self-assess';
    explanation: string;
    rating?: 'again' | 'hard' | 'good' | 'easy';
};
export type NonWordHostScope = {
    nativeMathIdentity?: import('../../domain/math-study').NativeMathIdentity;
    nativeMathPresentation?: import('../../domain/math-study').NativeMathItem;
    nativeMathCapture?: import('../../domain/math-study').NativeMathCapture;
    nativeCourseIdentity?: import('../../domain/course-study').NativeCourseIdentity;
    nativeCoursePresentation?: import('../../domain/course-study').NativeCourseItem;
    nativeCourseCapture?: import('../../domain/course-study').NativeCourseCapture;
    courseReference?: {item:import('../../domain/sync').StudyItemVersion;snapshot:import('../../domain/sync').StudySnapshot};
    workspaceId: string;
    ownerId: string;
    libraryId: string;
    snapshotId: string;
    itemKey: string;
    contentHash: string;
    groupId: string;
    roundId: string;
    cloud: boolean;
    temporary?: boolean;
    day?: string;
    members?: import('./round-session').RoundSourceMember[];
};
export type NonWordMode = 'recall' | 'quiz' | 'code' | 'calculation' | 'flashcard';
export type NonWordRuntimePort = {
    practice?:import('../practice-evidence').PracticeLearningPort;
    session: ReturnType<typeof import('./session').createNonWordSession>;
    purpose: 'first' | 'guided' | 'remediation';
    status: () => Promise<string>;
    afterWrite: () => Promise<void>;
    synchronize?: () => Promise<void>;
    groupSeconds?: () => Promise<number>;
    subscribeStatus?: (listener: () => void) => () => void;
};
/** A plugin expresses learner intent. The host owns storage, models and formal events. */
export interface NonWordLearningPort {
    readonly practice?:import('../practice-evidence').PracticeLearningPort;
    readonly course?: import('../course-study').CourseLearningPort;
    readonly attemptId?: string;
    readonly ready: boolean;
    readonly purpose: 'first' | 'guided' | 'remediation';
    readonly intent: 'review' | 'learn';
    readonly submitted?: boolean;
    readonly submittedHintLevel?: number;
    readonly answerRevealed?: boolean;
    /** Returns identity only after this exact code has a durable submission. */
    prepareExecution?: (answer:string)=>Promise<import('../../domain/code-execution').CodeRunIdentity>;
    recordExecutionReport?: (report:import('../../domain/code-execution').CodeRunReportV1,output?:string)=>Promise<void>;
    recordHint?: (state: {
        schemaVersion: 1;
        attemptId: string;
        maxPreHintLevel: number;
    }) => Promise<void>;
    submit(answer: string): Promise<void>;
    assess(outcome: NonWordOutcome): Promise<void>;
    waitForReview(reason: string): Promise<void>;
    continuePending(): Promise<void>;
    recordRemediation?: (answer: string, outcome: NonWordOutcome) => Promise<void>;
    startRemediation?: () => Promise<void>;
    startVariant?: (seed:number)=>Promise<void>;
    finishRemediation?: () => Promise<void>;
}
// @ts-expect-error TS5097: standalone Node contracts.
export { createNonWordSession } from './session.ts';
export type { AttemptRepository } from './session';
// @ts-expect-error TS5097: standalone Node contracts.
export { createNonWordRoundSession, validNonWordRoundMembers } from './round-session.ts';
export type { RoundSourceMember, NonWordRoundScope, RoundTraversal, RoundCursorInput, NonWordRoundState } from './round-session';
// @ts-expect-error TS5097: standalone Node contracts.
export { continueNonWordRound, reopenNonWordPendingRound } from './round-flow.ts';
export type { NonWordRoundPort } from './round-flow';
// @ts-expect-error TS5097: standalone Node contracts.
export { assertPendingCanPublish } from './reconcile.ts';
export type { OriginalOfficialEvidence } from './reconcile';
// @ts-expect-error TS5097: standalone Node contracts.
export {createContinuationCoordinator} from './continuation.ts';
export type {ContinuationGroup} from './continuation-storage';
// @ts-expect-error TS5097: standalone Node contracts.
export {createNonWordExecutionCoordinator,recordNonWordAuxiliary} from './execution.ts';
