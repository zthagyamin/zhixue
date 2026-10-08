import assert from "node:assert/strict";
import test from "node:test";

import {
  SCHEDULER_VERSION,
  canonicalizeJson,
  computeStudyEventCoreHash,
  parseCloudStudyEventV3,
  studyEventHashInput,
  withStudyEventCoreHash,
} from "../app/study-event-v3.ts";

const base = {
  schemaVersion: 3,
  eventId: "evt-001",
  coreHash: "",
  occurredAt: "2026-08-24T10:00:00.000Z",
  domain: "python",
  eventType: "practice-attempt",
  item: { kind: "python", key: "loops-001", stateHandle: "opaque-1" },
  attempt: { rating: "good", correct: true, stageBefore: 1, stageAfter: 2 },
  scheduling: {
    reviewedAt: "2026-08-24T10:00:00.000Z",
    schedulerVersion: SCHEDULER_VERSION,
  },
};

async function signedBase() {
  return withStudyEventCoreHash(base);
}

// Catches a cross-runtime key-order change that would give replicas different event hashes.
test("canonical JSON recursively sorts object keys and preserves array order", () => {
  assert.equal(
    canonicalizeJson({ z: 1, a: { d: 2, c: ["b", "a"] } }),
    '{"a":{"c":["b","a"],"d":2},"z":1}',
  );
  assert.equal(canonicalizeJson({ "\u{10000}": 1, "\uE000": 2 }), '{"\uE000":2,"\u{10000}":1}');
});

// Catches a floating-point value entering immutable hash input and splitting event identity.
test("canonical JSON rejects non-integer numbers", () => {
  assert.throws(() => canonicalizeJson({ stability: 1.5 }), /non-canonical-json-value/);
});

// Catches local diagnostics or mutable delivery metadata changing an immutable event hash.
test("core hash ignores local context, delivery, and diagnostic client projection", async () => {
  const first = await computeStudyEventCoreHash(base);
  const second = await computeStudyEventCoreHash({
    ...base,
    delivery: { d1: "sent" },
    localContext: { sourceNote: "private.md" },
    scheduling: { ...base.scheduling, clientStateAfter: { due: "changed", stability: 1.5 } },
  });
  assert.equal(first, second);
  assert.deepEqual(studyEventHashInput({ ...base, coreHash: "different", delivery: { d1: "sent" } }), studyEventHashInput(base));
});

// Catches an accidental algorithm or UTF-8 encoding change that stable-but-wrong hashes would miss.
test("core hash is the SHA-256 digest of the canonical UTF-8 input", async () => {
  assert.equal(
    await computeStudyEventCoreHash(base),
    "06332c1a3c0c0c8741df77d956d02d95ac482a03cf0c899faafcc29d4e8f2af9",
  );
});

// Catches a baseline-state omission that would let different imported scheduler states share a hash.
test("core hash binds the entire canonical baseline state", async () => {
  const baseline = {
    schemaVersion: 3,
    eventId: "baseline-001",
    coreHash: "",
    occurredAt: "2026-08-24T10:00:00.000Z",
    domain: "python",
    eventType: "review-baseline",
    item: { kind: "python", key: "loops-001" },
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
  };
  const changed = { ...baseline, baselineState: { ...baseline.baselineState, reps: 4 } };
  assert.notEqual(await computeStudyEventCoreHash(baseline), await computeStudyEventCoreHash(changed));
});

// Catches acceptance of a tampered event whose declared identity no longer matches immutable content.
test("cloud parser accepts a valid signed event and rejects a changed core field", async () => {
  const signed = await signedBase();
  assert.deepEqual(await parseCloudStudyEventV3(signed), signed);
  await assert.rejects(
    parseCloudStudyEventV3({ ...signed, domain: "ielts" }),
    /invalid-study-event-core-hash/,
  );
});

for (const forbidden of ["sourceNote", "stateRef", "vaultPath", "localPath", "apiKey", "token"]) {
  // Catches a nested local path or credential leaking through a future payload extension.
  test(`cloud parser rejects nested ${forbidden}`, async () => {
    await assert.rejects(
      parseCloudStudyEventV3({ ...base, item: { ...base.item, nested: { [forbidden]: "secret" } } }),
      /forbidden-cloud-field/,
    );
  });
}

// Catches schema expansion or malformed primitive fields being silently accepted by D1 receivers.
test("cloud parser rejects unknown object keys and non-canonical core values", async () => {
  const signed = await signedBase();
  await assert.rejects(parseCloudStudyEventV3({ ...signed, delivery: { d1: "sent" } }), /unknown-study-event-field/);
  await assert.rejects(parseCloudStudyEventV3({ ...signed, item: { ...signed.item, extra: true } }), /unknown-study-event-field/);
  await assert.rejects(
    parseCloudStudyEventV3({ ...signed, attempt: { ...signed.attempt, stageBefore: 1.5 } }),
    /invalid-study-event-v3/,
  );
});

// Catches oversized identifiers/payloads and ambiguous date forms that are unsafe to replay consistently.
test("cloud parser enforces cloud size limits and canonical ISO dates", async () => {
  const signed = await signedBase();
  await assert.rejects(parseCloudStudyEventV3({ ...signed, eventId: "e".repeat(201) }), /invalid-study-event-v3/);
  await assert.rejects(parseCloudStudyEventV3({ ...signed, occurredAt: "2026-08-24T10:00:00Z" }), /invalid-study-event-v3/);
  await assert.rejects(
    parseCloudStudyEventV3({ ...signed, item: { ...signed.item, stateHandle: "h".repeat(33_000) } }),
    /study-event-too-large/,
  );
});

// Fixed vectors shared with companion/server.py (see tests/test_companion.py
// test_cross_runtime_core_hash_fixed_vector). If either runtime changes its
// canonical encoding, both vectors must be regenerated together.
test("practice-attempt core hash matches the cross-runtime fixed vector", async () => {
  const event = {
    schemaVersion: 3,
    eventId: "evt-cross-check-001",
    coreHash: "",
    occurredAt: "2026-08-24T10:00:00.000Z",
    domain: "ielts",
    eventType: "practice-attempt",
    item: { kind: "word", key: "word:alpha", stateHandle: "opaque-abc" },
    attempt: { rating: "good", correct: true, stageBefore: 2, stageAfter: 3 },
    scheduling: {
      reviewedAt: "2026-08-24T10:00:00.000Z",
      schedulerVersion: SCHEDULER_VERSION,
      clientStateAfter: { due: "2030-01-01T00:00:00.000Z", stability: 999 },
    },
  };
  assert.equal(
    await computeStudyEventCoreHash(event),
    "927607d9f11df9e8f0fcc4b48f52f3fe421a04c9ecbd874b34dc79b2543c314d",
  );
});

test("review-baseline core hash matches the cross-runtime fixed vector", async () => {
  const event = {
    schemaVersion: 3,
    eventId: "baseline:fixed-vector-001",
    coreHash: "",
    occurredAt: "2026-08-24T10:00:00.000Z",
    domain: "ielts",
    eventType: "review-baseline",
    item: { kind: "word", key: "word:alpha" },
    schedulerVersion: SCHEDULER_VERSION,
    baselineState: {
      due: "2026-08-24T10:00:00.000Z",
      stability: "2.3",
      difficulty: "4.7",
      elapsedDays: 0,
      scheduledDays: 2,
      learningSteps: 0,
      reps: 1,
      lapses: 0,
      state: 2,
      lastReview: "2026-08-20T10:00:00.000Z",
    },
  };
  assert.equal(
    await computeStudyEventCoreHash(event),
    "931f82dada2a79bc06604ea60ed917638f24477cae43dc53aa117d1317ed1851",
  );
});
