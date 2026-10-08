import assert from "node:assert/strict";
import test from "node:test";

import {
  fromCanonicalFSRSData,
  replayReviewEvents,
  toCanonicalFSRSData,
} from "../app/review-projection.ts";
import { scheduleReviewAt } from "../app/fsrs-scheduler.ts";
import { SCHEDULER_VERSION, withStudyEventCoreHash } from "../app/study-event-v3.ts";

const ITEM = { kind: "word", key: "deterministic-word" };
const OCCURRED_AT = "2026-08-24T09:59:59.000Z";

async function makeSchedulingEvent(eventId, reviewedAt, rating, overrides = {}) {
  return withStudyEventCoreHash({
    schemaVersion: 3,
    eventId,
    coreHash: "",
    occurredAt: OCCURRED_AT,
    domain: "ielts",
    eventType: "practice-attempt",
    item: ITEM,
    attempt: { rating, correct: true, stageBefore: 2, stageAfter: 3 },
    scheduling: { reviewedAt, schedulerVersion: SCHEDULER_VERSION },
    ...overrides,
  });
}

async function makeUnscheduledThreeStageEvent(eventId, stageBefore, stageAfter) {
  return withStudyEventCoreHash({
    schemaVersion: 3,
    eventId,
    coreHash: "",
    occurredAt: OCCURRED_AT,
    domain: "ielts",
    eventType: "practice-attempt",
    item: ITEM,
    attempt: { rating: "good", correct: true, stageBefore, stageAfter },
  });
}

async function makeFailedThreeStageEvent(eventId, reviewedAt) {
  return withStudyEventCoreHash({
    schemaVersion: 3,
    eventId,
    coreHash: "",
    occurredAt: OCCURRED_AT,
    domain: "ielts",
    eventType: "practice-attempt",
    item: ITEM,
    attempt: { rating: "again", correct: false, stageBefore: 1, stageAfter: 1 },
    scheduling: { reviewedAt, schedulerVersion: SCHEDULER_VERSION },
  });
}

async function makeBaseline(eventId) {
  return withStudyEventCoreHash({
    schemaVersion: 3,
    eventId,
    coreHash: "",
    occurredAt: OCCURRED_AT,
    domain: "ielts",
    eventType: "review-baseline",
    item: ITEM,
    schedulerVersion: SCHEDULER_VERSION,
    baselineState: {
      due: "2026-08-25T10:00:00.000Z",
      stability: "1.25",
      difficulty: "5.5",
      elapsedDays: 1,
      scheduledDays: 2,
      learningSteps: 0,
      reps: 3,
      lapses: 0,
      state: 2,
      lastReview: "2026-08-24T10:00:00.000Z",
    },
  });
}

// Catches an implicit clock, changed rating mapping, or a non-frozen default scheduler.
test("a fixed first good transition has the ts-fsrs 5.4.1 default state", () => {
  assert.deepEqual(
    scheduleReviewAt(undefined, "good", "2026-08-24T10:00:00.000Z"),
    {
      due: "2026-08-24T10:10:00.000Z",
      stability: 2.3065,
      difficulty: 2.11810397,
      elapsed_days: 0,
      scheduled_days: 0,
      learning_steps: 1,
      reps: 1,
      lapses: 0,
      state: 1,
      last_review: "2026-08-24T10:00:00.000Z",
    },
  );
});

// Catches either direction of the decimal-string boundary changing persisted FSRS values.
test("canonical FSRS conversion preserves fixed dates counts and decimal values", () => {
  const cloud = {
    due: "2026-08-25T10:00:00.000Z",
    stability: 1.25,
    difficulty: 5.5,
    elapsed_days: 1,
    scheduled_days: 2,
    learning_steps: 0,
    reps: 3,
    lapses: 0,
    state: 2,
    last_review: "2026-08-24T10:00:00.000Z",
  };
  assert.deepEqual(toCanonicalFSRSData(cloud), {
    due: "2026-08-25T10:00:00.000Z",
    stability: "1.25",
    difficulty: "5.5",
    elapsedDays: 1,
    scheduledDays: 2,
    learningSteps: 0,
    reps: 3,
    lapses: 0,
    state: 2,
    lastReview: "2026-08-24T10:00:00.000Z",
  });
  assert.deepEqual(fromCanonicalFSRSData({
    due: "2026-08-25T10:00:00.000Z",
    stability: "1.25",
    difficulty: "5.5",
    elapsedDays: 1,
    scheduledDays: 2,
    learningSteps: 0,
    reps: 3,
    lapses: 0,
    state: 2,
    lastReview: "2026-08-24T10:00:00.000Z",
  }), cloud);
});

// Catches a parser-accepted oversized decimal becoming Infinity in a rebuilt baseline.
test("fromCanonicalFSRSData rejects non-finite converted decimal values", () => {
  const baseline = {
    due: "2026-08-25T10:00:00.000Z",
    stability: "1.25",
    difficulty: "5.5",
    elapsedDays: 1,
    scheduledDays: 2,
    learningSteps: 0,
    reps: 3,
    lapses: 0,
    state: 2,
    lastReview: "2026-08-24T10:00:00.000Z",
  };
  assert.throws(
    () => fromCanonicalFSRSData({ ...baseline, stability: "9".repeat(400) }),
    /invalid-canonical-fsrs-number/,
  );
  assert.throws(
    () => fromCanonicalFSRSData({ ...baseline, difficulty: "9".repeat(400) }),
    /invalid-canonical-fsrs-number/,
  );
});

// Catches ambiguous baseline dates crossing the scheduler boundary without the v3 parser.
test("fromCanonicalFSRSData rejects invalid or non-canonical baseline dates", () => {
  const baseline = {
    due: "2026-08-25T10:00:00.000Z",
    stability: "1.25",
    difficulty: "5.5",
    elapsedDays: 1,
    scheduledDays: 2,
    learningSteps: 0,
    reps: 3,
    lapses: 0,
    state: 2,
    lastReview: "2026-08-24T10:00:00.000Z",
  };
  assert.throws(
    () => fromCanonicalFSRSData({ ...baseline, due: "2026-08-25T10:00:00Z" }),
    /invalid-canonical-fsrs-date/,
  );
  assert.throws(
    () => fromCanonicalFSRSData({ ...baseline, lastReview: "not-a-date" }),
    /invalid-canonical-fsrs-date/,
  );
});

// Catches invalid local numeric state being serialized into a baseline event identity.
test("toCanonicalFSRSData rejects non-finite numeric values", () => {
  const cloud = {
    due: "2026-08-25T10:00:00.000Z",
    stability: 1.25,
    difficulty: 5.5,
    elapsed_days: 1,
    scheduled_days: 2,
    learning_steps: 0,
    reps: 3,
    lapses: 0,
    state: 2,
    last_review: "2026-08-24T10:00:00.000Z",
  };
  assert.throws(() => toCanonicalFSRSData({ ...cloud, stability: Infinity }), /invalid-canonical-fsrs-number/);
  assert.throws(() => toCanonicalFSRSData({ ...cloud, difficulty: Number.NaN }), /invalid-canonical-fsrs-number/);
});

// Catches a transition that is accidentally coupled to delivery time or mutable scheduler state.
test("the same state rating and time produce the same FSRS state", () => {
  const at = "2026-08-24T10:00:00.000Z";
  assert.deepEqual(scheduleReviewAt(undefined, "good", at), scheduleReviewAt(undefined, "good", at));
});

// Catches a silently accepted non-canonical timestamp that cannot be replayed reliably.
test("scheduleReviewAt rejects an invalid review timestamp", () => {
  assert.throws(() => scheduleReviewAt(undefined, "good", "not-a-date"), /invalid-reviewed-at/);
});

// Catches replaying receipt order instead of the event's stable chronological order.
test("replay ignores delivery order", async () => {
  const later = await makeSchedulingEvent("evt-b", "2026-08-26T10:00:00.000Z", "hard");
  const earlier = await makeSchedulingEvent("evt-a", "2026-08-24T10:00:00.000Z", "good");
  assert.deepEqual(
    await replayReviewEvents([later, earlier]),
    await replayReviewEvents([earlier, later]),
  );
});

// Catches an equal-timestamp tie being resolved by receipt order instead of the immutable event ID.
test("replay orders equal timestamps by event ID", async () => {
  const good = await makeSchedulingEvent("evt-a", "2026-08-24T10:00:00.000Z", "good");
  const failed = await makeSchedulingEvent("evt-z", "2026-08-24T10:00:00.000Z", "again", {
    attempt: { rating: "again", correct: false, stageBefore: 1, stageAfter: 1 },
  });
  assert.deepEqual((await replayReviewEvents([failed, good]))?.fsrs, {
    due: "2026-08-24T10:01:00.000Z",
    stability: 0.77508398,
    difficulty: 7.39450274,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: 2,
    lapses: 0,
    state: 1,
    last_review: "2026-08-24T10:00:00.000Z",
  });
});

// Catches locale-dependent collation producing a different replay order on another replica.
test("replay orders equal timestamps by Unicode code point event ID", async () => {
  const good = await makeSchedulingEvent("evt-\uE000", "2026-08-24T10:00:00.000Z", "good");
  const failed = await makeSchedulingEvent("evt-\u{10000}", "2026-08-24T10:00:00.000Z", "again", {
    attempt: { rating: "again", correct: false, stageBefore: 1, stageAfter: 1 },
  });
  assert.deepEqual((await replayReviewEvents([failed, good]))?.fsrs, {
    due: "2026-08-24T10:01:00.000Z",
    stability: 0.77508398,
    difficulty: 7.39450274,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    reps: 2,
    lapses: 0,
    state: 1,
    last_review: "2026-08-24T10:00:00.000Z",
  });
});

// Catches an in-place sort mutating the caller's delivery record.
test("replay does not mutate the caller event array", async () => {
  const later = await makeSchedulingEvent("evt-b", "2026-08-26T10:00:00.000Z", "hard");
  const earlier = await makeSchedulingEvent("evt-a", "2026-08-24T10:00:00.000Z", "good");
  const events = [later, earlier];
  const before = structuredClone(events);
  await replayReviewEvents(events);
  assert.deepEqual(events, before);
});

// Catches intermediate successful evidence advancing FSRS before stage three is completed.
test("intermediate successful three-stage evidence does not schedule", async () => {
  const event = await makeUnscheduledThreeStageEvent("evt-stage-2", 1, 2);
  assert.equal(await replayReviewEvents([event]), undefined);
});

// Catches failures being excluded merely because they did not reach the final stage.
test("a failed three-stage attempt schedules even before the final stage", async () => {
  const event = await makeFailedThreeStageEvent("evt-failed", "2026-08-24T10:00:00.000Z");
  assert.equal((await replayReviewEvents([event]))?.appliedEventCount, 1);
});

// Catches diagnostic client state becoming a source of truth during server-side replay.
test("clientStateAfter is diagnostic only", async () => {
  const clean = await makeSchedulingEvent("evt-diagnostic", "2026-08-24T10:00:00.000Z", "good");
  const diagnostic = await makeSchedulingEvent("evt-diagnostic", "2026-08-24T10:00:00.000Z", "good", {
    scheduling: {
      ...clean.scheduling,
      clientStateAfter: {
        due: "2030-01-01T00:00:00.000Z",
        stability: 999,
        difficulty: 1,
        elapsed_days: 99,
        scheduled_days: 99,
        learning_steps: 9,
        reps: 99,
        lapses: 99,
        state: 2,
      },
    },
  });
  assert.deepEqual(await replayReviewEvents([diagnostic]), await replayReviewEvents([clean]));
});

// Catches a legacy state being accepted after scheduling has already started or more than once.
test("a late or second baseline is rejected", async () => {
  const scheduling = await makeSchedulingEvent("evt-a", "2026-08-24T10:00:00.000Z", "good");
  const baselineOne = await makeBaseline("base-1");
  const baselineTwo = await makeBaseline("base-2");
  await assert.rejects(replayReviewEvents([scheduling, baselineOne]), /late-baseline/);
  await assert.rejects(replayReviewEvents([baselineOne, baselineTwo]), /second-baseline/);
});

// Catches decimal-string conversion or baseline provenance being lost at the FSRS boundary.
test("a leading baseline rebuilds its exact canonical state", async () => {
  const baseline = await makeBaseline("base-state");
  const projection = await replayReviewEvents([baseline]);
  assert.deepEqual(projection, {
    itemKey: "deterministic-word",
    fsrs: {
      due: "2026-08-25T10:00:00.000Z",
      stability: 1.25,
      difficulty: 5.5,
      elapsed_days: 1,
      scheduled_days: 2,
      learning_steps: 0,
      reps: 3,
      lapses: 0,
      state: 2,
      last_review: "2026-08-24T10:00:00.000Z",
    },
    dueAt: "2026-08-25T10:00:00.000Z",
    schedulerVersion: SCHEDULER_VERSION,
    appliedEventCount: 1,
    eventSetHash: "0ae6c966bac00ef571283f8556ef8b57dfd1462bdf7d1544ae7eb27acfe6403b",
    lastReviewedAt: "2026-08-24T10:00:00.000Z",
    source: "legacy-baseline",
  });
});
