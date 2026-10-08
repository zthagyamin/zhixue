import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";

import { drizzle } from "drizzle-orm/d1";

import { processStudyEventBatch } from "../app/review-event-service.ts";
import { replayReviewEvents } from "../app/review-projection.ts";
import { SCHEDULER_VERSION, withStudyEventCoreHash } from "../app/study-event-v3.ts";
import * as schema from "../db/schema.ts";

const syncApi = await import("../app/sync-v3-api.ts").catch(() => ({}));
const handleStudyEventsV3Get = syncApi.handleStudyEventsV3Get;
const handleStudyEventsV3Post = syncApi.handleStudyEventsV3Post;
const createSyncRouteHandlers = syncApi.createSyncRouteHandlers;

test('bound history authenticates the expected owner before creating storage and caps pages at 20',async()=>{
  assert.equal(typeof syncApi.handleBoundStudyEventsV3Get,'function');let creates=0;
  const wrong=await syncApi.handleBoundStudyEventsV3Get(new Request('https://fixture.test/api/sync/study-events-v3?expectedUserId=user-a'),auth('user-b'),()=>{creates++;return fakeV3Store();});
  assert.equal(wrong.status,409);assert.equal(creates,0);
  let limit;const store={...fakeV3Store(),listEventsAfter:async(_user,_after,value)=>{limit=value;return[];}};
  const response=await syncApi.handleBoundStudyEventsV3Get(new Request('https://fixture.test/api/sync/study-events-v3?expectedUserId=user-a&limit=100'),auth('user-a'),()=>store);
  assert.equal(limit,20);assert.match(response.headers.get('cache-control'),/no-store/);assert.equal((await response.json()).protocol,'zhixue-native-history-v1');
});

test('bound D1 history keeps the first user-specific fence while other accounts and new records grow',async()=>{
  assert.equal(typeof syncApi.handleBoundStudyEventsV3Get,'function');const {store,sqlite}=await openDatabase();
  try{
    for(let i=0;i<21;i++){await store.appendEvent('user-a',await makeEvent(`bound-a-${i}`,'2026-08-24T10:00:00.000Z'));await store.appendEvent('user-b',await makeEvent(`bound-b-${i}`,'2026-08-24T10:00:00.000Z'));}
    const read=async(after=0,through)=>{const p=new URLSearchParams({expectedUserId:'user-a',after:String(after),limit:'100'});if(through!==undefined)p.set('through',String(through));return (await syncApi.handleBoundStudyEventsV3Get(new Request(`https://fixture.test/api/sync/study-events-v3?${p}`),auth('user-a'),()=>store)).json();};
    const first=await read();assert.equal(first.events.length,20);assert.equal(first.hasMore,true);
    await store.appendEvent('user-a',await makeEvent('bound-later','2026-08-24T10:00:00.000Z'));
    const last=await read(first.nextCursor,first.through);assert.equal(last.events.length,1);assert.equal(last.nextCursor,first.through);assert.equal(last.hasMore,false);assert.equal(last.events[0].event.eventId,'bound-a-20');
    const next=await read(last.nextCursor);assert.equal(next.events.length,1);assert.equal(next.events[0].event.eventId,'bound-later');
  }finally{sqlite.close();}
});
const storeModule = await import("../db/review-event-store.ts").catch(() => ({}));
const D1ReviewEventStore = storeModule.D1ReviewEventStore;

function plainRow(row) {
  return Object.fromEntries(Object.entries(row));
}

class SqliteD1Statement {
  constructor(database, query, parameters = []) {
    this.database = database;
    this.query = query;
    this.parameters = parameters;
  }

  bind(...parameters) {
    return new SqliteD1Statement(this.database, this.query, parameters);
  }

  async all() {
    const results = this.database.prepare(this.query).all(...this.parameters).map(plainRow);
    return { success: true, results, meta: {} };
  }

  async raw() {
    const results = this.database.prepare(this.query).all(...this.parameters).map(plainRow);
    return results.map((row) => Object.values(row));
  }

  async run() {
    const result = this.database.prepare(this.query).run(...this.parameters);
    return {
      success: true,
      results: [],
      meta: { changes: result.changes, last_row_id: Number(result.lastInsertRowid) },
    };
  }

  async first(column) {
    const row = this.database.prepare(this.query).get(...this.parameters);
    if (row === undefined) return null;
    const plain = plainRow(row);
    return column === undefined ? plain : plain[column];
  }
}

class SqliteD1Database {
  constructor(database) {
    this.database = database;
  }

  prepare(query) {
    return new SqliteD1Statement(this.database, query);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.all());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

const ITEM = { kind: "word", key: "api-word" };

async function makeEvent(eventId, reviewedAt, overrides = {}) {
  return withStudyEventCoreHash({
    schemaVersion: 3,
    eventId,
    coreHash: "",
    occurredAt: reviewedAt,
    domain: "ielts",
    eventType: "practice-attempt",
    item: ITEM,
    attempt: { rating: "good", correct: true, stageBefore: 2, stageAfter: 3 },
    scheduling: { reviewedAt, schedulerVersion: SCHEDULER_VERSION },
    ...overrides,
  });
}

function user(userId) {
  return { userId, displayName: userId, email: `${userId}@example.test`, fullName: null };
}

function auth(userId) {
  return async () => (userId === null ? null : user(userId));
}

async function openDatabase(dbPath = ":memory:", createSchema = true) {
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  if (createSchema) {
    sqlite.exec("CREATE TABLE learning_accounts (user_id text PRIMARY KEY);");
    const migration = await readFile(new URL("../drizzle/0003_study_events_v3.sql", import.meta.url), "utf8");
    sqlite.exec(migration);
    sqlite.exec("INSERT INTO learning_accounts (user_id) VALUES ('user-a'), ('user-b')");
  }
  const database = drizzle(new SqliteD1Database(sqlite), { schema });
  return { sqlite, store: new D1ReviewEventStore(database) };
}

function fakeV3Store() {
  return {
    appendEvent: async () => "inserted",
    listItemEvents: async () => [],
    upsertProjection: async () => null,
    latestCursor: async () => 0,
    listEventsAfter: async () => [],
    listProjections: async () => [],
    diagnostics: async () => ({ cursor: 0, eventCount: 0, sourceCounts: { rebuilt: 0, "legacy-baseline": 0 }, schedulerVersion: SCHEDULER_VERSION }),
  };
}
test('new owned V3 action binds browser identity and never falls back to an unbound legacy write',async t=>{
  const {sqlite,store}=await openDatabase();t.after(()=>sqlite.close());const event=await makeEvent('owned-event','2026-09-01T00:00:00.000Z');let current='user-a',authCalls=0;
  const handlers=createSyncRouteHandlers({getUser:async()=>{authCalls++;return user(current);},createStore:async()=>store,legacy:fakeLegacyHandlers([])});
  const request=()=>new Request('https://study.example.test/api/sync',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://study.example.test'},body:JSON.stringify({action:'study-events-v3-bound',expectedUserId:'user-a',events:[event]})});
  const accepted=await handlers.POST(request());assert.equal(accepted.status,200);assert.deepEqual((await accepted.json()).accepted,['owned-event']);assert.equal(authCalls,1);
  current='user-b';const rejected=await handlers.POST(request());assert.equal(rejected.status,403);assert.equal((await rejected.json()).error,'account-mismatch');assert.equal(await store.latestCursor('user-b'),0);
});
test('owned V3 action requires explicit identity, same origin and a closed request shape',async()=>{
  let stores=0;const handlers=createSyncRouteHandlers({getUser:auth('user-a'),createStore:async()=>{stores++;return fakeV3Store();},legacy:fakeLegacyHandlers([])});
  const send=(body,origin='https://study.example.test')=>handlers.POST(new Request('https://study.example.test/api/sync',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({action:'study-events-v3-bound',events:[],...body})}));
  assert.equal((await send({})).status,400);assert.equal((await send({expectedUserId:'user-a',unexpected:true})).status,400);
  assert.equal((await send({expectedUserId:'user-a'},'https://other.example.test')).status,403);assert.equal(stores,0);
});

// ---------------------------------------------------------------------------
// Executable route boundary: authentication identity, v3/legacy dispatch, and
// the legacy rule that authentication happens before body parsing.
// ---------------------------------------------------------------------------

function fakeLegacyHandlers(calls) {
  return {
    getSnapshot: async (_request, currentUser) => {
      calls.push(["snapshot", currentUser.userId]);
      return Response.json({ ok: "snapshot" });
    },
    migrate: async (_body, currentUser) => {
      calls.push(["migrate", currentUser.userId]);
      return Response.json({ ok: "migrate" });
    },
    events: async (_body, currentUser) => {
      calls.push(["events", currentUser.userId]);
      return Response.json({ ok: "events" });
    },
  };
}

test("v3 POST derives identity on the server and ignores a client-supplied userId", async () => {
  assert.equal(typeof createSyncRouteHandlers, "function");
  const calls = [];
  const { POST } = createSyncRouteHandlers({
    getUser: auth("server-user"),
    createStore: async () => {
      calls.push(["store"]);
      return fakeV3Store();
    },
    legacy: fakeLegacyHandlers(calls),
  });

  const event = await makeEvent("evt-attacker", "2026-08-24T10:00:00.000Z");
  const response = await POST(new Request("http://localhost/api/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "study-events-v3", userId: "attacker", events: [event] }),
  }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.accepted, ["evt-attacker"]);
  assert.ok(calls.some((call) => call[0] === "store"));
});

test("legacy and v3 POST authenticate before parsing the body", async () => {
  const calls = [];
  const { POST } = createSyncRouteHandlers({
    getUser: auth(null),
    createStore: async () => {
      throw new Error("store must not be created for an unauthenticated request");
    },
    legacy: fakeLegacyHandlers(calls),
  });

  const malformed = await POST(new Request("http://localhost/api/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  }));
  assert.equal(malformed.status, 401);

  const oversized = await POST(new Request("http://localhost/api/sync", {
    method: "POST",
    headers: { "content-length": "999999", "content-type": "application/json" },
    body: JSON.stringify({ action: "events", events: [] }),
  }));
  assert.equal(oversized.status, 401);
  assert.deepEqual(calls, []);
});

test("route factory dispatches v3 and legacy actions to their executable branches", async () => {
  const calls = [];
  const createStore = async () => {
    calls.push(["store"]);
    return fakeV3Store();
  };
  const { GET, POST } = createSyncRouteHandlers({
    getUser: auth("server-user"),
    createStore,
    legacy: fakeLegacyHandlers(calls),
  });

  const legacyEvents = await POST(new Request("http://localhost/api/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "events", events: [] }),
  }));
  assert.equal(legacyEvents.status, 200);
  assert.deepEqual(await legacyEvents.json(), { ok: "events" });

  const legacyMigrate = await POST(new Request("http://localhost/api/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "migrate", progress: {}, migrationEventId: "m-1" }),
  }));
  assert.equal(legacyMigrate.status, 200);
  assert.deepEqual(await legacyMigrate.json(), { ok: "migrate" });

  const unsupported = await POST(new Request("http://localhost/api/sync", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "does-not-exist" }),
  }));
  assert.equal(unsupported.status, 400);

  const legacySnapshot = await GET(new Request("http://localhost/api/sync"));
  assert.equal(legacySnapshot.status, 200);
  assert.deepEqual(await legacySnapshot.json(), { ok: "snapshot" });

  const v3Snapshot = await GET(new Request("http://localhost/api/sync?schemaVersion=3&after=0"));
  assert.equal(v3Snapshot.status, 200);
  assert.ok(calls.some((call) => call[0] === "store"));

  assert.deepEqual(calls.filter((call) => call[0] === "events"), [["events", "server-user"]]);
  assert.deepEqual(calls.filter((call) => call[0] === "migrate"), [["migrate", "server-user"]]);
  assert.deepEqual(calls.filter((call) => call[0] === "snapshot"), [["snapshot", "server-user"]]);
});

test("v3 POST validates batch size and malformed events before persistence", async () => {
  assert.equal(typeof handleStudyEventsV3Post, "function");
  const { store } = await openDatabase();
  const createStore = () => store;
  const event = await makeEvent("evt-batch", "2026-08-24T10:00:00.000Z");

  const unauthorized = await handleStudyEventsV3Post({ action: "study-events-v3", events: [event] }, auth(null), createStore);
  assert.equal(unauthorized.status, 401);

  const oversized = await handleStudyEventsV3Post(
    { action: "study-events-v3", events: Array.from({ length: 51 }, () => event) },
    auth("user-a"),
    createStore,
  );
  assert.equal(oversized.status, 400);
  assert.deepEqual(await oversized.json(), { error: "event-batch-too-large" });

  const malformed = await handleStudyEventsV3Post(
    { action: "study-events-v3", events: [{ not: "an event" }] },
    auth("user-a"),
    createStore,
  );
  assert.equal(malformed.status, 400);
});

test("v3 GET clamps limits and rejects invalid cursors", async () => {
  const { store } = await openDatabase();
  const createStore = () => store;

  const invalidCursor = await handleStudyEventsV3Get(
    new Request("http://localhost/api/sync?schemaVersion=3&after=-1"),
    auth("user-a"),
    createStore,
  );
  assert.equal(invalidCursor.status, 400);

  const unauthorized = await handleStudyEventsV3Get(
    new Request("http://localhost/api/sync?schemaVersion=3"),
    auth(null),
    createStore,
  );
  assert.equal(unauthorized.status, 401);

  const empty = await handleStudyEventsV3Get(
    new Request("http://localhost/api/sync?schemaVersion=3&after=0&limit=9999"),
    auth("user-a"),
    createStore,
  );
  assert.equal(empty.status, 200);
  const body = await empty.json();
  assert.equal(body.supported, true);
  assert.equal(body.cursor, 0);
  assert.deepEqual(body.events, []);
});

// ---------------------------------------------------------------------------
// D1 adapter against a real SQLite database through the drizzle D1 driver.
// ---------------------------------------------------------------------------

test("D1 append is idempotent by hash and surfaces same-id conflicts", async () => {
  const { store } = await openDatabase();
  const event = await makeEvent("evt-d1-1", "2026-08-24T10:00:00.000Z");

  assert.equal(await store.appendEvent("user-a", event), "inserted");
  assert.equal(await store.appendEvent("user-a", event), "duplicate");
  assert.equal(await store.appendEvent("user-b", event), "inserted");

  const changed = await makeEvent("evt-d1-1", "2026-08-24T11:00:00.000Z");
  assert.equal(await store.appendEvent("user-a", changed), "conflict");
});

test("D1 upsertProjection returns the persisted canonical projection", async () => {
  const { store } = await openDatabase();
  const first = await makeEvent("evt-p-1", "2026-08-24T10:00:00.000Z");
  const second = await makeEvent("evt-p-2", "2026-08-24T11:00:00.000Z");

  const result = await processStudyEventBatch("user-a", [first, second], store);
  assert.equal(result.accepted.length, 2);
  const projection = result.projections[0];
  assert.equal(projection.itemKey, "api-word");
  assert.equal(projection.appliedEventCount, 2);

  // Same count and same hash is an idempotent acknowledgement; the persisted
  // projection is untouched by the duplicate delivery.
  const replayed = await processStudyEventBatch("user-a", [first, second], store);
  assert.equal(replayed.duplicates.length, 2);
  const persistedAfter = await store.listProjections("user-a", [{ itemKind: "word", itemKey: "api-word" }]);
  assert.deepEqual(persistedAfter[0], { itemKind: "word", ...projection });
});

test("D1 upsertProjection rejects same-count different-hash replays and keeps the newer stock", async () => {
  const { store } = await openDatabase();
  const event = await makeEvent("evt-p-conflict", "2026-08-24T10:00:00.000Z");
  const persisted = (await processStudyEventBatch("user-a", [event], store)).projections[0];
  assert.equal(persisted.appliedEventCount, 1);

  // A stale replay with the same applied event count but a different event set hash must be rejected.
  await assert.rejects(
    store.upsertProjection("user-a", "word", { ...persisted, eventSetHash: "stale-hash" }),
    /projection-event-set-conflict/,
  );

  // A stale projection with an older applied event count returns the newer persisted stock.
  const newer = await store.upsertProjection("user-a", "word", { ...persisted, appliedEventCount: 0 });
  assert.equal(newer.appliedEventCount, 1);
  assert.equal(newer.eventSetHash, persisted.eventSetHash);
});

test("D1 batch recovers a real equal-count race from the complete durable event set", async () => {
  const {store,sqlite}=await openDatabase();
  try {
    const a=await makeEvent('d1-race-a','2026-08-24T10:00:00.000Z'),b=await makeEvent('d1-race-b','2026-08-25T10:00:00.000Z');
    const read=store.listItemEvents.bind(store);let reads=0;
    store.listItemEvents=async(...args)=>{
      const snapshot=await read(...args);
      if(++reads===2){
        // The other request finishes a one-event projection after this request's read.
        await store.appendEvent('user-a',b);
        await store.upsertProjection('user-a','word',await replayReviewEvents([b]));
      }
      return snapshot;
    };
    const result=await processStudyEventBatch('user-a',[a],store),expected=await replayReviewEvents([b,a]);
    assert.deepEqual(result.projections,[expected]);assert.equal(expected.appliedEventCount,2);
    assert.deepEqual((await read('user-a','word','api-word')).map(event=>event.eventId).sort(),[a.eventId,b.eventId]);
    assert.deepEqual((await store.listProjections('user-a',[{itemKind:'word',itemKey:'api-word'}]))[0],{itemKind:'word',...expected});
  } finally {sqlite.close();}
});

test("D1 durable append with failed projection is repaired on idempotent redelivery", async () => {
  const {store,sqlite}=await openDatabase();
  try {
    const event=await makeEvent('d1-repair','2026-08-24T10:00:00.000Z'),persist=store.upsertProjection.bind(store);
    store.upsertProjection=async()=>{throw new Error('storage unavailable');};
    await assert.rejects(processStudyEventBatch('user-a',[event],store),/storage unavailable/);
    store.upsertProjection=persist;
    const result=await processStudyEventBatch('user-a',[event],store);
    assert.deepEqual(result.duplicates,[event.eventId]);assert.deepEqual(result.accepted,[]);
    assert.deepEqual(result.projections,[await replayReviewEvents([event])]);
    assert.equal((await store.listItemEvents('user-a','word','api-word')).length,1);
  } finally {sqlite.close();}
});

test("reversed delivery through the D1 store rebuilds the same projection", async () => {
  const { store } = await openDatabase();
  const earlier = await makeEvent("evt-rev-a", "2026-08-24T10:00:00.000Z");
  const later = await makeEvent("evt-rev-b", "2026-08-26T10:00:00.000Z", { attempt: { rating: "hard", correct: false, stageBefore: 2, stageAfter: 2 } });

  const chronologicalStore = (await openDatabase()).store;
  await processStudyEventBatch("user-a", [earlier], chronologicalStore);
  const chronological = (await processStudyEventBatch("user-a", [later], chronologicalStore)).projections[0];

  await processStudyEventBatch("user-a", [later], store);
  const reversed = (await processStudyEventBatch("user-a", [earlier], store)).projections[0];

  assert.deepEqual(chronological, reversed);
});

test("D1 cursor download is user-scoped and paginated", async () => {
  const { store } = await openDatabase();
  for (let index = 0; index < 3; index += 1) {
    await store.appendEvent("user-a", await makeEvent(`evt-cursor-${index}`, `2026-08-24T10:0${index}:00.000Z`));
    await store.appendEvent("user-b", await makeEvent(`evt-other-${index}`, `2026-08-24T10:0${index}:00.000Z`));
  }

  const pageOne = await store.listEventsAfter("user-a", 0, 2);
  assert.equal(pageOne.length, 2);
  const pageTwo = await store.listEventsAfter("user-a", pageOne.at(-1).sequence, 2);
  assert.equal(pageTwo.length, 1);
  const otherUserEvents = await store.listEventsAfter("user-b", 0, 10);
  assert.deepEqual(otherUserEvents.map((entry) => entry.event.eventId), ["evt-other-0", "evt-other-1", "evt-other-2"]);

  const projections = await store.listProjections("user-b", [{ itemKind: "word", itemKey: "api-word" }]);
  assert.deepEqual(projections, []);
});

test("D1 projection lookups batch beyond the Cloudflare 100-parameter limit", async () => {
  const { store } = await openDatabase();
  const items = [];
  const events = [];
  for (let index = 0; index < 60; index += 1) {
    const itemKey = `many-${index}`;
    items.push({ itemKind: "word", itemKey });
    events.push(await withStudyEventCoreHash({
      schemaVersion: 3,
      eventId: `evt-many-${index}`,
      coreHash: "",
      occurredAt: "2026-08-24T10:00:00.000Z",
      domain: "ielts",
      eventType: "practice-attempt",
      item: { kind: "word", key: itemKey },
      attempt: { rating: "good", correct: true, stageBefore: 2, stageAfter: 3 },
      scheduling: { reviewedAt: "2026-08-24T10:00:00.000Z", schedulerVersion: SCHEDULER_VERSION },
    }));
  }
  // The batch API accepts at most 50 events, so deliver in two batches.
  await processStudyEventBatch("user-a", events.slice(0, 30), store);
  await processStudyEventBatch("user-a", events.slice(30), store);

  const projections = await store.listProjections("user-a", items);
  assert.equal(projections.length, 60);
  assert.equal(new Set(projections.map((projection) => projection.itemKey)).size, 60);
});

test("concurrent appends on two shared connections never duplicate an event", async () => {
  const dbPath = join(process.env.TEMP ?? ".", `sync-v3-${randomUUID()}.db`);
  const first = await openDatabase(dbPath, true);
  const second = await openDatabase(dbPath, false);
  try {
    const event = await makeEvent("evt-race", "2026-08-24T10:00:00.000Z");
    const [outcomeA, outcomeB] = await Promise.all([
      first.store.appendEvent("user-a", event),
      second.store.appendEvent("user-a", event),
    ]);

    assert.deepEqual([outcomeA, outcomeB].sort(), ["duplicate", "inserted"]);
    const rows = first.sqlite.prepare("SELECT count(*) AS count FROM study_events_v3 WHERE user_id = 'user-a' AND event_id = 'evt-race'").get();
    assert.equal(rows.count, 1);
  } finally {
    first.sqlite.close();
    second.sqlite.close();
    const { rm } = await import("node:fs/promises");
    await rm(dbPath, { force: true });
  }
});

test("concurrent projection upserts never regress the persisted stock", async () => {
  const dbPath = join(process.env.TEMP ?? ".", `sync-v3-proj-${randomUUID()}.db`);
  const first = await openDatabase(dbPath, true);
  const second = await openDatabase(dbPath, false);
  try {
    const evt1 = await makeEvent("evt-u-1", "2026-08-24T10:00:00.000Z");
    await processStudyEventBatch("user-a", [evt1], first.store);

    // A replay sees a newer event set (count 2, hash A); a stale concurrent
    // writer replays an older view (count 1) and races the same upsert.
    const evt2 = await makeEvent("evt-u-2", "2026-08-25T10:00:00.000Z");
    const projectionA = (await processStudyEventBatch("user-a", [evt2], first.store)).projections[0];
    assert.equal(projectionA.appliedEventCount, 2);
    const staleProjection = await replayReviewEvents([evt1]);
    assert.equal(staleProjection.appliedEventCount, 1);

    const [outcomeA, outcomeB] = await Promise.allSettled([
      first.store.upsertProjection("user-a", "word", projectionA),
      second.store.upsertProjection("user-a", "word", staleProjection),
    ]);

    // Both writers must observe the same canonical persisted stock: whichever
    // order the writes landed in, count 2 (the newer replay) must win and the
    // stale count-1 writer must receive that newer projection, not overwrite it.
    for (const outcome of [outcomeA, outcomeB]) {
      assert.equal(outcome.status, "fulfilled");
      assert.equal(outcome.value.appliedEventCount, 2);
      assert.equal(outcome.value.eventSetHash, projectionA.eventSetHash);
    }
    const persisted = (await first.store.listProjections("user-a", [{ itemKind: "word", itemKey: "api-word" }]))[0];
    assert.equal(persisted.appliedEventCount, 2);
    assert.equal(persisted.eventSetHash, projectionA.eventSetHash);
  } finally {
    first.sqlite.close();
    second.sqlite.close();
    const { rm } = await import("node:fs/promises");
    await rm(dbPath, { force: true });
  }
});
