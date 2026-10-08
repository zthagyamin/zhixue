import type { ReactNode } from 'react';
import type { AttemptEvidenceDraft, FSRSRating } from '../../domain/assessment';
import type { NonWordRuntimePort, NonWordRoundPort, NonWordMode, NonWordLearningPort, NonWordRoundState } from '../../application/nonword-study';
export type HostGradeOptions = {
    continuationReceipt?: boolean;
    deferAdvance?: boolean;
    identity?: {
        eventId: string;
        reviewedAt: string;
    };
};
export type HostGradeCallback = (rating: FSRSRating, options?: HostGradeOptions) => void | Promise<unknown>;
export type HostDraft = AttemptEvidenceDraft & {
    write: (field: string, value: unknown) => boolean;
    hasSavedFeedback?: () => boolean;
    continueAfterFeedback?: () => boolean;
    isPending?: () => boolean;
    inputRevision?: () => number;
    markInputRecovered?: (revision: number) => boolean;
};
export type HostDriver = {
    course?:import('../../application/course-study').CourseLearningPort;
    runtime: NonWordRuntimePort;
    restore: () => Record<string, unknown>;
    fields: (values: Record<string, unknown>) => Record<string, string>;
    answer: (values: Record<string, unknown>) => string;
    phase: () => 'answering' | 'submitted' | 'feedback' | 'lesson';
    verifiedCore: () => Promise<string | null>;
    group?: NonWordRoundPort;
    continueGroup?: (result: FSRSRating | 'pending' | 'skipped') => Promise<void>;
};
export type HostProps = {
    temporary?: boolean;
    bindingKey: string;
    mode: NonWordMode;
    draft: HostDraft;
    question?: string;
    reference: string;
    recallConfigured: boolean;
    createDriver: (purpose: 'first' | 'guided' | 'remediation', intent: 'review' | 'learn', parentId?: string, instanceId?: string,taskId?:string) => Promise<HostDriver>;
    renderPlugin: (draft: HostDraft, lifecycle: NonWordLearningPort, onGrade: (rating: FSRSRating, options?: {
        deferAdvance?: boolean;
        identity?: {
            eventId: string;
            reviewedAt: string;
        };
    }) => void | Promise<unknown>) => ReactNode;
    onGrade: (rating: FSRSRating, options?: {
        continuationReceipt?: boolean;
        deferAdvance?: boolean;
        identity?: {
            eventId: string;
            reviewedAt: string;
        };
    }) => void | Promise<unknown>;
    restoreRound?: (state: NonWordRoundState) => boolean;
    continuePending: () => void;
    resumeFormal: (rating: FSRSRating) => void;
    renderMath: (text: string) => ReactNode;
};
