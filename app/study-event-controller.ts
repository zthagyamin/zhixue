// @ts-expect-error TS5097: standalone Node source contracts.
export {flushStudyEventTargets} from '../src/application/sync/index.ts';
export type {FlushTargetsDependencies} from '../src/application/sync';
// @ts-expect-error TS5097: standalone Node source contracts.
import {isDurableCompanionAck} from '../src/domain/sync/index.ts';
import type {CloudBatchResult,CompanionActivityResult} from '../src/domain/sync';
export type {CloudBatchResult,CompanionActivityResult,ProjectionMismatch} from '../src/domain/sync';
import type { CloudFSRSData } from "./cloud-sync-types";
import type { LocalStudyEventRecord } from "./local-study-events";
import type { CloudReviewProjection } from "./sync-v3-api";
import type { ReviewProjection } from "./review-projection";
import type { StudyEventV3 } from "./study-event-v3";
import type {StudyAttemptInput,StudyAttemptResult,StudyAttemptDependencies} from '../src/application/study-attempt';
export type {StudyAttemptInput,StudyAttemptResult,StudyAttemptDependencies} from '../src/application/study-attempt';
// @ts-expect-error TS5097: Node strip-types requires an explicit runtime TypeScript extension.
import { scheduleReviewAt } from "./fsrs-scheduler.ts";
// @ts-expect-error TS5097: Node strip-types requires an explicit runtime TypeScript extension.
import { replayReviewEvents, toCanonicalFSRSData } from "./review-projection.ts";
// @ts-expect-error TS5097: Node strip-types requires an explicit runtime TypeScript extension.
import { SCHEDULER_VERSION, canonicalizeJson, withStudyEventCoreHash } from "./study-event-v3.ts";

/**
 * Records one graded interaction as a single immutable StudyEventV3.
 *
 * Ordering contract: the event is persisted before any progress or UI update;
 * the client projection is computed only through the deterministic scheduler;
 * cloud and Companion deliveries are attempted independently and each receipt
 * is persisted independently, so a network failure never blocks local study.
 */
export async function recordStudyAttempt(
  input: StudyAttemptInput,
  dependencies: StudyAttemptDependencies,
): Promise<StudyAttemptResult> {
  input=structuredClone(input);
  if(input.identity&&input.identity.reviewedAt!==input.reviewedAt)throw new Error('study-attempt-identity-time-mismatch');
  // The three-stage rule: only non-three-stage grades, failed three-stage
  // grades, and three-stage completions move the review clock.
  const shouldSchedule = !input.isThreeStage || !input.correct || input.stageAfter >= 3;
  const clientStateAfter = shouldSchedule
    ? scheduleReviewAt(input.currentFsrs, input.rating, input.reviewedAt)
    : undefined;

  const event = await withStudyEventCoreHash({
    schemaVersion: 3,
    eventId: input.identity?.eventId??crypto.randomUUID(),
    coreHash: "",
    occurredAt: input.reviewedAt,
    domain: input.domain,
    eventType: "practice-attempt",
    item: {
      kind: input.item.kind,
      key: input.item.key,
      ...(input.item.stateHandle === undefined ? {} : { stateHandle: input.item.stateHandle }),
    },
    attempt: {
      rating: input.rating,
      correct: input.correct,
      stageBefore: input.stageBefore,
      stageAfter: input.stageAfter,
    },
    ...(shouldSchedule
      ? {
          scheduling: {
            reviewedAt: input.reviewedAt,
            schedulerVersion: SCHEDULER_VERSION,
            ...(clientStateAfter === undefined ? {} : { clientStateAfter }),
          },
        }
      : {}),
  } satisfies StudyEventV3);

  const record: LocalStudyEventRecord = {
    workspaceId: input.workspaceId,
    eventId: event.eventId,
    event,
    ...(input.localContext === undefined ? {} : { localContext: input.localContext }),
    cloud: input.delivery?.cloud ?? "pending",
    companion: input.delivery?.companion ?? "pending",
    occurredAt: event.occurredAt,
    updatedAt: input.identity?.reviewedAt??new Date().toISOString(),
  };

  // 1) Immutable event first.
  await dependencies.persistEvent(record);
  // 2) Progress and UI only after persistence succeeded.
  await dependencies.persistProgress({ event, clientStateAfter });
  // 3) Independent deliveries; each receipt is persisted independently and a
  //    failure leaves the target pending for a later flush.
  await Promise.all([
    record.cloud!=='pending'?Promise.resolve():Promise.resolve()
      .then(()=>dependencies.sendCloud(event))
      .then(async (result) => {
        const batch = result as CloudBatchResult | undefined;
        const conflict = (batch?.conflicts ?? []).some((entry) => entry.eventId === event.eventId);
        const acknowledged = batch?.error === undefined && ((batch?.accepted ?? []).includes(event.eventId)
          || (batch?.duplicates ?? []).includes(event.eventId));
        if (conflict) {
          await dependencies.updateDelivery(input.workspaceId, event.eventId, "cloud", "conflict");
        } else if (acknowledged) {
          await dependencies.updateDelivery(input.workspaceId, event.eventId, "cloud", "acked");
        }
      })
      .catch(() => undefined),
    record.companion!=='pending'?Promise.resolve():Promise.resolve()
      .then(()=>dependencies.sendCompanion({ event, localContext: input.localContext }))
      .then(async (result) => {
        const receipt = result as CompanionActivityResult | undefined;
        if (receipt?.status === "conflict") {
          await dependencies.updateDelivery(input.workspaceId, event.eventId, "companion", "conflict");
        } else if (isDurableCompanionAck(receipt)) {
          await dependencies.updateDelivery(input.workspaceId, event.eventId, "companion", "acked");
        }
      })
      .catch(() => undefined),
  ]);

  return { event, clientStateAfter };
}

// ---------------------------------------------------------------------------
// Task 8: approved legacy FSRS baselines and second-browser cursor bootstrap.
// ---------------------------------------------------------------------------

export type StudyEventV3SyncMetadata = {
  supported: boolean;
  cursor: number;
  lastCloudAckAt?: string;
  lastBootstrapAt?: string;
  projectionMismatchCount: number;
  lastProjectionMismatchAt?: string;
};

export type LegacyBaselineProgress = {
  fsrsData?: Record<string, CloudFSRSData>;
};

function defaultKindFor(itemKey: string): "word" | "python" | "due" {
  if (itemKey.startsWith("python:")) return "python";
  if (itemKey.startsWith("due:")) return "due";
  return "word";
}

function domainForKind(kind: "word" | "python" | "due"): StudyEventV3["domain"] {
  return kind === "python" ? "python" : kind === "due" ? "differential-review" : "ielts";
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Creates one review-baseline event per approved legacy FSRS item. Event IDs
 * are derived deterministically from the item identity, scheduler version, and
 * the canonical baseline state, so repeating the same approval is idempotent.
 * The core hash is computed after the deterministic event id is assigned.
 */
export async function createLegacyBaselineEvents(
  progress: LegacyBaselineProgress,
  approvalTime: string,
  options: { workspaceId?: string; kindFor?: (itemKey: string) => "word" | "python" | "due" } = {},
): Promise<StudyEventV3[]> {
  const kindFor = options.kindFor ?? defaultKindFor;
  const events: StudyEventV3[] = [];
  for (const [itemKey, fsrs] of Object.entries(progress.fsrsData ?? {})) {
    const kind = kindFor(itemKey);
    const baselineState = toCanonicalFSRSData(fsrs);
    const identity = canonicalizeJson([options.workspaceId ?? "", kind, itemKey, SCHEDULER_VERSION, baselineState]);
    const eventId = `baseline:${await sha256Hex(identity)}`;
    const event = await withStudyEventCoreHash({
      schemaVersion: 3,
      eventId,
      coreHash: "",
      occurredAt: approvalTime,
      domain: domainForKind(kind),
      eventType: "review-baseline",
      item: { kind, key: itemKey },
      schedulerVersion: SCHEDULER_VERSION,
      baselineState,
    } satisfies StudyEventV3);
    events.push(event);
  }
  return events.sort((left, right) => (left.eventId < right.eventId ? -1 : left.eventId > right.eventId ? 1 : 0));
}

export type BootstrapProbeResult = {
  supported: boolean;
  cursor: number;
  events: Array<{ sequence: number; event: StudyEventV3 }>;
  projections: CloudReviewProjection[];
};

export type BootstrapDependencies = {
  probe: (after: number) => Promise<BootstrapProbeResult>;
  mergeDownloaded: (record: LocalStudyEventRecord) => Promise<void>;
  readMetadata: () => Promise<StudyEventV3SyncMetadata>;
  writeMetadata: (metadata: StudyEventV3SyncMetadata) => Promise<void>;
  listItemEvents: (itemKind: string, itemKey: string) => Promise<StudyEventV3[]>;
};

export type ManualStudySyncDependencies = {
  flushLegacy: () => Promise<void>;
  flushV3: () => Promise<void>;
  bootstrap: () => Promise<{ supported: boolean; cursor: number; projections: ReviewProjection[] }>;
};

/**
 * A manual sync is bidirectional. Upload drains may be empty while the cloud
 * still has newer events for this browser, so the download bootstrap always
 * runs after the two upload drains.
 */
export async function runManualStudySync(
  dependencies: ManualStudySyncDependencies,
): Promise<{ supported: boolean; cursor: number; projections: ReviewProjection[] }> {
  await dependencies.flushLegacy();
  await dependencies.flushV3();
  return dependencies.bootstrap();
}

function downloadedRecord(workspaceId: string, event: StudyEventV3): LocalStudyEventRecord {
  return {
    workspaceId,
    eventId: event.eventId,
    event,
    cloud: "acked",
    companion: "not-required",
    occurredAt: event.occurredAt,
    updatedAt: new Date().toISOString(),
  };
}

function replayableItemEvents(events: readonly StudyEventV3[]): StudyEventV3[] {
  const baseline = events.find((event) => event.eventType === "review-baseline");
  const attempts = events.filter(
    (event): event is Extract<StudyEventV3, { eventType: "practice-attempt" }> & { scheduling: NonNullable<Extract<StudyEventV3, { eventType: "practice-attempt" }>["scheduling"]> } =>
      event.eventType === "practice-attempt"
      && event.scheduling !== undefined
      && (!event.attempt.correct || event.attempt.stageAfter === 3),
  );
  return baseline === undefined ? attempts : [baseline, ...attempts];
}

/**
 * Downloads v3 events from the cloud cursor, merges each as a cloud-acked local
 * record, and recomputes the affected local projections. The persisted cursor
 * advances only after every local write of the page succeeds, so a failed
 * merge is retried from the same cursor. An unsupported route keeps v0.6.1
 * behavior active and reports `supported: false` instead of creating v3 writes.
 */
export async function bootstrapStudyEventsV3(
  workspaceId: string,
  dependencies: BootstrapDependencies,
): Promise<{ supported: boolean; cursor: number; projections: ReviewProjection[] }> {
  const metadata = await dependencies.readMetadata();
  if (!metadata.supported) return { supported: false, cursor: metadata.cursor, projections: [] };

  let after = metadata.cursor;
  const affected = new Map<string, { itemKind: string; itemKey: string }>();
  let nextCursor = after;
  let more = true;
  while (more) {
    const page = await dependencies.probe(after);
    if (!page.supported) {
      return { supported: false, cursor: after, projections: [] };
    }
    for (const { event } of page.events) {
      await dependencies.mergeDownloaded(downloadedRecord(workspaceId, event));
      affected.set(`${event.item.kind}\u0000${event.item.key}`, { itemKind: event.item.kind, itemKey: event.item.key });
    }
    nextCursor = page.cursor;
    more = page.events.length > 0 && nextCursor > after;
    after = nextCursor;
  }

  const projections: ReviewProjection[] = [];
  for (const item of affected.values()) {
    const events = await dependencies.listItemEvents(item.itemKind, item.itemKey);
    const projection = await replayReviewEvents(replayableItemEvents(events));
    if (projection !== undefined) projections.push(projection);
  }

  await dependencies.writeMetadata({
    ...metadata,
    supported: true,
    cursor: nextCursor,
    lastBootstrapAt: new Date().toISOString(),
  });
  return { supported: true, cursor: nextCursor, projections };
}
