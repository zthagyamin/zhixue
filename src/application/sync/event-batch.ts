import type {ReviewProjection,StudyAttemptEventV3,StudyEventV3} from '../../domain/evidence';
// @ts-expect-error TS5097: standalone Node contracts.
import {SCHEDULER_VERSION} from '../../domain/evidence/index.ts';
export type AppendOutcome = "inserted" | "duplicate" | "conflict";

export type StudyEventConflict = {
  eventId: string;
  reason: string;
};

export type StudyEventBatchResult = {
  accepted: string[];
  duplicates: string[];
  conflicts: StudyEventConflict[];
  cursor: number;
  projections: ReviewProjection[];
};

export interface ReviewEventStore {
  appendEvent(userId: string, event: StudyEventV3): Promise<AppendOutcome>;
  listItemEvents(userId: string, itemKind: string, itemKey: string): Promise<StudyEventV3[]>;
  /**
   * Persists the projection and returns the canonical projection that actually
   * became durable: an older applied event count returns the newer existing
   * stock, an equal count with an equal event-set hash is an idempotent
   * acknowledgement, and an equal count with a different hash rejects with
   * `projection-event-set-conflict` instead of silently choosing a winner.
   */
  upsertProjection(userId: string, itemKind: string, projection: ReviewProjection): Promise<ReviewProjection>;
  latestCursor(userId: string): Promise<number>;
}

type SchedulingAttempt = StudyAttemptEventV3 & {
  scheduling: NonNullable<StudyAttemptEventV3["scheduling"]>;
};

type AffectedItem = {
  itemKind: string;
  itemKey: string;
};

function isSchedulingAttempt(event: StudyEventV3): event is SchedulingAttempt {
  return event.eventType === "practice-attempt"
    && event.scheduling !== undefined
    && (!event.attempt.correct || event.attempt.stageAfter === 3);
}

function isReplayableEvent(event: StudyEventV3): boolean {
  return event.eventType === "review-baseline" || isSchedulingAttempt(event);
}

function schedulerVersionOf(event: StudyEventV3): unknown {
  return event.eventType === "review-baseline" ? event.schedulerVersion : event.scheduling?.schedulerVersion;
}

function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index].codePointAt(0)!;
    const rightPoint = rightPoints[index].codePointAt(0)!;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
  return leftPoints.length - rightPoints.length;
}

function compareAffectedItems(left: AffectedItem, right: AffectedItem): number {
  const kindComparison = compareUnicodeCodePoints(left.itemKind, right.itemKind);
  return kindComparison === 0 ? compareUnicodeCodePoints(left.itemKey, right.itemKey) : kindComparison;
}

function baselineConflict(events: readonly StudyEventV3[], incoming: StudyEventV3): string | undefined {
  if (incoming.eventType !== "review-baseline") return undefined;
  if (events.some((event) => event.eventId === incoming.eventId)) return undefined;
  if (events.some((event) => event.eventType === "review-baseline")) return "second-baseline";
  if (events.some(isSchedulingAttempt)) return "late-baseline";
  return undefined;
}

function replayableItemEvents(events: readonly StudyEventV3[]): StudyEventV3[] {
  const baseline = events.find((event) => event.eventType === "review-baseline");
  const schedulingAttempts = events.filter(isSchedulingAttempt);
  return baseline === undefined ? schedulingAttempts : [baseline, ...schedulingAttempts];
}

export async function processStudyEventBatch(
  userId: string,
  events: StudyEventV3[],
  store: ReviewEventStore,
  replay:ReviewReplay,
): Promise<StudyEventBatchResult> {
  if (events.length > 50) throw new Error("event-batch-too-large");

  const accepted: string[] = [];
  const duplicates: string[] = [];
  const conflicts: StudyEventConflict[] = [];
  const affectedItems = new Map<string, AffectedItem>();

  for (const event of events) {
    const schedulerVersion = schedulerVersionOf(event);
    if (schedulerVersion !== undefined && schedulerVersion !== SCHEDULER_VERSION) {
      conflicts.push({ eventId: event.eventId, reason: "unsupported-scheduler-version" });
      continue;
    }

    const itemEvents = await store.listItemEvents(userId, event.item.kind, event.item.key);
    const misuse = baselineConflict(itemEvents, event);
    if (misuse !== undefined) {
      conflicts.push({ eventId: event.eventId, reason: misuse });
      continue;
    }

    const outcome = await store.appendEvent(userId, event);
    if (outcome === "conflict") {
      conflicts.push({ eventId: event.eventId, reason: "event-conflict" });
      continue;
    }

    // A duplicate may be a retry after append succeeded but projection persistence failed.
    if (outcome === "duplicate") duplicates.push(event.eventId);
    else accepted.push(event.eventId);
    if (isReplayableEvent(event)) {
      const itemKey = `${event.item.kind}\u0000${event.item.key}`;
      affectedItems.set(itemKey, { itemKind: event.item.kind, itemKey: event.item.key });
    }
  }

  const projections: ReviewProjection[] = [];
  for (const item of [...affectedItems.values()].sort(compareAffectedItems)) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const itemEvents = await store.listItemEvents(userId, item.itemKind, item.itemKey);
      const projection = await replay(replayableItemEvents(itemEvents));
      if (projection === undefined) break;
      try {
        projections.push(await store.upsertProjection(userId, item.itemKind, projection));
        break;
      } catch (error) {
        // Only an equal-count race is recoverable by reading the now-complete event set.
        if (!(error instanceof Error) || error.message !== "projection-event-set-conflict" || attempt === 2) throw error;
      }
    }
  }

  return {
    accepted: accepted.sort(compareUnicodeCodePoints),
    duplicates: duplicates.sort(compareUnicodeCodePoints),
    conflicts: conflicts.sort((left, right) => {
      const eventIdComparison = compareUnicodeCodePoints(left.eventId, right.eventId);
      return eventIdComparison === 0 ? compareUnicodeCodePoints(left.reason, right.reason) : eventIdComparison;
    }),
    cursor: await store.latestCursor(userId),
    projections,
  };
}

export type ReviewReplay=(events:StudyEventV3[])=>Promise<ReviewProjection|undefined>;
