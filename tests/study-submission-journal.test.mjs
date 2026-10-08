import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {IDBFactory,IDBKeyRange,IDBObjectStore} from 'fake-indexeddb';
import {openStudyDb} from '../app/local-study-db.ts';
import {sealAssistanceSummary} from '../app/assistance-summary.ts';
import {scheduleReviewAt} from '../app/fsrs-scheduler.ts';
import {sealStudyRecord} from '../app/account-study-record.ts';
import {attempt} from './fixtures/task-event-fixtures.mjs';
const v=JSON.parse(await readFile(new URL('./fixtures/account-study-v1.json',import.meta.url))),summary=JSON.parse(await readFile(new URL('./fixtures/assistance-summary-v1.json',import.meta.url)));
let api;try{api=await import('../app/study-submission-journal.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
function setup(){assert.equal(typeof api?.createSubmissionJournal,'function');globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;return api.createSubmissionJournal();}
test('optional delivery lookup can fall back to original stores on journal storage failure, never on conflicting evidence',async()=>{
  assert.equal(typeof api?.readJournalForDelivery,'function');
  assert.equal(await api.readJournalForDelivery({get:async()=>{throw new Error('submission-storage-blocked');}},'account:a','event-one'),null);
  await assert.rejects(api.readJournalForDelivery({get:async()=>{throw new Error('submission-row-integrity');}},'account:a','event-one'),/integrity/);
});
function payload(workspaceId='account:a'){
  const event=structuredClone(v.records[0].event);return{schemaVersion:1,workspaceId,eventId:event.eventId,
    core:{workspaceId,eventId:event.eventId,event,cloud:'pending',companion:'not-required',occurredAt:event.occurredAt,updatedAt:event.occurredAt},
    route:{kind:'account',record:structuredClone(v.records[0])},summary:structuredClone(summary)};
}
test('a durable journal survives re-open, isolates owners and never updates an old database version',async()=>{
  const journal=setup(),old=await openStudyDb();assert.equal(old.version,3);old.close();
  assert.equal(await journal.put(payload()),'accepted');assert.equal(await journal.put(payload()),'duplicate');
  const fresh=api.createSubmissionJournal();assert.equal((await fresh.list('account:a')).length,1);assert.deepEqual(await fresh.list('account:b'),[]);
  const row=await fresh.get('account:a','event-one');assert.equal(row.coreStored,false);assert.equal(row.payload.summary.summaryId,summary.summaryId);
  const reopened=await openStudyDb();assert.equal(reopened.version,3);reopened.close();
});
test('same attempt cannot acquire different assistance or a different route after saving',async()=>{
  const journal=setup();await journal.put(payload());const changed=payload(),{summaryId,summaryHash,...body}=changed.summary;void summaryId;void summaryHash;
  changed.summary=await sealAssistanceSummary({...body,preSubmitAssistance:[]});await assert.rejects(journal.put(changed),/conflict/);
  const routed=payload();routed.route={kind:'local',binding:null};await assert.rejects(journal.put(routed),/conflict/);
  assert.deepEqual((await journal.get('account:a','event-one')).payload.summary,summary);
});
test('parent association is validated before any journal write',async()=>{
  const journal=setup(),wrong=payload();wrong.route.record=v.records[1];await assert.rejects(journal.put(wrong),/binding/);
  assert.deepEqual(await journal.list('account:a'),[]);
});
test('commit completion, not request success, establishes journal durability',async()=>{
  const journal=setup(),original=IDBObjectStore.prototype.add;
  IDBObjectStore.prototype.add=function(...args){const request=original.apply(this,args);if(this.name==='submissions')request.addEventListener('success',()=>this.transaction.abort());return request;};
  try{await assert.rejects(journal.put(payload()),/abort/i);}finally{IDBObjectStore.prototype.add=original;}
  assert.deepEqual(await journal.list('account:a'),[]);
});
test('recovery retains the original decimal diagnostic projection without changing V3 core identity',async()=>{
  const journal=setup(),value=payload(),event=await attempt('decimal-event','2026-09-01T00:01:00Z',0,0,false),state=scheduleReviewAt(undefined,'again',event.occurredAt);
  event.scheduling.clientStateAfter=state;const {envelopeHash,...body}=v.records[0];void envelopeHash;
  value.eventId=event.eventId;value.core={...value.core,event,eventId:event.eventId,occurredAt:event.occurredAt,updatedAt:event.occurredAt};value.route.record=await sealStudyRecord({...body,event});value.summary=null;
  await journal.put(value);const saved=await journal.get('account:a',event.eventId);assert.equal(saved.payload.core.event.coreHash,event.coreHash);
  assert.deepEqual(saved.payload.core.event.scheduling.clientStateAfter,state);
});
test('journal success permits core-store recovery without a second scored attempt',async()=>{
  const journal=setup();let calls=0;
  const result=await api.persistStudySubmission(payload(),{journal,persistCore:async()=>{calls++;throw new Error('original store unavailable');}});
  assert.deepEqual(result,{journalSaved:true,coreStored:false,auxiliarySaved:true});assert.equal(calls,1);
  const recovered=[];await api.recoverStudySubmissions('account:a',{journal,persistCore:async saved=>recovered.push(saved.core.event)});
  assert.equal(recovered.length,1);assert.deepEqual(recovered[0],v.records[0].event);assert.equal((await journal.get('account:a','event-one')).coreStored,true);
  await api.recoverStudySubmissions('account:a',{journal,persistCore:async()=>assert.fail('core already stored')});
});
test('a core integrity conflict is not downgraded to a successful offline save',async()=>{
  const journal=setup();await assert.rejects(api.persistStudySubmission(payload(),{journal,persistCore:async()=>{throw new Error('study-event-conflict');}}),/conflict/);
  assert.equal((await journal.get('account:a','event-one')).coreStored,false);
});
test('auxiliary journal unavailable still tries the original save and reports auxiliary failure',async()=>{
  setup();let core;
  const result=await api.persistStudySubmission(payload(),{journal:{put:async()=>{throw new Error('quota');}},persistCore:async saved=>core=saved.core});
  assert.equal(core.event.eventId,'event-one');assert.deepEqual(result,{journalSaved:false,coreStored:true,auxiliarySaved:false});
  await assert.rejects(api.persistStudySubmission(payload(),{journal:{put:async()=>{throw new Error('quota');}},persistCore:async()=>{throw new Error('core unavailable');}}),/core unavailable/);
});
test('concurrent core confirmations cannot erase auxiliary delivery confirmations',async()=>{
  const journal=setup();await journal.put(payload());const row=await journal.get('account:a','event-one');
  await Promise.all([journal.markCoreStored('account:a','event-one'),journal.ackSummary('account:a','event-one',{summaryId:summary.summaryId,summaryHash:summary.summaryHash,associationHash:row.associationHash,sequence:4})]);
  const saved=await journal.get('account:a','event-one');assert.equal(saved.coreStored,true);assert.equal(saved.cloudAck.sequence,4);
  await assert.rejects(journal.ackSummary('account:a','event-one',{summaryId:summary.summaryId,summaryHash:'b'.repeat(64),associationHash:row.associationHash,sequence:5}),/binding/);
});
test('native unsupported mapping remains independent and unsubmitted observations never enter the journal',async()=>{
  const journal=setup();assert.deepEqual(await journal.list('guest:local'),[]);
  const local=payload('guest:local');local.route={kind:'local',binding:null};local.core.cloud='not-required';local.core.companion='pending';
  await journal.put(local);const saved=await journal.get('guest:local','event-one');assert.equal(saved.associationHash,null);assert.equal(saved.payload.summary.observationScope,'current-page-attempt');
});
