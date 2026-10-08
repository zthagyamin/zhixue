import type {StudyEventV3,ReviewProjection} from '../../domain/evidence';
import type {ReviewEventStore,StudyEventBatchResult} from './event-batch';
export type SequencedStudyEventV3 = {
  sequence: number;
  event: StudyEventV3;
};

export type CloudReviewProjection = ReviewProjection & {
  itemKind: string;
};

export type CloudDiagnostics = {
  cursor: number;
  eventCount: number;
  lastAckAt?: string;
  sourceCounts: { rebuilt: number; "legacy-baseline": number };
  schedulerVersion: string;
};

export interface SyncV3Store extends ReviewEventStore {
  listEventsAfter(
    userId: string,
    after: number,
    limit: number,
    through?: number,
  ): Promise<SequencedStudyEventV3[]>;
  listProjections(
    userId: string,
    items: ReadonlyArray<{ itemKind: string; itemKey: string }>,
  ): Promise<CloudReviewProjection[]>;
  diagnostics(userId: string): Promise<CloudDiagnostics>;
}
export type ProcessStudyBatch=(owner:string,events:StudyEventV3[],store:ReviewEventStore)=>Promise<StudyEventBatchResult>;
