import type { FSRSRating } from '../../domain/assessment';
import type { CloudFSRSData, LocalEventContext, StudyEventV3 } from '../../domain/evidence';
import type { DeliveryState, DeliveryTarget, LocalStudyEventRecord } from '../../domain/sync';
import type { AttemptIdentity } from './session';
export type StudyAttemptInput = {
    /** Internal idempotency input; the persisted V3 event shape is unchanged. */
    identity?: AttemptIdentity;
    workspaceId: string;
    domain: "ielts" | "python" | "differential-review";
    item: {
        kind: "word" | "python" | "due";
        key: string;
        stateHandle?: string;
    };
    rating: FSRSRating;
    correct: boolean;
    stageBefore: number;
    stageAfter: number;
    reviewedAt: string;
    isThreeStage: boolean;
    currentFsrs?: CloudFSRSData;
    localContext?: LocalEventContext;
    delivery?: {
        cloud: DeliveryState;
        companion: DeliveryState;
    };
};
export type StudyAttemptResult = {
    event: StudyEventV3;
    clientStateAfter?: CloudFSRSData;
};
export type StudyAttemptDependencies = {
    persistEvent: (record: LocalStudyEventRecord) => Promise<void>;
    persistProgress: (result: StudyAttemptResult) => Promise<void>;
    sendCloud: (event: StudyEventV3) => Promise<unknown>;
    sendCompanion: (payload: {
        event: StudyEventV3;
        localContext?: LocalEventContext;
    }) => Promise<unknown>;
    updateDelivery: (workspaceId: string, eventId: string, target: DeliveryTarget, status: DeliveryState) => Promise<void>;
};
export type StudyAttemptRecordPort = (input: StudyAttemptInput, dependencies: StudyAttemptDependencies) => Promise<StudyAttemptResult>;
