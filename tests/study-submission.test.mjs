import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory,IDBKeyRange,IDBObjectStore} from 'fake-indexeddb';
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';
import {wordBody,snapshotBody} from './fixtures/account-study-fixtures.mjs';
import {attempt} from './fixtures/task-event-fixtures.mjs';
import {putLocalStudySnapshot,listLocalStudyRecords} from '../app/local-account-study.ts';
import {listWorkspaceStudyEvents} from '../app/local-study-events.ts';
import {getLocalStudyEvent} from '../app/local-study-events.ts';
import {createSubmissionJournal,persistStudySubmission,recoverStudySubmissions} from '../app/study-submission-journal.ts';
let api;try{api=await import('../app/study-submission.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
async function setup(){assert.equal(typeof api?.prepareStudySubmission,'function');globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
  const item=await sealStudyItem(wordBody()),bundle={items:[item],snapshot:await sealStudySnapshot(snapshotBody([item]))},event=await attempt('submission-event','2026-09-01T00:01:00Z',0,1);
  await putLocalStudySnapshot('account:a',bundle,0);return{bundle,journal:createSubmissionJournal(),core:{workspaceId:'account:a',eventId:event.eventId,event,cloud:'pending',companion:'not-required',occurredAt:event.occurredAt,updatedAt:event.occurredAt}};
}
const observation={observationScope:'current-page-attempt',preSubmitAssistance:[{action:'meaning-check',count:1}],postSubmitFeedback:[]};
const frame=bundle=>({kind:'account',bundle,originDeviceId:'device-a',practiceMode:'three-stage'});
test('submitted observation binds the original core and envelope without persisting a pre-submit draft',async()=>{
  const f=await setup(),payload=await api.prepareStudySubmission(f.core,frame(f.bundle),observation,f.journal);
  assert.equal(payload.summary.attemptEventId,f.core.eventId);assert.equal(payload.summary.attemptCoreHash,f.core.event.coreHash);assert.equal(payload.route.record.snapshotId,'snapshot-a');
  assert.deepEqual(await f.journal.list('account:a'),[]);assert.deepEqual(await listWorkspaceStudyEvents('account:a'),[]);assert.deepEqual(await listLocalStudyRecords('account:a','library-a'),[]);
});
test('journal, original core and portable record commit without duplicating a scored attempt',async()=>{
  const f=await setup(),payload=await api.prepareStudySubmission(f.core,frame(f.bundle),observation,f.journal);
  const deps={journal:f.journal,persistCore:api.persistOriginalSubmission};assert.deepEqual(await persistStudySubmission(payload,deps),{journalSaved:true,coreStored:true,auxiliarySaved:true});
  await persistStudySubmission(payload,deps);assert.equal((await listWorkspaceStudyEvents('account:a')).length,1);assert.equal((await listLocalStudyRecords('account:a','library-a')).length,1);
});
test('interruption between original stores resumes the same core and summary',async()=>{
  const f=await setup(),payload=await api.prepareStudySubmission(f.core,frame(f.bundle),observation,f.journal),original=IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add=function(...args){const request=original.apply(this,args);if(this.name==='account-study-records-v1')request.addEventListener('success',()=>this.transaction.abort());return request;};
  try{const result=await persistStudySubmission(payload,{journal:f.journal,persistCore:api.persistOriginalSubmission});assert.equal(result.coreStored,false);}finally{IDBObjectStore.prototype.add=original;}
  assert.equal((await listWorkspaceStudyEvents('account:a')).length,0);assert.equal((await listLocalStudyRecords('account:a','library-a')).length,0);
  await recoverStudySubmissions('account:a',{journal:f.journal,persistCore:api.persistOriginalSubmission});assert.equal((await listWorkspaceStudyEvents('account:a')).length,1);assert.equal((await listLocalStudyRecords('account:a','library-a')).length,1);
  assert.equal((await f.journal.get('account:a',f.core.eventId)).payload.summary.summaryHash,payload.summary.summaryHash);
});
test('journal and account-store failure cannot leave an orphan V3 that a user retry would grade twice',async()=>{
  const f=await setup(),payload=await api.prepareStudySubmission(f.core,frame(f.bundle),observation,f.journal),add=IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add=function(...args){const request=add.apply(this,args);if(this.name==='account-study-records-v1')request.addEventListener('success',()=>this.transaction.abort());return request;};
  try{await assert.rejects(persistStudySubmission(payload,{journal:{put:async()=>{throw new DOMException('Full','QuotaExceededError');}},persistCore:api.persistOriginalSubmission}));}finally{IDBObjectStore.prototype.add=add;}
  assert.equal((await listWorkspaceStudyEvents('account:a')).length,0);assert.equal((await listLocalStudyRecords('account:a','library-a')).length,0);
  await persistStudySubmission(payload,{journal:f.journal,persistCore:api.persistOriginalSubmission});assert.equal((await listWorkspaceStudyEvents('account:a')).length,1);
});
test('a durable account core is not denied when both auxiliary journal and V3 mirror are unavailable',async()=>{
  const f=await setup(),payload=await api.prepareStudySubmission(f.core,frame(f.bundle),observation,f.journal),put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args){if(this.name==='study-events-v3')throw new DOMException('Full','QuotaExceededError');return put.apply(this,args);};
  try{const saved=await persistStudySubmission(payload,{journal:{put:async()=>{throw new DOMException('Full','QuotaExceededError');}},persistCore:api.persistOriginalSubmission});
    assert.equal(saved.coreStored,true);assert.equal(saved.auxiliarySaved,false);assert.equal(saved.mirror,'pending');assert.equal(saved.localMetadataSaved,false);
  }finally{IDBObjectStore.prototype.put=put;}
  assert.equal((await listWorkspaceStudyEvents('account:a')).length,0);assert.equal((await listLocalStudyRecords('account:a','library-a')).length,1);
  await api.persistOriginalSubmission(payload);assert.equal((await listWorkspaceStudyEvents('account:a')).length,1);assert.equal((await listLocalStudyRecords('account:a','library-a')).length,1);
});
test('mirror conflict after primary commit reports saved core plus conflict, not a request to regrade',async()=>{
  const f=await setup(),payload=await api.prepareStudySubmission(f.core,frame(f.bundle),observation,f.journal),get=IDBObjectStore.prototype.get;
  const other={...f.core,event:await attempt(f.core.eventId,f.core.occurredAt,0,0,false)};let reads=0;
  IDBObjectStore.prototype.get=function(...args){const request=get.apply(this,args);if(this.name==='study-events-v3'&&++reads===2)request.addEventListener('success',()=>{request.result=other;});return request;};
  try{const saved=await persistStudySubmission(payload,{journal:f.journal,persistCore:api.persistOriginalSubmission});assert.equal(saved.coreStored,true);assert.equal(saved.mirror,'conflict');}
  finally{IDBObjectStore.prototype.get=get;}
  assert.equal((await listLocalStudyRecords('account:a','library-a')).length,1);assert.equal((await getLocalStudyEvent('account:a',f.core.eventId)).event.coreHash,other.event.coreHash);
});
test('native binding is explicit and an older native source keeps auxiliary provenance unknown',async()=>{
  const f=await setup(),source={kind:'local',practiceMode:'three-stage',contentHash:'a'.repeat(64),localBindingHash:'b'.repeat(64)};
  f.core.companion='pending';const good=await api.prepareStudySubmission(f.core,source,observation,f.journal);assert.equal(good.route.binding.localBindingHash,source.localBindingHash);
  const old=await api.prepareStudySubmission(f.core,{kind:'local',practiceMode:'three-stage'},null,f.journal);assert.equal(old.route.binding,null);assert.equal(old.summary,null);
});
test('page mode and source changes after preparation starts cannot rewrite its association',async()=>{
  const f=await setup(),source=frame(f.bundle),waiting=api.prepareStudySubmission(f.core,source,observation,f.journal);
  source.practiceMode='spelling';source.bundle.snapshot.snapshotId='later-snapshot';const payload=await waiting;assert.equal(payload.summary.practiceMode,'three-stage');assert.equal(payload.route.record.snapshotId,'snapshot-a');
});
test('repreparing a journal-only attempt reuses its original envelope instead of generating another round',async()=>{
  const f=await setup(),source=frame(f.bundle),first=await api.prepareStudySubmission(f.core,source,observation,f.journal);await f.journal.put(first);
  const retry=await api.prepareStudySubmission(f.core,source,observation,f.journal);assert.deepEqual(retry,first);assert.equal(await f.journal.put(retry),'duplicate');
  assert.deepEqual(await listLocalStudyRecords('account:a','library-a'),[]);
});
test('an already journaled event cannot be re-associated with a different source frame',async()=>{
  const f=await setup(),source=frame(f.bundle),first=await api.prepareStudySubmission(f.core,source,observation,f.journal);await f.journal.put(first);
  const {snapshotHash,...body}=f.bundle.snapshot;void snapshotHash;const later={...source,bundle:{items:f.bundle.items,snapshot:await sealStudySnapshot({...body,snapshotId:'later',revision:2})}};
  await assert.rejects(api.prepareStudySubmission(f.core,later,observation,f.journal),/binding|conflict/);
  assert.equal((await f.journal.get('account:a',f.core.eventId)).payload.route.record.snapshotId,'snapshot-a');
});
