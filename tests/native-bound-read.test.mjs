import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory,IDBKeyRange,IDBObjectStore} from 'fake-indexeddb';
import {attempt} from './fixtures/task-event-fixtures.mjs';
import {listWorkspaceStudyEvents} from '../app/local-study-events.ts';
import {openStudyDb,STUDY_EVENTS_V3_STORE} from '../app/local-study-db.ts';
let api;try{api=await import('../app/native-bound-read.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
async function fixture(count=25){assert.equal(typeof api?.readBoundStudyHistory,'function');globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
  const rows=await Promise.all(Array.from({length:count},async(_,i)=>({sequence:i*2+1,event:await attempt(`bound-${i}`,'2026-09-01T00:01:00Z',0,1)}))),requests=[];let current=true;
  const reply=(url)=>{const p=new URL(url,'https://fixture.test').searchParams,after=Number(p.get('after')),through=Number(p.get('through')??rows.at(-1)?.sequence??0),events=rows.filter(row=>row.sequence>after&&row.sequence<=through).slice(0,20),nextCursor=events.at(-1)?.sequence??after;return{protocol:'zhixue-native-history-v1',userId:'a',through,nextCursor,hasMore:nextCursor<through,events};};
  const fetcher=async(url)=>{requests.push(url);return Response.json(reply(url));};return{rows,requests,reply,fetcher,options:{workspaceId:'account:a',isCurrent:()=>current},changeOwner:()=>{current=false;}};
}
test('complete bound pages commit events and checkpoint together, then read only increments',async()=>{
  const f=await fixture();await api.readBoundStudyHistory({...f.options,fetcher:f.fetcher});assert.equal(f.requests.length,2);assert.equal((await listWorkspaceStudyEvents('account:a')).length,25);
  assert.equal((await api.readNativeCheckpoint('account:a')).cursor,49);f.requests.length=0;await api.readBoundStudyHistory({...f.options,fetcher:f.fetcher});assert.equal(f.requests.length,1);assert.match(f.requests[0],/after=49/);
});
for(const mode of ['page-failure','empty-page','wrong-owner','changed-fence','bad-next','old-protocol','cancel'])test(`a ${mode} cannot leak half history or advance a checkpoint`,async()=>{
  const f=await fixture();let pages=0;const fetcher=async(url)=>{const body=f.reply(url);pages++;if(pages===2){if(mode==='page-failure')return new Response('',{status:503});if(mode==='empty-page')body.events=[];if(mode==='wrong-owner')body.userId='b';if(mode==='changed-fence')body.through++;if(mode==='bad-next')body.nextCursor++;if(mode==='old-protocol')delete body.protocol;if(mode==='cancel')f.changeOwner();}return Response.json(body);};
  await assert.rejects(api.readBoundStudyHistory({...f.options,fetcher}));assert.equal((await listWorkspaceStudyEvents('account:a')).length,0);assert.equal((await api.readNativeCheckpoint('account:a')).cursor,0);
});
test('an event-store write failure rolls back earlier rows and the complete checkpoint',async()=>{
  const f=await fixture(3),put=IDBObjectStore.prototype.put;let writes=0;IDBObjectStore.prototype.put=function(...args){if(this.name==='study-events-v3'&&++writes===2)throw new DOMException('Synthetic quota','QuotaExceededError');return put.apply(this,args);};
  try{await assert.rejects(api.readBoundStudyHistory({...f.options,fetcher:f.fetcher}));}finally{IDBObjectStore.prototype.put=put;}
  assert.equal((await listWorkspaceStudyEvents('account:a')).length,0);assert.equal((await api.readNativeCheckpoint('account:a')).cursor,0);
  await api.readBoundStudyHistory({...f.options,fetcher:f.fetcher});assert.equal((await listWorkspaceStudyEvents('account:a')).length,3);
});

test('checkpoint write failure also rolls back all downloaded events',async()=>{
  const f=await fixture(3),put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){if(this.name==='workspace-records')throw new DOMException('Synthetic checkpoint abort','QuotaExceededError');return put.apply(this,args);};
  try{await assert.rejects(api.readBoundStudyHistory({...f.options,fetcher:f.fetcher}));}finally{IDBObjectStore.prototype.put=put;}
  assert.equal((await listWorkspaceStudyEvents('account:a')).length,0);assert.equal((await api.readNativeCheckpoint('account:a')).cursor,0);
});
test('concurrent readers cannot regress a committed checkpoint and a retry is idempotent',async()=>{
  const f=await fixture(3),arrived=[];let release;const all=new Promise(resolve=>release=resolve);
  const fetcher=async(url)=>{arrived.push(url);if(arrived.length===2)release();await all;return Response.json(f.reply(url));};
  const results=await Promise.allSettled([api.readBoundStudyHistory({...f.options,fetcher}),api.readBoundStudyHistory({...f.options,fetcher})]);
  assert.equal(results.filter(value=>value.status==='fulfilled').length,1);assert.equal((await api.readNativeCheckpoint('account:a')).cursor,5);
  await api.readBoundStudyHistory({...f.options,fetcher:f.fetcher});assert.equal((await listWorkspaceStudyEvents('account:a')).length,3);
});
test('explicit complete re-read repairs a missing cached row without discarding the checkpoint proof',async()=>{
  const f=await fixture(3);await api.readBoundStudyHistory({...f.options,fetcher:f.fetcher});const db=await openStudyDb();
  try{await new Promise((resolve,reject)=>{const tx=db.transaction(STUDY_EVENTS_V3_STORE,'readwrite');tx.objectStore(STUDY_EVENTS_V3_STORE).delete(['account:a',f.rows[0].event.eventId]);tx.oncomplete=resolve;tx.onerror=reject;});}finally{db.close();}
  await assert.rejects(api.readBoundStudyHistory({...f.options,fetcher:f.fetcher}),/history-missing/);
  await api.readBoundStudyHistory({...f.options,fetcher:f.fetcher,forceFull:true});assert.equal((await listWorkspaceStudyEvents('account:a')).length,3);assert.equal((await api.readNativeCheckpoint('account:a')).cursor,5);
});

test('a matching self-reported hash cannot conceal a corrupted cached event, including complete re-read',async()=>{
  const f=await fixture(1);await api.readBoundStudyHistory({...f.options,fetcher:f.fetcher});const [row]=await listWorkspaceStudyEvents('account:a');row.event.attempt.stageAfter=2;
  const db=await openStudyDb();try{await new Promise((resolve,reject)=>{const tx=db.transaction(STUDY_EVENTS_V3_STORE,'readwrite');tx.objectStore(STUDY_EVENTS_V3_STORE).put(row);tx.oncomplete=resolve;tx.onerror=reject;});}finally{db.close();}
  await assert.rejects(api.readNativeCheckpoint('account:a'),/core-hash/);
  await assert.rejects(api.readBoundStudyHistory({...f.options,fetcher:f.fetcher,forceFull:true}),/core-hash/);
  assert.equal((await listWorkspaceStudyEvents('account:a'))[0].event.attempt.stageAfter,2,'corrupt evidence is preserved for explicit recovery, never silently overwritten');
});
