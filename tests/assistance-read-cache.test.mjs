import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory,IDBKeyRange,IDBObjectStore} from 'fake-indexeddb';
import {assistanceView} from './fixtures/assistance-read.mjs';
import {openStudyDb} from '../app/local-study-db.ts';
let api;try{api=await import('../app/assistance-read-cache.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const scope={workspaceId:'account:a',libraryId:'library-a'};
function setup(){assert.equal(typeof api?.createAssistanceReadCache,'function');globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;return api.createAssistanceReadCache();}
test('auxiliary read cache is separately versioned and scoped, including historical library export',async()=>{
  const cache=setup(),view=await assistanceView();assert.equal((await cache.read(scope)).view,null);await cache.commit(scope,view,0);
  assert.deepEqual((await api.createAssistanceReadCache().read(scope)).view,view);assert.equal((await cache.read({...scope,workspaceId:'account:b'})).view,null);
  assert.deepEqual(await cache.exportOwner('account:a'),[view]);assert.deepEqual(await cache.exportOwner('account:b'),[]);
  const old=await openStudyDb();assert.equal(old.version,3);old.close();
});
test('partial or parent-mismatched auxiliary history never advances a cache checkpoint',async()=>{
  const cache=setup(),view=await assistanceView();await cache.commit(scope,view,0);
  await assert.rejects(cache.commit(scope,{...view,summaryThrough:4},1),/incomplete/);
  const changed=structuredClone(view);changed.summaries[0].parent.event.coreHash='f'.repeat(64);await assert.rejects(cache.commit(scope,changed,1));
  assert.deepEqual((await cache.read(scope)).view,view);
});
test('cache write request success followed by abort retains the previous complete view',async()=>{
  const cache=setup(),view=await assistanceView(),put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args){const request=put.apply(this,args);if(this.name==='views')request.addEventListener('success',()=>this.transaction.abort());return request;};
  try{await assert.rejects(cache.commit(scope,view,0),/abort/i);}finally{IDBObjectStore.prototype.put=put;}
  assert.equal((await cache.read(scope)).view,null);
});
test('competing consumers cannot regress or replace a completed view under an old token',async()=>{
  const cache=setup(),view=await assistanceView();await cache.commit(scope,view,0);
  await assert.rejects(cache.commit(scope,view,0),/stale/);await assert.rejects(cache.commit(scope,{...view,summaryThrough:0,summaries:[]},1),/regression/);
  assert.deepEqual((await cache.read(scope)).view,view);
});
test('applied auxiliary receipt requires the same summary and remains terminal',async()=>{
  const cache=setup(),view=await assistanceView(),record=view.summaries[0].record;
  const receipt={schemaVersion:1,receiptId:'applied-one',summaryId:record.summary.summaryId,summaryHash:record.summary.summaryHash,associationHash:record.associationHash,status:'applied',proof:{attemptCoreHash:record.summary.attemptCoreHash,proofHash:'c'.repeat(64),targetCount:2}};
  const first={...view,receiptThrough:2,receipts:[{sequence:2,receipt,writerGrantId:'writer',receivedAt:'2026-09-01T00:02:00.000Z'}]};await cache.commit(scope,first,0);
  const later=structuredClone(first);later.receiptThrough=3;later.receipts.push({sequence:3,receipt:{...receipt,receiptId:'received-later',status:'received'},writerGrantId:'writer',receivedAt:'2026-09-01T00:03:00.000Z'});delete later.receipts[1].receipt.proof;
  await assert.rejects(cache.commit(scope,later,1),/regression/);assert.deepEqual((await cache.read(scope)).view,first);
});
