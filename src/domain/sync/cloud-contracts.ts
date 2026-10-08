import type {CloudProgress} from '../evidence';
export type CloudLearningEvent = {
  eventId: string;
  domain: "ielts" | "python" | "differential-review";
  itemKind: "word" | "python" | "due" | "activity";
  itemKey: string;
  eventType: "set-stage" | "python-result" | "due-result" | "activity";
  outcome: "completed" | "needs-review";
  numericValue?: number;

  answeredDelta?: number;
  correctDelta?: number;
  occurredAt: string;
};


export type CloudSyncMetadata = {
  decision: "pending" | "enabled" | "local-only";
  cursor: number;
  lastSyncedAt?: string;
  v3?: StudyEventV3SyncMetadata;
};


export type StudyEventV3SyncMetadata = {
  supported: boolean;
  cursor: number;
  lastCloudAckAt?: string;
  lastBootstrapAt?: string;
  projectionMismatchCount: number;
  lastProjectionMismatchAt?: string;
};


export type CloudSyncSnapshot = {
  hasProgress: boolean;
  cursor: number;
  progress: CloudProgress;
  syncedAt: string;
};
