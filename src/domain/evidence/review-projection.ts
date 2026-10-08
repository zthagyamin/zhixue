import type {CloudFSRSData} from './contracts';
import type {SCHEDULER_VERSION} from './study-event-v3';
export type ReviewProjection = {
  itemKey: string;
  fsrs: CloudFSRSData;
  dueAt: string;
  schedulerVersion: typeof SCHEDULER_VERSION;
  appliedEventCount: number;
  eventSetHash: string;
  lastReviewedAt?: string;
  source: "rebuilt" | "legacy-baseline";
};
