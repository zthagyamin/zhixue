import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import * as local from '../app/local-study-db.ts';
import * as progress from '../app/account-study-progress.ts';
import * as tasks from '../app/local-task-events.ts';
import {hashTaskEvent} from '../app/task-event-v1.ts';
function setup(){globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;}
test('recovery workspace export includes rules and queues but excludes pairing credentials and raw AI request inputs',async()=>{
  setup();assert.equal(typeof local.exportRecoveryWorkspaceRecords,'function');
  await local.saveWorkspaceRecord('account:a','vocab-pacing-by-subject',{quota:20});await local.saveWorkspaceRecord('account:a','cloud-outbox',[{eventId:'old-event'}]);
  await local.saveWorkspaceRecord('account:a','companion-session',{token:'synthetic-secret'});await local.saveWorkspaceRecord('account:a','account-question-ai-requests',{'raw question':'opaque'});
  await local.saveWorkspaceRecord('account:b','progress',{answered:99});const exported=await local.exportRecoveryWorkspaceRecords('account:a');
  assert.deepEqual(exported.map(row=>row.kind).sort(),['cloud-outbox','vocab-pacing-by-subject']);assert.equal(JSON.stringify(exported).includes('synthetic-secret'),false);assert.equal(JSON.stringify(exported).includes('raw question'),false);
});
test('owner-wide progress export retains all library namespaces including progress without an active library head',async()=>{
  setup();assert.equal(typeof progress.exportAccountProgress,'function');
  const view=libraryId=>({schemaVersion:1,workspaceId:'account:a',libraryId,progress:{itemStages:{word:1},fsrsData:{},answered:1,correct:1},evidenceHash:null,historyReady:false});
  await progress.saveAccountProgress(view('retired'));await progress.saveAccountProgress(view('current'));await progress.saveAccountProgress({...view('foreign'),workspaceId:'account:b'});
  const all=await progress.exportAccountProgress('account:a');assert.deepEqual(all.map(row=>row.libraryId),['current','retired']);assert.ok(all.every(row=>row.progress.answered===1));
});
test('learning task recovery export retains independent delivery status instead of exporting only event bodies',async()=>{
  setup();assert.equal(typeof tasks.exportTaskEventRecords,'function');const body={schemaVersion:1,eventType:'task-completed',eventId:'task-event-one',taskId:'task-one',subjectId:'math',day:'2026-09-01',occurredAt:'2026-09-01T00:00:00.000Z',unitIds:['unit-one'],source:'self-report',evidenceRefs:[]},event={...body,coreHash:await hashTaskEvent(body)};
  await tasks.putTaskEvent('account:a',event);assert.equal((await tasks.exportTaskEventRecords('account:a'))[0].delivered,false);
  await tasks.markTaskEventDelivered('account:a',event.eventId);assert.equal((await tasks.exportTaskEventRecords('account:a'))[0].delivered,true);assert.deepEqual(await tasks.exportTaskEventRecords('account:b'),[]);
});
