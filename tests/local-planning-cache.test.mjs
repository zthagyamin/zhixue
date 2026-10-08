import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {catalog,attempt,DAY} from './fixtures/task-event-fixtures.mjs';
import {loadWorkspaceRecord,saveWorkspaceRecord} from '../app/local-study-db.ts';
import {buildDailyPlanningInput} from '../app/task-planning-input.ts';
import {recordStudyAttempt} from '../app/study-event-controller.ts';
let api;
try{api=await import('../app/local-planning-cache.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;}
function setup(){assert.equal(typeof api?.loadPlanningWithCache,'function','Verified offline planning cache must exist');globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;}
const bundle=()=>({context:{catalog:catalog(),sourceReviews:[],captureReviews:[],observedAt:'2026-08-31T01:00:00.000Z',planRevision:0,capabilities:['task-planning-v1']},
  localEvents:[],companionRecords:[],taskEvents:[],legacyItemKeys:[],history:{local:'complete',cloud:'not-applicable',companion:'complete',tasks:'complete'},authority:{revision:0,candidate:null,history:[]}});
const local=()=>Promise.resolve({localEvents:[],taskEvents:[],pendingTaskCount:0});
test('a complete successful read caches only its own workspace and preserves its observation time',async()=>{
  setup();await api.loadPlanningWithCache('a',DAY,async()=>bundle(),local);
  const cached=await api.loadPlanningCache('a');assert.equal(cached.context.observedAt,'2026-08-31T01:00:00.000Z');
  assert.equal(await api.loadPlanningCache('b'),null);
});
test('network fallback merges new local evidence without claiming a fresh remote synchronization',async()=>{
  setup();await api.loadPlanningWithCache('a',DAY,async()=>bundle(),local);
  const event=await attempt('offline-new-word','2026-08-31T02:00:00Z',0,3);
  const result=await api.loadPlanningWithCache('a',DAY,async()=>{throw new TypeError('Failed to fetch');},async()=>({localEvents:[event],taskEvents:[],pendingTaskCount:0}));
  assert.equal(result.offline,true);assert.equal(result.context.observedAt,'2026-08-31T01:00:00.000Z');
  const composed=await buildDailyPlanningInput({...result,day:DAY,previous:null});assert.equal(composed.input.words[0].firstLearnedItemKey,'word:tree');
});
test('an invalid history or source conflict cannot be masked as offline cache success',async()=>{
  setup();await api.loadPlanningWithCache('a',DAY,async()=>bundle(),local);
  await assert.rejects(api.loadPlanningWithCache('a',DAY,async()=>{throw new Error('planning-history-incomplete');},local),/planning-history-incomplete/);
  await assert.rejects(api.loadPlanningWithCache('a',DAY,async()=>{throw new TypeError('Cannot read eventId');},local),/eventId/);
});
test('cache tampering or absent cache never becomes empty ready history',async()=>{
  setup();await assert.rejects(api.loadPlanningWithCache('none',DAY,async()=>{throw new TypeError('Failed to fetch');},local),/fetch/);
  await api.loadPlanningWithCache('a',DAY,async()=>bundle(),local);
  const saved=await loadWorkspaceRecord('a','task-planning-cache',null);saved.bundle.context.catalog.sourceHash='b'.repeat(64);
  await saveWorkspaceRecord('a','task-planning-cache',saved);
  await assert.rejects(api.loadPlanningCache('a'),/cache-integrity/);
});
test('cache supports the floating-point client state emitted by the real practice producer',async()=>{
  setup();let record;
  await recordStudyAttempt({workspaceId:'a',domain:'ielts',item:{kind:'word',key:'word:tree'},rating:'good',correct:true,stageBefore:2,stageAfter:3,
    reviewedAt:'2026-08-31T02:00:00.000Z',isThreeStage:true,delivery:{cloud:'not-required',companion:'not-required'}},
  {persistEvent:async value=>record=value,persistProgress:async()=>{},sendCloud:async()=>({accepted:[]}),sendCompanion:async()=>({status:'accepted'}),updateDelivery:async()=>{}});
  assert.ok(!Number.isInteger(record.event.scheduling.clientStateAfter.stability));
  const data=bundle();data.localEvents=[record.event];
  await api.loadPlanningWithCache('a',DAY,async()=>data,local);
  assert.deepEqual((await api.loadPlanningCache('a')).localEvents,[record.event]);
});
