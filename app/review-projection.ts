import type { CloudFSRSData } from "./cloud-sync-types";
// @ts-expect-error TS5097: Node strip-types requires an explicit runtime TypeScript extension.
import { scheduleReviewAt } from "./fsrs-scheduler.ts";
import {
  SCHEDULER_VERSION,
  canonicalizeJson,
  parseCloudStudyEventV3,
  type CanonicalFSRSDataV1,
  type StudyAttemptEventV3,
  type StudyEventV3,
  // @ts-expect-error TS5097: Node strip-types requires an explicit runtime TypeScript extension.
} from "./study-event-v3.ts";

export type {ReviewProjection} from '../src/domain/evidence';
import type {ReviewProjection} from '../src/domain/evidence';

function assertCanonicalIsoDate(value: string): void {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) {
    throw new Error("invalid-canonical-fsrs-date");
  }
}

function assertFiniteNumber(value: number): void {
  if (!Number.isFinite(value)) throw new Error("invalid-canonical-fsrs-number");
}

function assertCloudFSRSNumbers(value: CloudFSRSData): void {
  for (const number of [
    value.stability,
    value.difficulty,
    value.elapsed_days,
    value.scheduled_days,
    value.learning_steps,
    value.reps,
    value.lapses,
    value.state,
  ]) {
    assertFiniteNumber(number);
  }
}

export function toCanonicalFSRSData(value: CloudFSRSData): CanonicalFSRSDataV1 {
  assertCloudFSRSNumbers(value);
  return {
    due: value.due,
    stability: String(value.stability),
    difficulty: String(value.difficulty),
    elapsedDays: value.elapsed_days,
    scheduledDays: value.scheduled_days,
    learningSteps: value.learning_steps,
    reps: value.reps,
    lapses: value.lapses,
    state: value.state,
    ...(value.last_review === undefined ? {} : { lastReview: value.last_review }),
  };
}

export function fromCanonicalFSRSData(value: CanonicalFSRSDataV1): CloudFSRSData {
  assertCanonicalIsoDate(value.due);
  if (value.lastReview !== undefined) assertCanonicalIsoDate(value.lastReview);
  const stability = Number(value.stability);
  const difficulty = Number(value.difficulty);
  assertFiniteNumber(stability);
  assertFiniteNumber(difficulty);
  return {
    due: value.due,
    stability,
    difficulty,
    elapsed_days: value.elapsedDays,
    scheduled_days: value.scheduledDays,
    learning_steps: value.learningSteps,
    reps: value.reps,
    lapses: value.lapses,
    state: value.state,
    ...(value.lastReview === undefined ? {} : { last_review: value.lastReview }),
  };
}

function isSchedulingAttempt(event: StudyEventV3): event is StudyAttemptEventV3 & {
  scheduling: NonNullable<StudyAttemptEventV3["scheduling"]>;
} {
  return event.eventType === "practice-attempt"
    && event.scheduling !== undefined
    && (!event.attempt.correct || event.attempt.stageAfter === 3);
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

function compareReviewedAtThenEventId(left: StudyAttemptEventV3, right: StudyAttemptEventV3): number {
  const reviewedAtComparison = compareUnicodeCodePoints(left.scheduling!.reviewedAt, right.scheduling!.reviewedAt);
  return reviewedAtComparison === 0 ? compareUnicodeCodePoints(left.eventId, right.eventId) : reviewedAtComparison;
}

function validateSingleLeadingBaseline(events: readonly StudyEventV3[]): void {
  const baselinePositions = events.flatMap((event, index) => event.eventType === "review-baseline" ? [index] : []);
  if (baselinePositions.length > 1) throw new Error("second-baseline");
  if (baselinePositions.length === 1 && baselinePositions[0] !== 0) throw new Error("late-baseline");
}

async function hashEventSet(events: readonly StudyEventV3[]): Promise<string> {
  const input = canonicalizeJson(events.map((event) => [event.eventId, event.coreHash]));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function replayReviewEvents(events: StudyEventV3[]): Promise<ReviewProjection | undefined> {
  validateSingleLeadingBaseline(events);

  const baseline = events[0]?.eventType === "review-baseline" ? events[0] : undefined;
  const attempts = events.filter(isSchedulingAttempt).sort(compareReviewedAtThenEventId);
  const ordered: StudyEventV3[] = baseline === undefined ? attempts : [baseline, ...attempts];
  if (ordered.length === 0) return undefined;

  let fsrs = baseline === undefined ? undefined : fromCanonicalFSRSData(baseline.baselineState);
  for (const event of attempts) {
    fsrs = scheduleReviewAt(fsrs, event.attempt.rating, event.scheduling.reviewedAt);
  }
  if (fsrs === undefined) return undefined;

  const lastAttempt = attempts.at(-1);
  return {
    itemKey: ordered[0].item.key,
    fsrs,
    dueAt: fsrs.due,
    schedulerVersion: SCHEDULER_VERSION,
    appliedEventCount: ordered.length,
    eventSetHash: await hashEventSet(ordered),
    ...(lastAttempt === undefined
      ? baseline?.baselineState.lastReview === undefined ? {} : { lastReviewedAt: baseline.baselineState.lastReview }
      : { lastReviewedAt: lastAttempt.scheduling.reviewedAt }),
    source: baseline === undefined ? "rebuilt" : "legacy-baseline",
  };
}

/** Rebuild portable progress from immutable evidence; never infer attempt counters. */
export async function rebuildEventProgress(input: StudyEventV3[]): Promise<{events:StudyEventV3[];itemStages:Record<string,number>;fsrsData:Record<string,CloudFSRSData>}> {
  const unique = new Map<string,StudyEventV3>();
  for (const raw of input) {
    const event = await parseCloudStudyEventV3(raw);
    const previous = unique.get(event.eventId);
    if (previous && previous.coreHash !== event.coreHash) throw new Error('event-conflict');
    unique.set(event.eventId,event);
  }
  const events = [...unique.values()].sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt) || a.eventId.localeCompare(b.eventId));
  const groups = new Map<string,StudyEventV3[]>();
  const itemStages: Record<string,number> = {};
  const fsrsData: Record<string,CloudFSRSData> = {};
  for (const event of events) {
    // The existing UI stores progress by stable item key, including historical kind changes.
    const key = event.item.key;
    groups.set(key,[...(groups.get(key) ?? []),event]);
    if (event.eventType === 'practice-attempt') itemStages[key] = event.attempt.stageAfter;
  }
  for (const [key,group] of groups) {
    const ordered = [...group.filter(event=>event.eventType==='review-baseline'),...group.filter(event=>event.eventType!=='review-baseline')];
    const result = await replayReviewEvents(ordered);
    if (result) fsrsData[key] = result.fsrs;
  }
  return {events,itemStages,fsrsData};
}
