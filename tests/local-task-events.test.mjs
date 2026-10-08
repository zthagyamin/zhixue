import assert from 'node:assert/strict';
import test,{beforeEach} from 'node:test';
import {readFile} from 'node:fs/promises';
import {IDBFactory,IDBKeyRange,IDBObjectStore} from 'fake-indexeddb';
const sample=JSON.parse(await readFile(new URL('./fixtures/task-event-v1.json',import.meta.url),'utf8'));
let api;
try {api=await import('../app/local-task-events.ts');} catch(error) {if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
beforeEach(()=>{globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;});
async function put(workspace,event=sample) {assert.equal(typeof api?.putTaskEvent,'function');return api.putTaskEvent(workspace,event);}
test('task evidence roundtrips independently by account and event with idempotent retry',async()=>{
  await put('a');await put('a');await put('b');
  assert.deepEqual(await api.listTaskEvents('a'),[sample]);
  assert.deepEqual(await api.listTaskEvents('b'),[sample]);
  assert.deepEqual(await api.listTaskEvents('empty'),[]);
  assert.equal((await api.listPendingTaskEvents('a')).length,1);
  await api.markTaskEventDelivered('a',sample.eventId);await put('a');
  assert.equal((await api.listPendingTaskEvents('a')).length,0);
  assert.equal((await api.listPendingTaskEvents('b')).length,1);
});
test('task evidence rejects changed payloads and retains the first immutable record',async()=>{
  await put('a');
  await assert.rejects(put('a',{...sample,taskId:'changed-task'}),/hash/);
  const {hashTaskEvent}=await import('../app/task-event-v1.ts');
  const body={...sample,taskId:'changed-task'};delete body.coreHash;
  await assert.rejects(put('a',{...body,coreHash:await hashTaskEvent(body)}),/conflict/);
  assert.deepEqual(await api.listTaskEvents('a'),[sample]);
});
test('task event persistence is not acknowledged before a transaction abort',async()=>{
  const putOriginal=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args) {
    const request=putOriginal.apply(this,args),tx=this.transaction;
    request.addEventListener('success',()=>tx.abort(),{once:true});return request;
  };
  try {await assert.rejects(put('a'),/取消|abort/i);} finally {IDBObjectStore.prototype.put=putOriginal;}
  assert.deepEqual(await api.listTaskEvents('a'),[]);
});
test('full task history bootstraps across multiple pages without dropping local pending evidence',async()=>{
  await put('a');assert.equal(typeof api.syncTaskEvents,'function');
  const {hashTaskEvent}=await import('../app/task-event-v1.ts');
  const remote=await Promise.all(Array.from({length:103},async(_,index)=>{
    const body={...sample,eventId:`remote-task-${index}`};delete body.coreHash;
    return {...body,coreHash:await hashTaskEvent(body)};
  }));
  const calls=[];
  const client={appendTaskEvent:async event=>({status:'accepted',eventId:event.eventId,durable:true}),getTaskEvents:async after=>{
    calls.push(after);return {events:after?remote.slice(100):remote.slice(0,100),nextCursor:after?null:'next-page',snapshotHash:'a'.repeat(64)};
  }};
  const events=await api.syncTaskEvents('a',client);
  assert.equal(events.length,104);assert.deepEqual(calls,[undefined,'next-page']);
  assert.equal((await api.listPendingTaskEvents('a')).length,0);
});
test('network failure or a changed history snapshot is never reported as complete',async()=>{
  await put('a');assert.equal(typeof api.syncTaskEvents,'function');
  await assert.rejects(api.syncTaskEvents('a',{appendTaskEvent:async()=>{throw new Error('offline');}}),/offline/);
  assert.equal((await api.listPendingTaskEvents('a')).length,1);
  const client={appendTaskEvent:async event=>({status:'duplicate',eventId:event.eventId,durable:true}),getTaskEvents:async after=>({events:[sample],nextCursor:after?null:'next',snapshotHash:(after?'b':'a').repeat(64)})};
  await assert.rejects(api.syncTaskEvents('a',client),/history-changed/);
  assert.deepEqual(await api.listTaskEvents('a'),[sample]);
});
