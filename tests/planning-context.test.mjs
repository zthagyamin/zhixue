import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {vocabularyInput,courseSubject} from './fixtures/task-plan-input.mjs';
import {planningHash} from '../app/task-plan-engine.ts';
import {withStudyEventCoreHash} from '../app/study-event-v3.ts';
let api;
try {api=await import('../app/planning-context.ts');} catch(error) {if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const context=()=>({catalog:vocabularyInput(1).catalog,sourceReviews:[],captureReviews:[],observedAt:'2026-08-31T02:00:00.000Z',planRevision:3,capabilities:['task-planning-v1']});
async function record() {
  const event=await withStudyEventCoreHash({schemaVersion:3,eventId:'metadata-event-001',coreHash:'',occurredAt:'2026-08-31T01:00:00.000Z',domain:'ielts',eventType:'practice-attempt',item:{kind:'word',key:'word:0'},attempt:{rating:'good',correct:true,stageBefore:0,stageAfter:1}});
  const evidence={schemaVersion:1,eventId:event.eventId,coreHash:event.coreHash,word:vocabularyInput(1).catalog.subjects[0].words[0]};
  evidence.evidenceHash=await planningHash(evidence);
  return {event,subjectId:'vocab',planningEvidence:evidence};
}
test('planning context validates actionable metadata and keeps derived progress separate',()=>{
  assert.equal(typeof api?.parsePlanningContext,'function');
  const value=context();value.catalog.subjects.push(courseSubject(1));value.catalog.subjects[1].units[0].taskComplete=true;
  const parsed=api.parsePlanningContext(value);
  assert.equal(parsed.catalog.subjects[1].units[0].taskComplete,true);
  assert.equal(parsed.catalog.subjects[1].units[0].formalComplete,false);
  assert.deepEqual(parsed.catalog.subjects[0].words,value.catalog.subjects[0].words);
});

test('practice source observations bind exact event identity and keep the event core unchanged',async()=>{
  const event=await withStudyEventCoreHash({schemaVersion:3,eventId:'practice-source-version',coreHash:'',occurredAt:'2026-08-31T01:00:00.000Z',domain:'differential-review',eventType:'practice-attempt',item:{kind:'due',key:'practice:one'},attempt:{rating:'good',correct:true,stageBefore:0,stageAfter:3}});
  const body={schemaVersion:1,eventId:event.eventId,coreHash:event.coreHash,itemSource:{itemKey:'practice:one',subjectId:'course',sourceHash:'a'.repeat(64)}};
  const evidence={...body,evidenceHash:await planningHash(body)};
  const parsed=await api.parsePlanningRecord({event,subjectId:'course',planningEvidence:evidence});
  assert.deepEqual(parsed.planningEvidence.itemSource,body.itemSource);assert.equal(parsed.event.coreHash,event.coreHash);
  for(const itemSource of [{...body.itemSource,itemKey:'practice:other'},{...body.itemSource,subjectId:'other'},{...body.itemSource,sourceHash:'unknown'}]){
    const changed={...body,itemSource};await assert.rejects(api.parsePlanningRecord({event,subjectId:'course',planningEvidence:{...changed,evidenceHash:await planningHash(changed)}}));
  }
});
test('malformed catalog, source clocks and unsupported actions fail before use',()=>{
  assert.equal(typeof api?.parsePlanningContext,'function');
  for(const mutate of [v=>v.catalog.subjects[0].words[0].sourceHash='bad',v=>v.catalog.subjects[0].words=null,
    v=>v.observedAt='2026-02-30T00:00:00.000Z',v=>v.planRevision=-1,
    v=>v.sourceReviews.push({itemKey:'practice:x',subjectId:'vocab',completionRule:'graded-practice',sourceHash:'a'.repeat(64),state:{enabled:'true',dueAt:null}})]) {
    const value=context();mutate(value);assert.throws(()=>api.parsePlanningContext(value));
  }
});
test('a catalog word with unconfirmed language remains unknown rather than disabling the catalog',()=>{
  const value=context();value.catalog.subjects[0].words[0].language='';
  assert.equal(api.parsePlanningContext(value).catalog.subjects[0].words[0].language,'');
});
test('event-bound local identities must match their event, subject and checksum',async()=>{
  assert.equal(typeof api?.parsePlanningRecord,'function');
  const value=await record();assert.deepEqual(await api.parsePlanningRecord(value),value);
  for(const mutate of [v=>v.planningEvidence.word.word='tampered',v=>v.planningEvidence.eventId='another-event',
    v=>v.subjectId='another-subject',v=>v.planningEvidence.word.meaning='private body',v=>v.localContext={sourceNote:'private/path'}]) {
    const invalid=structuredClone(value);mutate(invalid);
    await assert.rejects(api.parsePlanningRecord(invalid));
  }
});
test('unconfirmed language in historical word evidence stays unknown and still validates',async()=>{
  const value=await record();value.planningEvidence.word.language='';
  delete value.planningEvidence.evidenceHash;value.planningEvidence.evidenceHash=await planningHash(value.planningEvidence);
  assert.equal((await api.parsePlanningRecord(value)).planningEvidence.word.language,'');
});
test('complete history loading verifies the advertised full snapshot hash',async()=>{
  assert.equal(typeof api?.loadPlanningRecords,'function');
  const ctx=context(),first=await record();
  const recordsHash=await planningHash([[first.event.eventId,first.event.coreHash,first.subjectId,first.planningEvidence.evidenceHash]]);
  const snapshotHash=await planningHash([ctx.catalog.sourceHash,ctx.planRevision,recordsHash]);
  const page={records:[first],sourceHash:ctx.catalog.sourceHash,planRevision:ctx.planRevision,snapshotHash,nextCursor:null};
  const received=await api.loadPlanningRecords(ctx,{getPlanningEvidence:async()=>page});
  assert.deepEqual(received,[first]);
  await assert.rejects(api.loadPlanningRecords(ctx,{getPlanningEvidence:async()=>({...page,records:[]})}),/incomplete/);
  await assert.rejects(api.loadPlanningRecords(ctx,{getPlanningEvidence:async()=>({...page,sourceHash:'b'.repeat(64)})}),/changed/);
});
test('actual Companion fixture passes browser context and full-history checks',async()=>{
  const value=JSON.parse(await readFile(new URL('./fixtures/planning-context-signed.json',import.meta.url),'utf8'));
  const ctx=api.parsePlanningContext(value.context);
  const records=await api.loadPlanningRecords(ctx,{getPlanningEvidence:async()=>value.page});
  assert.equal(records.length,1);assert.equal(records[0].planningEvidence.beforeReview.enabled,true);
});
