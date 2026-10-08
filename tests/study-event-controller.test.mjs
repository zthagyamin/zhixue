import assert from "node:assert/strict";
import test from "node:test";

import {
  flushStudyEventTargets,
  recordStudyAttempt,
  runManualStudySync,
} from "../app/study-event-controller.ts";
import { SCHEDULER_VERSION } from "../app/study-event-v3.ts";

function makeInput(overrides = {}) {
  return {
    workspaceId: "user:abc",
    domain: "ielts",
    item: { kind: "word", key: "word-1" },
    rating: "good",
    correct: true,
    stageBefore: 2,
    stageAfter: 3,
    reviewedAt: "2026-08-24T10:00:00.000Z",
    isThreeStage: false,
    ...overrides,
  };
}
test('explicitly disabled delivery targets are never called or acknowledged',async()=>{
  for(const delivery of [{cloud:'not-required',companion:'not-required'},{cloud:'pending',companion:'not-required'},{cloud:'not-required',companion:'pending'}]){
    const sent=[],acks=[];let saved=0;
    await recordStudyAttempt(makeInput({delivery}),{persistEvent:async()=>{saved++;},persistProgress:async()=>{},
      sendCloud:async event=>{sent.push('cloud');return{accepted:[event.eventId]};},sendCompanion:async()=>{sent.push('companion');return{status:'accepted',companionReceipt:{durable:true}};},updateDelivery:async(_owner,_id,target)=>acks.push(target)});
    const wanted=Object.keys(delivery).filter(target=>delivery[target]==='pending').sort();assert.equal(saved,1);assert.deepEqual(sent.sort(),wanted);assert.deepEqual(acks.sort(),wanted);
  }
});
test('missing or error cloud responses remain pending instead of being treated as account acceptance',async()=>{
  for(const response of [undefined,{error:'unavailable'}]){const acks=[];await recordStudyAttempt(makeInput({delivery:{cloud:'pending',companion:'not-required'}}),{
    persistEvent:async()=>{},persistProgress:async()=>{},sendCloud:async()=>response,sendCompanion:async()=>{},updateDelivery:async(_owner,_id,target)=>acks.push(target)});
    assert.deepEqual(acks,[]);
  }
});
test('a synchronously failing transport does not prevent independent Companion dispatch',async()=>{
  let companion=0;await recordStudyAttempt(makeInput(),{persistEvent:async()=>{},persistProgress:async()=>{},sendCloud:()=>{throw new Error('transport setup failed');},
    sendCompanion:async()=>{companion++;return{status:'accepted',companionReceipt:{durable:true}};},updateDelivery:async()=>{}});assert.equal(companion,1);
});

test('a durable event with a pending learning-vault projection remains retryable', async () => {
  let localRecord;
  await recordStudyAttempt(makeInput(), {
    persistEvent: async record => { localRecord = record; },
    persistProgress: async () => {},
    sendCloud: async event => ({accepted:[event.eventId]}),
    sendCompanion: async () => ({status:'accepted', projectionStatus:'pending', companionReceipt:{durable:true}}),
    updateDelivery: async (workspaceId,eventId,target,status) => { localRecord[target]=status; },
  });
  assert.equal(localRecord.cloud,'acked');
  assert.equal(localRecord.companion,'pending');
  const replay=await flushStudyEventTargets(localRecord.workspaceId,{
    listPending:async()=>[localRecord], sendCloud:async()=>{throw new Error('cloud already acked');},
    sendCompanion:async()=>({status:'duplicate',projectionStatus:'applied'}),
    updateDelivery:async(workspaceId,eventId,target,status)=>{localRecord[target]=status;},
  });
  assert.equal(replay.deliveries[0].companion,'acked');
});

test("a grade persists one event before progress and sends the same id to both targets", async () => {
  const calls = [];
  const result = await recordStudyAttempt(makeInput(), {
    persistEvent: async (record) => calls.push(["event", record.event.eventId]),
    persistProgress: async () => calls.push(["progress"]),
    sendCloud: async (event) => calls.push(["cloud", event.eventId]),
    sendCompanion: async (payload) => calls.push(["companion", payload.event.eventId]),
    updateDelivery: async () => calls.push(["receipt"]),
  });
  assert.equal(calls[0][0], "event");
  const delivered = calls.filter(([kind]) => kind === "cloud" || kind === "companion");
  assert.equal(new Set(delivered.map(([, id]) => id)).size, 1);
  assert.equal(result.event.eventId, delivered[0][1]);
  assert.ok(calls.some(([kind]) => kind === "progress"));
});

test("manual sync downloads cloud events even when this browser has nothing to upload", async () => {
  const calls = [];
  const result = await runManualStudySync({
    flushLegacy: async () => { calls.push("legacy"); },
    flushV3: async () => { calls.push("v3"); },
    bootstrap: async () => {
      calls.push("download");
      return { supported: true, cursor: 1, projections: [] };
    },
  });
  assert.deepEqual(calls, ["legacy", "v3", "download"]);
  assert.equal(result.cursor, 1);
});

test("an intermediate successful three-stage grade is evidence without a scheduling transition", async () => {
  const calls = [];
  await recordStudyAttempt(makeInput({ rating: "good", correct: true, stageBefore: 1, stageAfter: 2, isThreeStage: true }), {
    persistEvent: async (record) => calls.push(["event", record.event]),
    persistProgress: async () => calls.push(["progress"]),
    sendCloud: async () => calls.push(["cloud"]),
    sendCompanion: async () => calls.push(["companion"]),
    updateDelivery: async () => calls.push(["receipt"]),
  });
  const event = calls.find(([kind]) => kind === "event")[1];
  assert.equal(event.scheduling, undefined);
  assert.equal(event.attempt.rating, "good");
});

test("cloud success retries only Companion", async () => {
  const record = {
    workspaceId: "user:abc",
    eventId: "evt-1",
    event: {
      schemaVersion: 3,
      eventId: "evt-1",
      coreHash: "hash-1",
      occurredAt: "2026-08-24T10:00:00.000Z",
      domain: "ielts",
      eventType: "practice-attempt",
      item: { kind: "word", key: "word-1" },
      attempt: { rating: "good", correct: true, stageBefore: 2, stageAfter: 3 },
      scheduling: { reviewedAt: "2026-08-24T10:00:00.000Z", schedulerVersion: SCHEDULER_VERSION },
    },
    cloud: "pending",
    companion: "pending",
    occurredAt: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z",
  };
  const result = await flushStudyEventTargets("user:abc", {
    listPending: async () => [record],
    sendCloud: async () => ({ accepted: ["evt-1"], duplicates: [], conflicts: [], cursor: 1, projections: [] }),
    sendCompanion: async () => {
      throw new Error("companion offline");
    },
    updateDelivery: async (eventId, target, status) => {
      if (target === "cloud") assert.equal(status, "acked");
      if (target === "companion") throw new Error("companion must stay pending");
    },
  });
  assert.equal(result.deliveries[0].cloud, "acked");
  assert.equal(result.deliveries[0].companion, "pending");
});

test("a server projection mismatch is reported but cannot replace the event", async () => {
  const record = {
    workspaceId: "user:abc",
    eventId: "evt-mismatch",
    event: {
      schemaVersion: 3,
      eventId: "evt-mismatch",
      coreHash: "hash-mismatch",
      occurredAt: "2026-08-24T10:00:00.000Z",
      domain: "ielts",
      eventType: "practice-attempt",
      item: { kind: "word", key: "word-1" },
      attempt: { rating: "good", correct: true, stageBefore: 2, stageAfter: 3 },
      scheduling: {
        reviewedAt: "2026-08-24T10:00:00.000Z",
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
    },
    cloud: "pending",
    companion: "not-required",
    occurredAt: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z",
  };
  const result = await flushStudyEventTargets("user:abc", {
    listPending: async () => [record],
    sendCloud: async () => ({
      accepted: ["evt-mismatch"],
      duplicates: [],
      conflicts: [],
      cursor: 5,
      projections: [{ itemKey: "word-1", dueAt: "2026-08-26T10:00:00.000Z", fsrs: { due: "2026-08-26T10:00:00.000Z", stability: 2.3, difficulty: 4.7, elapsed_days: 0, scheduled_days: 2, learning_steps: 0, reps: 1, lapses: 0, state: 2 }, schedulerVersion: SCHEDULER_VERSION, appliedEventCount: 1, eventSetHash: "server-hash", source: "rebuilt" }],
    }),
    sendCompanion: async () => ({ status: "not-required" }),
    updateDelivery: async () => {},
  });
  assert.equal(result.deliveries[0].cloud, "acked");
  assert.equal(result.projectionMismatches.length, 1);
  assert.equal(result.deliveries[0].event.coreHash, "hash-mismatch");
});

test("a Companion conflict receipt marks the receipt conflicted and stops retrying", async () => {
  const record = {
    workspaceId: "user:abc",
    eventId: "evt-companion-conflict",
    event: {
      schemaVersion: 3,
      eventId: "evt-companion-conflict",
      coreHash: "hash-ccc",
      occurredAt: "2026-08-24T10:00:00.000Z",
      domain: "ielts",
      eventType: "practice-attempt",
      item: { kind: "word", key: "word-1" },
      attempt: { rating: "good", correct: true, stageBefore: 2, stageAfter: 3 },
    },
    cloud: "acked",
    companion: "pending",
    occurredAt: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z",
  };
  const result = await flushStudyEventTargets("user:abc", {
    listPending: async () => [record],
    sendCloud: async () => ({ accepted: [], duplicates: [], conflicts: [], cursor: 0, projections: [] }),
    sendCompanion: async () => ({ status: "conflict" }),
    updateDelivery: async (eventId, target, status) => {
      if (target === "companion") assert.equal(status, "conflict");
    },
  });
  assert.equal(result.deliveries[0].companion, "conflict");
});

test("accepted Companion event is acknowledged only after a durable local receipt", async () => {
  const record = {
    workspaceId: "user:abc",
    eventId: "evt-durable",
    event: {
      schemaVersion: 3,
      eventId: "evt-durable",
      coreHash: "hash-durable",
      occurredAt: "2026-08-24T10:00:00.000Z",
      domain: "ielts",
      eventType: "practice-attempt",
      item: { kind: "word", key: "word-1" },
      attempt: { rating: "good", correct: true, stageBefore: 2, stageAfter: 3 },
    },
    cloud: "acked",
    companion: "pending",
    occurredAt: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z",
  };
  const updates = [];
  const pending = await flushStudyEventTargets("user:abc", {
    listPending: async () => [record],
    sendCloud: async () => ({ accepted: [], duplicates: [], conflicts: [], cursor: 0, projections: [] }),
    sendCompanion: async () => ({ status: "accepted", companionReceipt: { durable: false } }),
    updateDelivery: async (...args) => updates.push(args),
  });
  assert.equal(pending.deliveries[0].companion, "pending");
  assert.equal(updates.length, 0);

  const acked = await flushStudyEventTargets("user:abc", {
    listPending: async () => [record],
    sendCloud: async () => ({ accepted: [], duplicates: [], conflicts: [], cursor: 0, projections: [] }),
    sendCompanion: async () => ({ status: "accepted", companionReceipt: { durable: true, stateProjection: { status: "reviewed" } } }),
    updateDelivery: async (...args) => updates.push(args),
  });
  assert.equal(acked.deliveries[0].companion, "acked");
  assert.equal(updates.at(-1)[3], "acked");
});
