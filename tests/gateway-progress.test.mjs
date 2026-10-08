import test from 'node:test';
import assert from 'node:assert/strict';
import * as projection from '../app/review-projection.ts';
import * as local from '../app/local-study-events.ts';
import {withStudyEventCoreHash,SCHEDULER_VERSION} from '../app/study-event-v3.ts';

async function event(id, at, stage, extra={}) {
  return withStudyEventCoreHash({schemaVersion:3,eventId:id,coreHash:'',occurredAt:at,domain:'differential-review',eventType:'practice-attempt',item:{kind:'word',key:'word:biology:cell'},attempt:{correct:stage>0,rating:stage>0?'good':'again',stageBefore:0,stageAfter:stage},...extra});
}
test('journal and local events rebuild stage and FSRS without double counting',async()=>{
  assert.equal(typeof projection.rebuildEventProgress,'function');
  const first=await event('event-1','2026-08-31T00:00:00.000Z',1);
  const final=await event('event-2','2026-08-31T00:01:00.000Z',3,{scheduling:{reviewedAt:'2026-08-31T00:01:00.000Z',schedulerVersion:SCHEDULER_VERSION}});
  const result=await projection.rebuildEventProgress([final,first,final]);
  assert.equal(result.events.length,2);
  assert.equal(result.itemStages['word:biology:cell'],3);
  assert.equal(result.fsrsData['word:biology:cell'].reps,1);
  const reset=await event('event-3','2026-08-31T00:02:00.000Z',0);
  assert.equal((await projection.rebuildEventProgress([first,final,reset])).itemStages['word:biology:cell'],0);
});
test('conflicting event identity or damaged core is rejected without partial replay',async()=>{
  const first=await event('event-1','2026-08-31T00:00:00.000Z',1);
  const changed=await event('event-1','2026-08-31T00:00:00.000Z',3);
  assert.equal(typeof projection.rebuildEventProgress,'function');
  await assert.rejects(()=>projection.rebuildEventProgress([first,changed]),/conflict/);
  await assert.rejects(()=>projection.rebuildEventProgress([{...first,attempt:{...first.attempt,stageAfter:99}}]));
});
test('compound workspace event query spans all occurrence times',()=>{
  const saved=globalThis.IDBKeyRange;
  globalThis.IDBKeyRange={bound:(lower,upper)=>({lower,upper})};
  try {
    assert.equal(typeof local.workspaceEventRange,'function');
    assert.deepEqual(local.workspaceEventRange('account'),{lower:['account',''],upper:['account','\uffff']});
  } finally {globalThis.IDBKeyRange=saved;}
});
