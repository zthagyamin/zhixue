import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory,IDBKeyRange,IDBObjectStore,IDBDatabase} from 'fake-indexeddb';
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';
import {sealStudyRecord} from '../app/account-study-record.ts';
import {loadWorkspaceRecord,openStudyDb} from '../app/local-study-db.ts';
import {wordBody,snapshotBody,recordBody} from './fixtures/account-study-fixtures.mjs';
import {attempt} from './fixtures/task-event-fixtures.mjs';
let api;
try {api=await import('../app/local-account-study.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;}
function setup(){assert.equal(typeof api?.putLocalStudySnapshot,'function','Durable account study queue must exist');globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;}
async function bundle(overrides={}){const items=[await sealStudyItem(wordBody())];return {items,snapshot:await sealStudySnapshot(snapshotBody(items,overrides))};}
async function initial(){const data=await bundle();await api.putLocalStudySnapshot('account:a',data,0);return sealStudyRecord(await recordBody({contentHash:data.items[0].contentHash}));}
function receipt(record,overrides={}){return {schemaVersion:1,libraryId:record.libraryId,eventId:record.event.eventId,envelopeHash:record.envelopeHash,target:'cloud',status:'acked',revision:1,...overrides};}
async function oldDatabase(){
  return new Promise((resolve,reject)=>{const request=indexedDB.open('zhixue-local-study-v1',3);
    request.onupgradeneeded=()=>{const db=request.result;const rows=db.createObjectStore('workspace-records',{keyPath:'id'});rows.createIndex('workspaceId','workspaceId');
      const events=db.createObjectStore('study-events-v3',{keyPath:['workspaceId','eventId']});
      events.createIndex('by-workspace-occurred',['workspaceId','occurredAt']);events.createIndex('by-workspace-cloud',['workspaceId','cloud']);events.createIndex('by-workspace-companion',['workspaceId','companion']);
      const tasks=db.createObjectStore('task-events-v1',{keyPath:['workspaceId','eventId']});tasks.createIndex('workspaceId','workspaceId');};
    request.onerror=()=>reject(request.error);request.onsuccess=()=>resolve(request.result);});
}
test('additive local migration preserves old progress and event stores',async()=>{
  setup();const old=await oldDatabase();await new Promise((resolve,reject)=>{const tx=old.transaction(['workspace-records','study-events-v3','task-events-v1'],'readwrite');
    tx.objectStore('workspace-records').put({id:'account:a:progress',workspaceId:'account:a',kind:'progress',value:{answered:7},updatedAt:'before'});
    tx.objectStore('study-events-v3').put({workspaceId:'account:a',eventId:'old-event',sentinel:'keep-v3'});
    tx.objectStore('task-events-v1').put({workspaceId:'account:a',eventId:'old-task',sentinel:'keep-task'});
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});old.close();
  await api.putLocalStudySnapshot('account:a',await bundle(),0);
  assert.deepEqual(await loadWorkspaceRecord('account:a','progress',null),{answered:7});
  const db=await openStudyDb();try{for(const [store,id,want] of [['study-events-v3','old-event','keep-v3'],['task-events-v1','old-task','keep-task']]) {
    const row=await new Promise((resolve,reject)=>{const r=db.transaction(store).objectStore(store).get(['account:a',id]);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});assert.equal(row.sentinel,want);
  }}finally{db.close();}
});
test('snapshots are isolated by account and library and retain historical versions',async()=>{
  setup();const first=await bundle();assert.equal(await api.putLocalStudySnapshot('account:a',first,0),'accepted');
  assert.equal(await api.getLocalStudySnapshot('account:b','library-a'),null);assert.equal(await api.getLocalStudySnapshot('account:a','library-b'),null);
  const next=await bundle({snapshotId:'snapshot-b',revision:2});assert.equal(await api.putLocalStudySnapshot('account:a',next,1),'accepted');
  assert.equal(await api.putLocalStudySnapshot('account:a',first,0),'duplicate');
  assert.equal((await api.getLocalStudySnapshot('account:a','library-a')).snapshot.snapshotId,'snapshot-b');
  assert.deepEqual(await api.getLocalStudySnapshot('account:a','library-a','snapshot-a'),first);
});
test('concurrent snapshot publishers cannot overwrite the same base revision',async()=>{
  setup();const a=await bundle(),b=await bundle({snapshotId:'snapshot-b'});
  const results=await Promise.all([api.putLocalStudySnapshot('account:a',a,0),api.putLocalStudySnapshot('account:a',b,0)]);
  assert.deepEqual(results.sort(),['accepted','stale']);
  const saved=await api.getLocalStudySnapshot('account:a','library-a');assert.ok(['snapshot-a','snapshot-b'].includes(saved.snapshot.snapshotId));
  assert.equal(await api.putLocalStudySnapshot('account:a',await bundle({revision:2,snapshotId:'snapshot-c'}),0),'stale');
});
test('tampered bundle and reusing a snapshot ID cannot displace trusted content',async()=>{
  setup();await api.putLocalStudySnapshot('account:a',await bundle(),0);
  const changed=await bundle({revision:2});await assert.rejects(api.putLocalStudySnapshot('account:a',changed,1),/snapshot-conflict/);
  const broken=await bundle({revision:2,snapshotId:'snapshot-b'});broken.items=[];
  await assert.rejects(api.putLocalStudySnapshot('account:a',broken,1),/incomplete/);
  assert.equal((await api.getLocalStudySnapshot('account:a','library-a')).snapshot.revision,1);
});
test('record append is immutable and retries do not create duplicate learning evidence',async()=>{
  setup();const record=await initial();assert.equal(await api.putLocalStudyRecord('account:a',record),'accepted');
  assert.equal(await api.putLocalStudyRecord('account:a',record),'duplicate');
  const changed={...record,roundId:'round-two'};delete changed.envelopeHash;
  await assert.rejects(api.putLocalStudyRecord('account:a',await sealStudyRecord(changed)),/record-conflict/);
  const rows=await api.listLocalStudyRecords('account:a','library-a');assert.equal(rows.length,1);assert.equal(rows[0].record.envelopeHash,record.envelopeHash);
  assert.equal(rows[0].cloud,'pending');assert.equal(rows[0].writeback,'pending');
  assert.deepEqual(await api.listLocalStudyRecords('account:b','library-a'),[]);
});
test('record cannot reference absent snapshots or a different item version',async()=>{
  setup();const record=await initial();await assert.rejects(api.putLocalStudyRecord('account:b',record),/snapshot/);
  const changed={...record,contentHash:'b'.repeat(64)};delete changed.envelopeHash;
  await assert.rejects(api.putLocalStudyRecord('account:a',await sealStudyRecord(changed)),/binding|membership/);
});
test('cloud acknowledgement is not an Obsidian writeback receipt',async()=>{
  setup();const record=await initial();await api.putLocalStudyRecord('account:a',record);
  await api.applyLocalStudyReceipt('account:a',receipt(record));let row=(await api.listLocalStudyRecords('account:a','library-a'))[0];
  assert.equal(row.cloud,'acked');assert.equal(row.writeback,'pending');
  await api.applyLocalStudyReceipt('account:a',receipt(record,{target:'companion',status:'received'}));
  row=(await api.listLocalStudyRecords('account:a','library-a'))[0];assert.equal(row.writeback,'received');
  await api.applyLocalStudyReceipt('account:a',receipt(record,{target:'companion',status:'applied',revision:2}));
  row=(await api.listLocalStudyRecords('account:a','library-a'))[0];assert.equal(row.writeback,'applied');assert.equal(row.cloud,'acked');
});
test('stale receipts cannot regress state and same revision cannot change meaning',async()=>{
  setup();const record=await initial();await api.putLocalStudyRecord('account:a',record);
  const applied=receipt(record,{target:'companion',status:'applied',revision:2});await api.applyLocalStudyReceipt('account:a',applied);
  await api.applyLocalStudyReceipt('account:a',receipt(record,{target:'companion',status:'received',revision:1}));
  await assert.rejects(api.applyLocalStudyReceipt('account:a',{...applied,status:'received'}),/receipt-conflict/);
  await assert.rejects(api.applyLocalStudyReceipt('account:a',{...applied,status:'received',revision:3}),/regression/);
  assert.equal((await api.listLocalStudyRecords('account:a','library-a'))[0].writeback,'applied');
});
test('receipts must match record identity and the target-specific status',async()=>{
  setup();const record=await initial();await api.putLocalStudyRecord('account:a',record);
  await assert.rejects(api.applyLocalStudyReceipt('account:a',receipt(record,{envelopeHash:'b'.repeat(64)})),/binding/);
  await assert.rejects(api.applyLocalStudyReceipt('account:b',receipt(record)),/unknown/);
  await assert.rejects(api.applyLocalStudyReceipt('account:a',receipt(record,{status:'applied'})),/receipt-status/);
  await assert.rejects(api.applyLocalStudyReceipt('account:a',receipt(record,{target:['cloud']})),/target/);
});
test('unavailable storage and invalid account scopes never masquerade as saved',async()=>{
  setup();const data=await bundle();await assert.rejects(api.putLocalStudySnapshot('guest:local',data,0),/account/);
  delete globalThis.indexedDB;await assert.rejects(api.putLocalStudySnapshot('account:a',data,0),/unavailable/);
});
test('an already-loaded v1.10 page can still open its version-3 database after new sync starts',async()=>{
  setup();const old=await oldDatabase();old.close();
  await api.putLocalStudySnapshot('account:a',await bundle(),0);
  const reopened=await oldDatabase();assert.equal(reopened.version,3);reopened.close();
});
async function mutateNewRow(store,key,mutate){
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('zhixue-account-study-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try {await new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite'),table=tx.objectStore(store),r=table.get(key);
    r.onsuccess=()=>{mutate(r.result);table.put(r.result);};tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);tx.onerror=()=>reject(tx.error);});}finally{db.close();}
}
async function abortSuccessfulWrite(storeName,method,run){
  const original=IDBObjectStore.prototype[method];let injected=false;
  IDBObjectStore.prototype[method]=function(...args){const request=original.apply(this,args);
    if(this.name===storeName&&!injected){injected=true;request.addEventListener('success',()=>this.transaction.abort(),{once:true});}return request;};
  try {await run();}finally{IDBObjectStore.prototype[method]=original;}
}
test('historical snapshot dependencies can be cached without rolling the current head back',async()=>{
  setup();const current=await bundle({snapshotId:'snapshot-b',revision:2}),older=await bundle();
  await api.putLocalStudySnapshot('account:a',current,0);
  assert.equal(typeof api.cacheLocalStudySnapshot,'function','Historical snapshots need a head-independent cache');
  await api.cacheLocalStudySnapshot('account:a',older);
  assert.equal((await api.getLocalStudySnapshot('account:a','library-a')).snapshot.snapshotId,'snapshot-b');
  const record=await sealStudyRecord(await recordBody({contentHash:older.items[0].contentHash}));
  assert.equal(await api.putLocalStudyRecord('account:a',record),'accepted');
});
for(const corrupt of [row=>row.bundle.items[0].word.meaning='tampered',row=>row.bundle.items[0].word.extra=undefined]){
  test('duplicate snapshot ACK requires intact stored content, not just metadata hashes',async()=>{
    setup();const data=await bundle();await api.putLocalStudySnapshot('account:a',data,0);
    await mutateNewRow('account-study-snapshots-v1',['account:a','library-a','snapshot-a'],corrupt);
    await assert.rejects(api.putLocalStudySnapshot('account:a',data,0),/integrity/);
  });
}
test('receipt transition validates old evidence before trusting a damaged redundant state',async()=>{
  setup();const record=await initial();await api.putLocalStudyRecord('account:a',record);
  await api.applyLocalStudyReceipt('account:a',receipt(record,{target:'companion',status:'applied',revision:2}));
  await mutateNewRow('account-study-records-v1',['account:a','library-a','event-one'],row=>row.writeback='pending');
  await assert.rejects(api.applyLocalStudyReceipt('account:a',receipt(record,{target:'companion',status:'received',revision:3})),/integrity|regression/);
});
test('simultaneous cloud and Companion receipts retain both independently',async()=>{
  setup();const record=await initial();await api.putLocalStudyRecord('account:a',record);
  await Promise.all([api.applyLocalStudyReceipt('account:a',receipt(record)),api.applyLocalStudyReceipt('account:a',receipt(record,{target:'companion',status:'applied'}))]);
  const row=(await api.listLocalStudyRecords('account:a','library-a'))[0];assert.equal(row.cloud,'acked');assert.equal(row.writeback,'applied');
});
test('snapshot publication is rejected if the transaction aborts after head write succeeds',async()=>{
  setup();await abortSuccessfulWrite('account-study-heads-v1','put',async()=>{
    await assert.rejects(api.putLocalStudySnapshot('account:a',await bundle(),0),/abort/i);
  });assert.equal(await api.getLocalStudySnapshot('account:a','library-a'),null);
});
test('record request success before a transaction abort does not acknowledge persistence',async()=>{
  setup();const record=await initial();await abortSuccessfulWrite('account-study-records-v1','add',async()=>{
    await assert.rejects(api.putLocalStudyRecord('account:a',record),/abort/i);
  });assert.deepEqual(await api.listLocalStudyRecords('account:a','library-a'),[]);
});
test('receipt request success before a transaction abort does not change delivery',async()=>{
  setup();const record=await initial();await api.putLocalStudyRecord('account:a',record);
  await abortSuccessfulWrite('account-study-records-v1','put',async()=>{await assert.rejects(api.applyLocalStudyReceipt('account:a',receipt(record)),/abort/i);});
  assert.equal((await api.listLocalStudyRecords('account:a','library-a'))[0].cloud,'pending');
});
test('account cache clear drops only the view head and preserves recovery snapshots, records and receipts',async()=>{
  setup();const first=await initial();await api.putLocalStudyRecord('account:a',first);await api.applyLocalStudyReceipt('account:a',receipt(first));
  const second=await sealStudyRecord({...await recordBody({contentHash:(await bundle()).items[0].contentHash,originDeviceId:'device-b',event:await attempt('event-two','2026-09-01T00:02:00Z',0,1)} )});
  await api.putLocalStudySnapshot('account:b',await bundle(),0);await api.putLocalStudyRecord('account:b',second);
  const exported=await api.exportLocalAccountStudy('account:a','library-a');assert.equal(exported.snapshots.length,1);assert.equal(exported.records.length,1);assert.equal(exported.records[0].writeback,'pending');
  await api.clearLocalAccountStudy('account:a','library-a');
  assert.deepEqual(await api.exportLocalAccountStudy('account:a','library-a'),exported);
  assert.equal(await api.getLocalStudySnapshot('account:a','library-a'),null);
  assert.ok(await api.getLocalStudySnapshot('account:a','library-a',exported.snapshots[0].snapshot.snapshotId));
  assert.equal((await api.listLocalStudyRecords('account:b','library-a')).length,1);
  assert.ok(await api.getLocalStudySnapshot('account:b','library-a'));
});
test('clearing a read view retains the snapshot for a not-yet-stored journal envelope',async()=>{
  setup();const pending=await initial();await api.clearLocalAccountStudy('account:a','library-a');
  // A submission journal is a separate database: reclamation cannot assume its
  // empty preflight remains empty while this database commits the view clear.
  assert.equal(await api.putLocalStudyRecord('account:a',pending),'accepted');
  assert.deepEqual((await api.listLocalStudyRecords('account:a','library-a'))[0].record,pending);
});
test('local cache clear refuses to destroy the only pending account envelope',async()=>{setup();const record=await initial();await api.putLocalStudyRecord('account:a',record);await assert.rejects(api.clearLocalAccountStudy('account:a','library-a'),/pending-records/);assert.equal((await api.listLocalStudyRecords('account:a','library-a')).length,1);});
test('owner-wide recovery export finds historical libraries even when the active view has been cleared',async()=>{
  setup();const record=await initial();await api.putLocalStudyRecord('account:a',record);await api.applyLocalStudyReceipt('account:a',receipt(record));await api.clearLocalAccountStudy('account:a','library-a');
  const other=await bundle();await api.putLocalStudySnapshot('account:b',other,0);
  const all=await api.exportAllLocalAccountStudy('account:a');assert.equal(all.length,1);assert.equal(all[0].libraryId,'library-a');assert.equal(all[0].records.length,1);
  assert.deepEqual((await api.findLocalAccountStudyRecord('account:a',record.event.eventId)).record,record);
  assert.equal(await api.findLocalAccountStudyRecord('account:b',record.event.eventId),null);
});
test('a point record read verifies the stored receipt and remains scoped to account and library',async()=>{
  setup();assert.equal(typeof api.getLocalStudyRecord,'function');const record=await initial();await api.putLocalStudyRecord('account:a',record);await api.applyLocalStudyReceipt('account:a',receipt(record));
  assert.equal((await api.getLocalStudyRecord('account:a','library-a',record.event.eventId)).cloud,'acked');
  assert.equal(await api.getLocalStudyRecord('account:b','library-a',record.event.eventId),null);
  await mutateNewRow('account-study-records-v1',['account:a','library-a',record.event.eventId],row=>row.receipts.cloud.payload.envelopeHash='f'.repeat(64));
  await assert.rejects(api.getLocalStudyRecord('account:a','library-a',record.event.eventId));
});
test('a pending envelope arriving between clear checks is protected by the deletion transaction',async()=>{
  setup();const record=await initial();await api.putLocalStudyRecord('account:a',record);await api.applyLocalStudyReceipt('account:a',receipt(record));
  const next=await sealStudyRecord(await recordBody({contentHash:record.contentHash,roundId:'another-round',attemptId:'another-attempt',event:await attempt('arriving-event','2026-09-01T00:02:00Z',0,1)}));
  const original=IDBDatabase.prototype.transaction;let inserted=false;
  IDBDatabase.prototype.transaction=function(names,mode,...rest){
    if(!inserted&&this.name==='zhixue-account-study-v1'&&mode==='readwrite'&&Array.isArray(names)&&names.includes('account-study-heads-v1')&&names.includes('account-study-records-v1')){
      inserted=true;const tx=original.call(this,'account-study-records-v1','readwrite');tx.objectStore('account-study-records-v1').add({workspaceId:'account:a',libraryId:'library-a',eventId:next.event.eventId,record:next,cloud:'pending',writeback:'pending',receipts:{cloud:null,companion:null}});
    }
    return original.call(this,names,mode,...rest);
  };
  try{await assert.rejects(api.clearLocalAccountStudy('account:a','library-a'),/pending-records/);}finally{IDBDatabase.prototype.transaction=original;}
  assert.equal(inserted,true);assert.equal((await api.listLocalStudyRecords('account:a','library-a')).length,2);
});
