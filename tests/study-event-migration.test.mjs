import assert from "node:assert/strict";

import test from "node:test";

import { bootstrapStudyEventsV3, createLegacyBaselineEvents } from "../app/study-event-controller.ts";
import { SCHEDULER_VERSION, withStudyEventCoreHash } from "../app/study-event-v3.ts";
import {readDashboardSource} from './helpers/dashboard-source.mjs';

function fsrsState(overrides = {}) {
  return {
    due: "2026-08-24T10:00:00.000Z",
    stability: 2.3,
    difficulty: 4.7,
    elapsed_days: 0,
    scheduled_days: 2,
    learning_steps: 0,
    reps: 1,
    lapses: 0,
    state: 2,
    ...overrides,
  };
}

function progressWithTwoFsrsItems() {
  return {
    itemStages: {},
    answered: 2,
    correct: 2,
    fsrsData: {
      "word:alpha": fsrsState(),
      "python:loops": fsrsState({ stability: 3.1, reps: 3 }),
    },
  };
}

async function makeSchedulingEvent(eventId, reviewedAt, overrides = {}) {
  return withStudyEventCoreHash({
    schemaVersion: 3,
    eventId,
    coreHash: "",
    occurredAt: reviewedAt,
    domain: "ielts",
    eventType: "practice-attempt",
    item: { kind: "word", key: "word:alpha" },
    attempt: { rating: "good", correct: true, stageBefore: 2, stageAfter: 3 },
    scheduling: { reviewedAt, schedulerVersion: SCHEDULER_VERSION },
    ...overrides,
  });
}

test("approved legacy FSRS creates one baseline per item and is idempotent", async () => {
  const progress = progressWithTwoFsrsItems();
  const first = await createLegacyBaselineEvents(progress, "2026-08-24T10:00:00.000Z");
  const second = await createLegacyBaselineEvents(progress, "2026-08-24T10:00:00.000Z");
  assert.equal(first.length, 2);
  assert.deepEqual(first.map((event) => event.eventId), second.map((event) => event.eventId));
  assert.ok(first.every((event) => event.eventType === "review-baseline"));
  assert.ok(first.every((event) => /^baseline:[0-9a-f]{64}$/.test(event.eventId)));
  assert.ok(first.every((event) => event.coreHash.length === 64));
  const kinds = first.map((event) => event.item.kind).sort();
  assert.deepEqual(kinds, ["python", "word"]);
});

test("baseline event ids change when the underlying state changes", async () => {
  const first = await createLegacyBaselineEvents(progressWithTwoFsrsItems(), "2026-08-24T10:00:00.000Z");
  const changed = await createLegacyBaselineEvents(
    { ...progressWithTwoFsrsItems(), fsrsData: { "word:alpha": fsrsState({ stability: 9.9 }) } },
    "2026-08-24T10:00:00.000Z",
  );
  assert.notEqual(first[0].eventId, changed[0].eventId);
});

async function bootstrapWithEvents(events) {
  const stored = [];
  const metadata = { supported: true, cursor: 0, projectionMismatchCount: 0 };
  const result = await bootstrapStudyEventsV3("user:abc", {
    probe: async (after) => ({
      supported: true,
      cursor: Math.max(after, events.length),
      events: after >= events.length
        ? []
        : events.map((event, index) => ({ sequence: index + 1, event })),
      projections: [],
    }),
    mergeDownloaded: async (record) => {
      stored.push(record.event);
    },
    readMetadata: async () => metadata,
    writeMetadata: async (next) => Object.assign(metadata, next),
    listItemEvents: async () => stored,
  });
  return result;
}

test("bootstrap rebuilds the same due state from reversed downloaded events", async () => {
  const earlier = await makeSchedulingEvent("bootstrap-a", "2026-08-24T10:00:00.000Z");
  const later = await makeSchedulingEvent("bootstrap-b", "2026-08-26T10:00:00.000Z", {
    attempt: { rating: "hard", correct: false, stageBefore: 2, stageAfter: 2 },
  });
  const chronological = await bootstrapWithEvents([earlier, later]);
  const reversed = await bootstrapWithEvents([later, earlier]);
  assert.equal(chronological.supported, true);
  assert.equal(chronological.cursor, 2);
  assert.deepEqual(chronological.projections[0], reversed.projections[0]);
  assert.equal(chronological.projections[0].appliedEventCount, 2);
});

test("bootstrap leaves v0.6.1 behavior active when the v3 route is unsupported", async () => {
  const result = await bootstrapStudyEventsV3("user:abc", {
    probe: async () => ({ supported: false, cursor: 0, events: [], projections: [] }),
    mergeDownloaded: async () => { throw new Error("must not merge without support"); },
    readMetadata: async () => ({ supported: false, cursor: 0, projectionMismatchCount: 0 }),
    writeMetadata: async () => {},
    listItemEvents: async () => [],
  });
  assert.equal(result.supported, false);
  assert.deepEqual(result.projections, []);
});

test("bootstrap advances the cursor only after every local write succeeds", async () => {
  const stored = [];
  const metadata = { supported: true, cursor: 0, projectionMismatchCount: 0 };
  let fail = true;
  await assert.rejects(
    bootstrapStudyEventsV3("user:abc", {
      probe: async () => ({
        supported: true,
        cursor: 2,
        events: [
          { sequence: 1, event: await makeSchedulingEvent("boot-fail-1", "2026-08-24T10:00:00.000Z") },
          { sequence: 2, event: await makeSchedulingEvent("boot-fail-2", "2026-08-25T10:00:00.000Z") },
        ],
        projections: [],
      }),
      mergeDownloaded: async (record) => {
        if (fail) throw new Error("indexeddb full");
        stored.push(record.event);
      },
      readMetadata: async () => metadata,
      writeMetadata: async (next) => Object.assign(metadata, next),
      listItemEvents: async () => stored,
    }),
    /indexeddb full/,
  );
  assert.equal(metadata.cursor, 0);
});

test("legacy queues remain legacy evidence", async () => {
  const source = await readDashboardSource();
  assert.doesNotMatch(source, /pendingActivities[^\n]+withStudyEventCoreHash/);
  assert.doesNotMatch(source, /cloudOutbox[^\n]+withStudyEventCoreHash/);
  assert.match(source, /createLegacyBaselineEvents/);
  assert.match(source, /readBoundStudyHistory/);
});
