import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory,IDBKeyRange,IDBDatabase,IDBObjectStore} from 'fake-indexeddb';
import {createAccountPreview} from './fixtures/account-preview.mjs';
import {createAccountStudyClient} from '../app/account-study-client.ts';
import * as local from '../app/local-account-study.ts';
import {dashboardFunction} from './fixtures/dashboard-functions.mjs';
import {foldCoreReceiptNotice} from '../app/study-submission-status.ts';
import {studyHash} from '../app/account-study-content.ts';
async function fixture(t){
  assert.equal(typeof local.materializeStudyHistory,'function');globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
  const origin='http://127.0.0.1:3004',f=await createAccountPreview({origin,scenario:'completed-15'});t.after(()=>f.close());
  const client=createAccountStudyClient({expectedUserId:f.userId,fetcher:(url,init)=>{const headers=new Headers(init?.headers);headers.set('Origin',origin);return f.handle(new Request(new URL(url,origin),{...init,headers}));}});
  const loaded=await client.load(),workspaceId=`account:${f.userId}`,libraryId=loaded.bundle.snapshot.libraryId;await local.putLocalStudySnapshot(workspaceId,loaded.bundle,0);
  return{loaded,workspaceId,libraryId,apply:(value=loaded,current=()=>true)=>local.materializeStudyHistory(workspaceId,libraryId,value.bundles,value.records,value.writebacks,current)};
}
function countStorage(){let transactions=0,writes=0;const transaction=IDBDatabase.prototype.transaction,put=IDBObjectStore.prototype.put,add=IDBObjectStore.prototype.add;
  IDBDatabase.prototype.transaction=function(...args){transactions++;return transaction.apply(this,args);};
  for(const [name,fn]of [['put',put],['add',add]])IDBObjectStore.prototype[name]=function(...args){writes++;return fn.apply(this,args);};
  return{state:()=>({transactions,writes}),restore(){IDBDatabase.prototype.transaction=transaction;IDBObjectStore.prototype.put=put;IDBObjectStore.prototype.add=add;}};
}
test('one batch durably materializes all original records and their independent core receipts',async t=>{
  const f=await fixture(t),counter=countStorage();let receipts;
  try{receipts=await f.apply();assert.ok(counter.state().transactions<=2,'no per-record transactions');}finally{counter.restore();}
  const records=await local.listLocalStudyRecords(f.workspaceId,f.libraryId);assert.equal(records.length,45);assert.equal(receipts.length,45);assert.ok(records.every(row=>row.cloud==='acked'&&row.writeback==='pending'));
});
test('unchanged 45-record materialization has bounded transactions and no physical writes',async t=>{
  const f=await fixture(t);await f.apply();const counter=countStorage();try{await f.apply();assert.ok(counter.state().transactions<=2);assert.equal(counter.state().writes,0);}finally{counter.restore();}
});
test('a mid-batch failure does not leave partial acknowledgements and retry is idempotent',async t=>{
  const f=await fixture(t),put=IDBObjectStore.prototype.put;let writes=0;IDBObjectStore.prototype.put=function(...args){if(this.name==='account-study-records-v1'&&++writes===4)throw new DOMException('Synthetic abort','QuotaExceededError');return put.apply(this,args);};
  try{await assert.rejects(f.apply());}finally{IDBObjectStore.prototype.put=put;}
  assert.deepEqual(await local.listLocalStudyRecords(f.workspaceId,f.libraryId),[]);await f.apply();assert.equal((await local.listLocalStudyRecords(f.workspaceId,f.libraryId)).length,45);
});
test('a changed owner cannot publish a downloaded batch',async t=>{
  const f=await fixture(t);await assert.rejects(f.apply(f.loaded,()=>false),/workspace|owner/);assert.deepEqual(await local.listLocalStudyRecords(f.workspaceId,f.libraryId),[]);
});
test('an invalid receipt or record cannot partly materialize an otherwise valid batch',async t=>{
  const f=await fixture(t),broken=structuredClone(f.loaded);broken.records.at(-1).record.event.attempt.stageAfter=0;
  await assert.rejects(f.apply(broken));assert.deepEqual(await local.listLocalStudyRecords(f.workspaceId,f.libraryId),[]);
});

test('the actual Dashboard reuses one batch and folds receipt notices once without resetting a frozen exercise',async t=>{
  const f=await fixture(t);await f.apply();let notices=0;const env={accountWorkspaceId:f.workspaceId,workspaceId:f.workspaceId,accountModeEpoch:{current:0},accountApplyEpoch:{current:0},eventMutation:{current:0},taskWorkspaceRef:{current:f.workspaceId},
    accountLoadedRef:{current:f.loaded},accountBundlesRef:{current:new Map()},accountAttemptActiveRef:{current:true},accountPendingLoadedRef:{current:null},
    getLocalStudySnapshot:local.getLocalStudySnapshot,putLocalStudySnapshot:local.putLocalStudySnapshot,cacheLocalStudySnapshot:local.cacheLocalStudySnapshot,materializeStudyHistory:local.materializeStudyHistory,
    setLastStudyReceipts:fn=>{notices++;fn({});},foldCoreReceiptNotice,setAccountReadStatus(){},setAccountLoaded(){assert.fail('active view must stay frozen');}};
  const counter=countStorage();try{assert.equal(await dashboardFunction('applyAccountLoaded',env)(f.loaded,0),false);assert.ok(counter.state().transactions<=3);assert.equal(counter.state().writes,0);}finally{counter.restore();}
  assert.equal(notices,1);assert.equal(env.accountPendingLoadedRef.current,f.loaded);
});

test('higher applied receipts survive old input and a newer downgrade aborts the whole batch',async t=>{
  const f=await fixture(t);await f.apply();const record=f.loaded.records[0].record,receipt={schemaVersion:1,libraryId:f.libraryId,eventId:record.event.eventId,envelopeHash:record.envelopeHash,target:'companion',status:'applied',revision:4};await local.applyLocalStudyReceipt(f.workspaceId,receipt);
  await f.apply({...f.loaded,writebacks:[{delivery:{...receipt,status:'received',revision:3}}]});assert.equal((await local.getLocalStudyRecord(f.workspaceId,f.libraryId,record.event.eventId)).writeback,'applied');
  await assert.rejects(f.apply({...f.loaded,writebacks:[{delivery:{...receipt,status:'received',revision:5}}]}),/regression/);assert.equal((await local.getLocalStudyRecord(f.workspaceId,f.libraryId,record.event.eventId)).receipts.companion.payload.revision,4);
});
test('same-revision receipt conflicts and unknown targets cannot acknowledge a batch',async t=>{
  const f=await fixture(t);await f.apply();const record=f.loaded.records[0].record,receipt={schemaVersion:1,libraryId:f.libraryId,eventId:record.event.eventId,envelopeHash:record.envelopeHash,target:'companion',status:'blocked',reason:'one',revision:3};await local.applyLocalStudyReceipt(f.workspaceId,receipt);
  await assert.rejects(f.apply({...f.loaded,writebacks:[{delivery:{...receipt,reason:'two'}}]}),/receipt-conflict/);
  await assert.rejects(f.apply({...f.loaded,writebacks:[{delivery:{...receipt,eventId:'missing'}}]}),/unknown-study-record/);
});

test('a receipt arriving after validation is retained after bounded batch CAS retry',async t=>{
  const f=await fixture(t);await f.apply();const record=f.loaded.records[0].record,receipt={schemaVersion:1,libraryId:f.libraryId,eventId:record.event.eventId,envelopeHash:record.envelopeHash,target:'companion',status:'applied',revision:4},hash=await studyHash(receipt);
  const transaction=IDBDatabase.prototype.transaction;let injected=false;
  IDBDatabase.prototype.transaction=function(names,mode,...args){
    if(!injected&&this.name==='zhixue-account-study-v1'&&mode==='readwrite'&&Array.isArray(names)&&names.includes('account-study-records-v1')&&names.includes('account-study-snapshots-v1')){
      injected=true;const prior=transaction.call(this,['account-study-records-v1'],'readwrite'),store=prior.objectStore('account-study-records-v1'),get=store.get([f.workspaceId,f.libraryId,record.event.eventId]);
      get.onsuccess=()=>{const row=get.result;row.writeback='applied';row.receipts.companion={payload:receipt,hash};store.put(row);};
    }
    return transaction.call(this,names,mode,...args);
  };
  try{await f.apply({...f.loaded,writebacks:[{delivery:{...receipt,status:'received',revision:2}}]});}finally{IDBDatabase.prototype.transaction=transaction;}
  const saved=await local.getLocalStudyRecord(f.workspaceId,f.libraryId,record.event.eventId);assert.equal(injected,true);assert.equal(saved.writeback,'applied');assert.equal(saved.receipts.companion.payload.revision,4);
});
