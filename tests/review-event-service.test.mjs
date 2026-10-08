import assert from "node:assert/strict";
import test from "node:test";

import { processStudyEventBatch } from "../app/review-event-service.ts";
import { SCHEDULER_VERSION, withStudyEventCoreHash } from "../app/study-event-v3.ts";

const ITEM = { kind: "word", key: "service-word" };

class MemoryReviewEventStore {
  #eventsByUser = new Map();
  #projectionsByUser = new Map();
  projectionWrites = [];

  eventsFor(userId) {
    return [...(this.#eventsByUser.get(userId)?.values() ?? [])];
  }

  projectionsFor(userId) {
    return [...(this.#projectionsByUser.get(userId)?.values() ?? [])];
  }

  async appendEvent(userId, event) {
    const events = this.#eventsByUser.get(userId) ?? new Map();
    const existing = events.get(event.eventId);
    if (existing) return existing.coreHash === event.coreHash ? "duplicate" : "conflict";
    events.set(event.eventId, event);
    this.#eventsByUser.set(userId, events);
    return "inserted";
  }

  async listItemEvents(userId, itemKind, itemKey) {
    return this.eventsFor(userId).filter((event) => event.item.kind === itemKind && event.item.key === itemKey);
  }

  async upsertProjection(userId, itemKind, projection) {
    const projections = this.#projectionsByUser.get(userId) ?? new Map();
    const previous = projections.get(`${itemKind}\u0000${projection.itemKey}`);
    if (previous?.appliedEventCount > projection.appliedEventCount) return previous;
    if (previous?.appliedEventCount === projection.appliedEventCount) {
      if (previous.eventSetHash === projection.eventSetHash) return previous;
      throw new Error("projection-event-set-conflict");
    }
    projections.set(`${itemKind}\u0000${projection.itemKey}`, projection);
    this.#projectionsByUser.set(userId, projections);
    this.projectionWrites.push({ userId, itemKind, projection });
    return projection;
  }

  async latestCursor(userId) {
    return this.eventsFor(userId).length;
  }
}

async function makeEvent(eventId, reviewedAt, overrides = {}) {
  return withStudyEventCoreHash({
    schemaVersion: 3,
    eventId,
    coreHash: "",
    occurredAt: "2026-08-24T09:59:59.000Z",
    domain: "ielts",
    eventType: "practice-attempt",
    item: ITEM,
    attempt: { rating: "good", correct: true, stageBefore: 2, stageAfter: 3 },
    scheduling: { reviewedAt, schedulerVersion: SCHEDULER_VERSION },
    ...overrides,
  });
}

async function makeBaseline(eventId, overrides = {}) {
  return withStudyEventCoreHash({
    schemaVersion: 3,
    eventId,
    coreHash: "",
    occurredAt: "2026-08-24T09:59:59.000Z",
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
    ...overrides,
  });
}

// A retry can return the canonical replay without adding a fact or another FSRS transition.
test("same id and hash returns the canonical projection without a second write", async () => {
  const store = new MemoryReviewEventStore();
  const event = await makeEvent("evt-1", "2026-08-24T10:00:00.000Z");
  const first = await processStudyEventBatch("user-a", [event], store);
  const second = await processStudyEventBatch("user-a", [event], store);
  assert.deepEqual(first.accepted, ["evt-1"]);
  assert.deepEqual(second.duplicates, ["evt-1"]);
  assert.deepEqual(second.projections, first.projections);
  assert.equal(store.eventsFor("user-a").length, 1);
  assert.equal(store.projectionWrites.length, 1);
});

test("duplicate delivery repairs a projection that failed after the event became durable", async () => {
  const store = new MemoryReviewEventStore(), event = await makeEvent("repair", "2026-08-24T10:00:00.000Z");
  const persist = store.upsertProjection.bind(store);
  store.upsertProjection = async () => { throw new Error("storage unavailable"); };
  await assert.rejects(processStudyEventBatch("user-a", [event], store), /storage unavailable/);
  assert.deepEqual(store.eventsFor("user-a"), [event]);
  assert.equal(store.projectionWrites.length, 0);
  store.upsertProjection = persist;
  const repaired = await processStudyEventBatch("user-a", [event], store);
  const expected = await processStudyEventBatch("user-a", [event], new MemoryReviewEventStore());
  assert.deepEqual(repaired.duplicates, [event.eventId]);
  assert.deepEqual(repaired.accepted, []);
  assert.deepEqual(repaired.projections, expected.projections);
  assert.equal(store.eventsFor("user-a").length, 1);
  assert.equal(store.projectionWrites.length, 1);
});

test("a concurrent projection rejection re-reads both durable facts before replaying", async () => {
  const store = new MemoryReviewEventStore();
  const first = await makeEvent("race-a", "2026-08-24T10:00:00.000Z");
  const second = await makeEvent("race-b", "2026-08-25T10:00:00.000Z");
  const persist = store.upsertProjection.bind(store); let attempts = 0;
  store.upsertProjection = async (...args) => {
    if (++attempts === 1) {
      await store.appendEvent("user-a", second);
      throw new Error("projection-event-set-conflict");
    }
    return persist(...args);
  };
  const result = await processStudyEventBatch("user-a", [first], store);
  const expected = await processStudyEventBatch("user-a", [second, first], new MemoryReviewEventStore());
  assert.equal(attempts, 2);
  assert.deepEqual(result.projections, expected.projections);
  assert.equal(result.projections[0].appliedEventCount, 2);
  assert.equal(result.cursor, 2);
});

test("persistent projection contention stops after three attempts with every fact intact", async () => {
  const store = new MemoryReviewEventStore(), event = await makeEvent("busy", "2026-08-24T10:00:00.000Z");
  let attempts = 0;
  store.upsertProjection = async () => { attempts++; throw new Error("projection-event-set-conflict"); };
  await assert.rejects(processStudyEventBatch("user-a", [event], store), /projection-event-set-conflict/);
  assert.equal(attempts, 3);
  assert.deepEqual(store.eventsFor("user-a"), [event]);
});

test("unrelated persistence failures are not retried as projection contention", async () => {
  const store = new MemoryReviewEventStore(), event = await makeEvent("failure", "2026-08-24T10:00:00.000Z");
  let attempts = 0;
  store.upsertProjection = async () => { attempts++; throw new Error("integrity failure"); };
  await assert.rejects(processStudyEventBatch("user-a", [event], store), /integrity failure/);
  assert.equal(attempts, 1);
  assert.deepEqual(store.eventsFor("user-a"), [event]);
});

// Catches an event-ID reuse overwriting immutable persisted evidence.
test("same id and different hash is a visible conflict", async () => {
  const store = new MemoryReviewEventStore();
  const original = await makeEvent("evt-1", "2026-08-24T10:00:00.000Z");
  await processStudyEventBatch("user-a", [original], store);
  const result = await processStudyEventBatch("user-a", [await makeEvent("evt-1", "2026-08-25T10:00:00.000Z")], store);
  assert.deepEqual(result.conflicts, [{ eventId: "evt-1", reason: "event-conflict" }]);
  assert.deepEqual(store.eventsFor("user-a"), [original]);
});

// Catches storage identity or item reads that omit the user namespace.
test("users cannot collide or read each other's events", async () => {
  const store = new MemoryReviewEventStore();
  const userAEvent = await makeEvent("user-a-event", "2026-08-24T10:00:00.000Z");
  const userBEvent = await makeEvent("user-b-event", "2026-08-25T10:00:00.000Z", {
    attempt: { rating: "again", correct: false, stageBefore: 1, stageAfter: 1 },
  });
  const userAResult = await processStudyEventBatch("user-a", [userAEvent], store);
  const userBResult = await processStudyEventBatch("user-b", [userBEvent], store);
  assert.equal(store.eventsFor("user-a").length, 1);
  assert.equal(store.eventsFor("user-b").length, 1);
  assert.equal(userAResult.projections[0].appliedEventCount, 1);
  assert.equal(userBResult.projections[0].appliedEventCount, 1);
  assert.notEqual(userAResult.projections[0].eventSetHash, userBResult.projections[0].eventSetHash);
  assert.equal(store.projectionsFor("user-a")[0].eventSetHash, userAResult.projections[0].eventSetHash);
  assert.equal(store.projectionsFor("user-b")[0].eventSetHash, userBResult.projections[0].eventSetHash);
});

// Catches projection writes that omit item kind and collide under the D1 composite identity.
test("same item key in different kinds stores distinct projection identities", async () => {
  const store = new MemoryReviewEventStore();
  const wordEvent = await makeEvent("word-event", "2026-08-24T10:00:00.000Z");
  const pythonEvent = await makeEvent("python-event", "2026-08-24T10:00:00.000Z", {
    domain: "python",
    item: { kind: "python", key: ITEM.key },
  });
  await processStudyEventBatch("user-a", [wordEvent, pythonEvent], store);
  assert.equal(store.projectionsFor("user-a").length, 2);
  assert.deepEqual(
    store.projectionWrites.map(({ itemKind, projection }) => [itemKind, projection.itemKey]).sort(),
    [["python", ITEM.key], ["word", ITEM.key]],
  );
});

// Catches a legacy baseline being rejected before it can seed its item's first scheduler transition.
test("baseline is accepted only before an item has a scheduling event", async () => {
  const store = new MemoryReviewEventStore();
  const accepted = await processStudyEventBatch("user-a", [await makeBaseline("baseline-1")], store);
  await processStudyEventBatch("user-a", [await makeEvent("schedule-1", "2026-08-24T10:00:00.000Z")], store);
  const rejected = await processStudyEventBatch("user-a", [await makeBaseline("baseline-2")], store);
  assert.deepEqual(accepted.accepted, ["baseline-1"]);
  assert.equal(accepted.projections[0].source, "legacy-baseline");
  assert.deepEqual(rejected.conflicts, [{ eventId: "baseline-2", reason: "second-baseline" }]);
  assert.equal(store.eventsFor("user-a").length, 2);
});

// Catches a first baseline being accepted after the item has already entered scheduling.
test("first baseline is rejected after an item has a scheduling event", async () => {
  const store = new MemoryReviewEventStore();
  const schedulingEvent = await makeEvent("schedule-first", "2026-08-24T10:00:00.000Z");
  await processStudyEventBatch("user-a", [schedulingEvent], store);
  const result = await processStudyEventBatch("user-a", [await makeBaseline("late-first-baseline")], store);
  assert.deepEqual(result.conflicts, [{ eventId: "late-first-baseline", reason: "late-baseline" }]);
  assert.deepEqual(store.eventsFor("user-a"), [schedulingEvent]);
  assert.deepEqual(result.projections, []);
  assert.equal(store.projectionWrites.length, 1);
});

// Catches receipt order leaking into the projection created by the service.
test("reversed delivery rebuilds the same projection as chronological delivery", async () => {
  const earlier = await makeEvent("event-a", "2026-08-24T10:00:00.000Z");
  const later = await makeEvent("event-b", "2026-08-26T10:00:00.000Z", {
    attempt: { rating: "hard", correct: true, stageBefore: 2, stageAfter: 3 },
  });
  const chronologicalStore = new MemoryReviewEventStore();
  const reversedStore = new MemoryReviewEventStore();
  const chronological = await processStudyEventBatch("user-a", [earlier, later], chronologicalStore);
  const reversed = await processStudyEventBatch("user-a", [later, earlier], reversedStore);
  const pick = (result) => result.projections[0];
  assert.deepEqual(pick(reversed).fsrs, pick(chronological).fsrs);
  assert.deepEqual(pick(reversed).dueAt, pick(chronological).dueAt);
  assert.deepEqual(pick(reversed).eventSetHash, pick(chronological).eventSetHash);
  assert.equal(reversedStore.projectionWrites.length, 1);
});

// Catches client diagnostic state being treated as the canonical server projection.
test("client projection mismatch does not override server replay", async () => {
  const store = new MemoryReviewEventStore();
  const clean = await makeEvent("event-clean", "2026-08-24T10:00:00.000Z");
  const mismatched = await makeEvent("event-client", "2026-08-25T10:00:00.000Z", {
    attempt: { rating: "hard", correct: true, stageBefore: 2, stageAfter: 3 },
    scheduling: {
      reviewedAt: "2026-08-25T10:00:00.000Z",
      schedulerVersion: SCHEDULER_VERSION,
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
  const result = await processStudyEventBatch("user-a", [clean, mismatched], store);
  const projection = result.projections[0];
  assert.notEqual(projection.dueAt, "2030-01-01T00:00:00.000Z");
  assert.notEqual(projection.fsrs.stability, 999);
  assert.equal(store.projectionsFor("user-a")[0].eventSetHash, projection.eventSetHash);
});

// Catches unsupported scheduler payloads being persisted or being reported as generic duplicates.
test("unsupported scheduler version is rejected without persistence", async () => {
  const store = new MemoryReviewEventStore();
  const event = await makeEvent("unsupported", "2026-08-24T10:00:00.000Z", {
    scheduling: { reviewedAt: "2026-08-24T10:00:00.000Z", schedulerVersion: "unknown-v9" },
  });
  const result = await processStudyEventBatch("user-a", [event], store);
  assert.deepEqual(result.conflicts, [{ eventId: "unsupported", reason: "unsupported-scheduler-version" }]);
  assert.equal(store.eventsFor("user-a").length, 0);
});

// Catches evidence-only intermediate work creating an FSRS projection before a scheduling transition.
test("an unscheduled intermediate event is retained without a projection", async () => {
  const store = new MemoryReviewEventStore();
  const event = await withStudyEventCoreHash({
    schemaVersion: 3,
    eventId: "stage-two",
    coreHash: "",
    occurredAt: "2026-08-24T09:59:59.000Z",
    domain: "ielts",
    eventType: "practice-attempt",
    item: ITEM,
    attempt: { rating: "good", correct: true, stageBefore: 1, stageAfter: 2 },
  });
  const result = await processStudyEventBatch("user-a", [event], store);
  assert.deepEqual(result.accepted, ["stage-two"]);
  assert.deepEqual(result.projections, []);
  assert.equal(store.eventsFor("user-a").length, 1);
  assert.equal(store.projectionWrites.length, 0);
});

// Catches a batch limit bypass that would let an unbounded request use the service directly.
test("event batches over fifty are rejected", async () => {
  const store = new MemoryReviewEventStore();
  const event = await makeEvent("limit", "2026-08-24T10:00:00.000Z");
  await assert.rejects(
    processStudyEventBatch("user-a", Array.from({ length: 51 }, () => event), store),
    /event-batch-too-large/,
  );
});
