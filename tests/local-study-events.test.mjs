import assert from "node:assert/strict";
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {openStudyDb} from '../app/local-study-db.ts';
import test from "node:test";

import {
  localStudyEventKey,
  mergeDownloadedEvent,
  mergeRecordOnPut,
  transitionDelivery,
  putLocalStudyEvent,
  getLocalStudyEvent,
} from "../app/local-study-events.ts";

function baseRecord(overrides = {}) {
  return {
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
    },
    cloud: "pending",
    companion: "pending",
    occurredAt: "2026-08-24T10:00:00.000Z",
    updatedAt: "2026-08-24T10:00:00.000Z",
    ...overrides,
  };
}

test("local event identity is workspace plus event id", () => {
  assert.deepEqual(localStudyEventKey("user:abc", "evt-1"), ["user:abc", "evt-1"]);
});

test("acknowledging cloud leaves Companion pending", () => {
  const next = transitionDelivery({ cloud: "pending", companion: "pending" }, "cloud", "acked");
  assert.deepEqual(next, { cloud: "acked", companion: "pending" });
});

test("a delivery transition changes exactly one target", () => {
  const next = transitionDelivery({ cloud: "pending", companion: "acked" }, "companion", "conflict");
  assert.deepEqual(next, { cloud: "pending", companion: "conflict" });
});

test("putting a fresh record inserts it unchanged", () => {
  const incoming = baseRecord();
  assert.deepEqual(mergeRecordOnPut(undefined, incoming), { record: incoming, outcome: "inserted" });
});

test("putting the same core hash merges only delivery receipts", () => {
  const existing = baseRecord({ cloud: "acked" });
  const incoming = baseRecord({ companion: "acked" });
  const merged = mergeRecordOnPut(existing, incoming);
  assert.equal(merged.outcome, "merged");
  assert.equal(merged.record.event.coreHash, "hash-1");
  assert.equal(merged.record.cloud, "acked");
  assert.equal(merged.record.companion, "acked");
});

test("a conflicting core hash preserves the original immutable event", () => {
  const existing = baseRecord();
  const incoming = baseRecord({ event: { ...baseRecord().event, coreHash: "different-hash" } });
  const merged = mergeRecordOnPut(existing, incoming);
  assert.equal(merged.outcome, "conflict");
  assert.equal(merged.record.event.coreHash, "hash-1");
  assert.equal(merged.record.cloud, "conflict");
  assert.equal(merged.record.companion, "conflict");
});

test("a downloaded event is cloud-acked and does not force Companion delivery", () => {
  const downloaded = baseRecord({ cloud: "acked", companion: "not-required" });
  const merged = mergeDownloadedEvent(undefined, downloaded);
  assert.equal(merged.cloud, "acked");
  assert.equal(merged.companion, "not-required");
});

test("a downloaded event keeps Companion delivery when the local record requires it", () => {
  const existing = baseRecord({ companion: "pending" });
  const downloaded = baseRecord({ cloud: "acked", companion: "not-required" });
  const merged = mergeDownloadedEvent(existing, downloaded);
  assert.equal(merged.cloud, "acked");
  assert.equal(merged.companion, "pending");
});

test("a conflicting downloaded event preserves the local conflict instead of acking", () => {
  const downloaded = baseRecord({ event: { ...baseRecord().event, coreHash: "different-hash" }, cloud: "acked", companion: "not-required" });
  const existing = baseRecord({ cloud: "conflict" });
  const merged = mergeDownloadedEvent(existing, downloaded);
  assert.equal(merged.cloud, "conflict");
  assert.equal(merged.event.coreHash, "hash-1");
  const freshConflict = mergeDownloadedEvent(baseRecord(), downloaded);
  assert.equal(freshConflict.cloud, "conflict");
  assert.equal(freshConflict.companion, "conflict");
});

test('the task-store upgrade preserves existing V3 evidence and workspace records',async()=>{
  globalThis.indexedDB=new IDBFactory();
  const old=await new Promise((resolve,reject)=>{
    const request=indexedDB.open('zhixue-local-study-v1',2);
    request.onupgradeneeded=()=>{
      const database=request.result;
      database.createObjectStore('workspace-records',{keyPath:'id'}).createIndex('workspaceId','workspaceId');
      const store=database.createObjectStore('study-events-v3',{keyPath:['workspaceId','eventId']});
      store.createIndex('by-workspace-occurred',['workspaceId','occurredAt']);
      store.createIndex('by-workspace-cloud',['workspaceId','cloud']);
      store.createIndex('by-workspace-companion',['workspaceId','companion']);
    };
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  const record=baseRecord();
  await new Promise((resolve,reject)=>{
    const tx=old.transaction(['study-events-v3','workspace-records'],'readwrite');
    tx.objectStore('study-events-v3').put(record);
    tx.objectStore('workspace-records').put({id:'old-record',value:'preserve'});
    tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
  });
  old.close();
  const upgraded=await openStudyDb();
  try {
    assert.ok(upgraded.objectStoreNames.contains('task-events-v1'));
    const get=(store,key)=>new Promise((resolve,reject)=>{
      const request=upgraded.transaction(store,'readonly').objectStore(store).get(key);
      request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
    });
    assert.deepEqual(await get('study-events-v3',['user:abc','evt-1']),record);
    assert.deepEqual(await get('workspace-records','old-record'),{id:'old-record',value:'preserve'});
  } finally {upgraded.close();}
});
test('request success followed by transaction abort must not acknowledge a durable V3 event',async()=>{
  globalThis.indexedDB=new IDBFactory();const original=IDBObjectStore.prototype.put;let injected=false;
  IDBObjectStore.prototype.put=function(...args){const request=original.apply(this,args);if(this.name==='study-events-v3'&&!injected){injected=true;request.addEventListener('success',()=>this.transaction.abort(),{once:true});}return request;};
  try{await assert.rejects(putLocalStudyEvent(baseRecord()),/取消|abort/i);}finally{IDBObjectStore.prototype.put=original;}
  assert.equal(injected,true);assert.equal(await getLocalStudyEvent('user:abc','evt-1'),undefined);
});
test('synchronous V3 storage failure rejects and leaves no partial record',async()=>{
  globalThis.indexedDB=new IDBFactory();const original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args){if(this.name==='study-events-v3')throw new DOMException('quota','QuotaExceededError');return original.apply(this,args);};
  try{await assert.rejects(putLocalStudyEvent(baseRecord()),/quota/);}finally{IDBObjectStore.prototype.put=original;}
  assert.equal(await getLocalStudyEvent('user:abc','evt-1'),undefined);
});
