import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {assistanceView,assistanceBundle} from './fixtures/assistance-read.mjs';
import {createSubmissionJournal} from '../app/study-submission-journal.ts';
import {putLocalStudySnapshot,putLocalStudyRecord,applyLocalStudyReceipt} from '../app/local-account-study.ts';
import {tsxFunction} from './fixtures/tsx-functions.mjs';
let api;try{api=await import('../app/account-plan-evidence.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
async function fixture(){assert.equal(typeof api?.assertAccountPlanEvidence,'function');globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
  const workspaceId='account:a',record=(await assistanceView()).summaries[0].parent,event=record.event,journal=createSubmissionJournal();await putLocalStudySnapshot(workspaceId,assistanceBundle(),0);
  const payload={schemaVersion:1,workspaceId,eventId:event.eventId,route:{kind:'account',record},summary:null,core:{workspaceId,eventId:event.eventId,event,cloud:'pending',companion:'not-required',occurredAt:event.occurredAt,updatedAt:event.occurredAt}};
  const loaded={bundle:assistanceBundle(),records:[],eventThrough:0,taskThrough:0};return{workspaceId,record,journal,payload,loaded};
}
test('unreceived journal-only core blocks shared plan changes, not local display',async()=>{const f=await fixture();await f.journal.put(f.payload);await assert.rejects(api.assertAccountPlanEvidence(f.workspaceId,f.loaded,f.journal),/作答|核对/);});
test('an ACK newer than the loaded fence still blocks edits until the record is read back',async()=>{
  const f=await fixture();await putLocalStudyRecord(f.workspaceId,f.record);await applyLocalStudyReceipt(f.workspaceId,{schemaVersion:1,libraryId:f.record.libraryId,eventId:f.record.event.eventId,envelopeHash:f.record.envelopeHash,target:'cloud',status:'acked',revision:1});
  await assert.rejects(api.assertAccountPlanEvidence(f.workspaceId,f.loaded,f.journal),/作答|核对/);
});
test('a mirrored core inside the exact remote fence does not wait for auxiliary writeback',async()=>{
  const f=await fixture();await f.journal.put(f.payload);f.loaded.records=[{sequence:1,record:f.record}];f.loaded.eventThrough=1;f.loaded.taskThrough=1;await api.assertAccountPlanEvidence(f.workspaceId,f.loaded,f.journal);
  await assert.rejects(api.assertAccountPlanEvidence('guest:local',f.loaded,f.journal),/owner|workspace|账号/);
});
test('unreadable local journal is unknown, not permission to publish a plan using partial history',async()=>{
  const f=await fixture();await assert.rejects(api.assertAccountPlanEvidence(f.workspaceId,f.loaded,{list:async()=>{throw new Error('journal unavailable');}}),/unavailable/);
});

test('a new local attempt saved during plan preparation must be checked again before publishing',async()=>{
  const f=await fixture();let enter,release,calls=0;const entered=new Promise(resolve=>enter=resolve),wait=new Promise(resolve=>release=resolve);
  const loaded={...f.loaded,catalog:{},facts:{factsHash:'a'.repeat(64),nativePlanRevision:0}},env={workspaceId:f.workspaceId,loaded,submissionJournal:f.journal,assertAccountPlanEvidence:api.assertAccountPlanEvidence,
    sealCloudTaskPlan:async()=>{enter();await wait;return{};},client:{mutatePlan:async()=>{calls++;return{status:'accepted'};}},day:'2026-09-01',refresh:async()=>{}};
  const saving=tsxFunction(new URL('../app/account-study-controls.tsx',import.meta.url),'save',env)({},0);await entered;await f.journal.put(f.payload);release();
  await assert.rejects(saving,/作答|核对/);assert.equal(calls,0);
});
