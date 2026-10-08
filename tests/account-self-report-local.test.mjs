import assert from 'node:assert/strict';
import test from 'node:test';
import {dashboardFunction} from './fixtures/dashboard-functions.mjs';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {createAccountTaskRecord} from '../app/account-study-record-client.ts';
import {putLocalStudySnapshot,listLocalStudyRecords} from '../app/local-account-study.ts';
import {assistanceBundle} from './fixtures/assistance-read.mjs';
import {studyDay} from '../app/vocabulary-learning.ts';
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
function fixture(){let notified=0,stored=0;const gate=deferred(),entered=deferred(),messages=[],bundle={snapshot:{snapshotId:'snapshot-a',libraryId:'library-a'}},catalog={catalogHash:'catalog',snapshotId:'snapshot-a'};
  const record={libraryId:'library-a',envelopeHash:'a'.repeat(64),event:{eventId:'local-task'}};
  const env={accountLoadedRef:{current:{bundle,bundles:[bundle],catalogs:[catalog]}},accountWorkspaceId:'account:a',taskWorkspaceRef:{current:'account:a'},accountDeviceId:'device',accountModeEpoch:{current:0},
    toEngineTaskPlan:async()=>({tasks:[{taskId:'self'}]}),createAccountTaskRecord:async()=>{stored++;return record;},getLocalStudyRecord:async()=>({record,cloud:'acked'}),
    flushAccountStudyRecords:async()=>{entered.resolve();await gate.promise;},accountClient:{appendRecords:async()=>({results:[]})},refreshAccountRead:async()=>{},noteEventsChanged(){notified++;},setPlanMessage:value=>messages.push(value)};
  return{env,gate,entered,messages,get:()=>({notified,stored}),run:()=>dashboardFunction('completeAccountTask',env)({catalogHash:'catalog'},'self')};
}
test('self-report durability refreshes Today before network confirmation arrives',async()=>{
  const f=fixture(),saving=f.run();await f.entered.promise;try{assert.deepEqual(f.get(),{notified:1,stored:1});assert.ok(f.messages.some(value=>/本机/.test(value)));}finally{f.gate.resolve();await saving;}
});
test('failed self-report storage remains retryable and is surfaced to the Today editor',async()=>{
  const f=fixture();f.env.createAccountTaskRecord=async()=>{throw new Error('Synthetic storage failure');};await assert.rejects(f.run(),/storage failure/);assert.equal(f.get().notified,0);
});

test('a nondurable account response cannot be presented as a received self-report',async()=>{
  const f=fixture(),get=f.env.getLocalStudyRecord;f.env.getLocalStudyRecord=async()=>({...await get(),cloud:'pending'});f.env.refreshAccountRead=async()=>null;f.gate.resolve();
  await assert.rejects(f.run(),/本机.*核对/);assert.ok(f.messages.every(message=>!message.includes('已进入账号')));
});

test('a task left open across midnight cannot create a completion under the wrong plan day',async()=>{
  globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;const bundle=assistanceBundle(),workspaceId='account:a';await putLocalStudySnapshot(workspaceId,bundle,0);
  const input={workspaceId,bundle,originDeviceId:'device',plan:{cloudPlanHash:'a'.repeat(64),day:studyDay(new Date(Date.now()-86400000).toISOString())},task:{taskId:'manual:course:u1',subjectId:'course',unitIds:['course:u1'],completionRule:'self-report',required:false}};
  await assert.rejects(createAccountTaskRecord(input),/日期/);assert.deepEqual(await listLocalStudyRecords(workspaceId,bundle.snapshot.libraryId),[]);
});
