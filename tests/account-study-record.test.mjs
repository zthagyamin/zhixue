import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {sealStudyItem} from '../app/account-study-content.ts';
import {wordBody,quizBody,recordBody} from './fixtures/account-study-fixtures.mjs';
import {attempt,baseline} from './fixtures/task-event-fixtures.mjs';
import {SCHEDULER_VERSION,withStudyEventCoreHash} from '../app/study-event-v3.ts';

let api;
try {api=await import('../app/account-study-record.ts');}
catch(error) {if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;}
function ready(){assert.equal(typeof api?.sealStudyRecord,'function','Immutable record binding must exist');}
const taskCore=JSON.parse(await readFile(new URL('./fixtures/task-event-v1.json',import.meta.url),'utf8'));
async function setup(){const item=await sealStudyItem(wordBody());return {item,body:await recordBody({contentHash:item.contentHash})};}
async function chain(){
  const {item,body}=await setup();const first=await api.sealStudyRecord(body);
  const second=await api.sealStudyRecord({...body,attemptId:'attempt-two',parentEventId:first.event.eventId,
    event:await attempt('event-two','2026-09-01T00:02:00Z',1,2)});
  const third=await api.sealStudyRecord({...body,attemptId:'attempt-three',parentEventId:second.event.eventId,
    event:await attempt('event-three','2026-09-01T00:03:00Z',2,3)});
  return {item,first,second,third};
}
test('record preserves legacy core identity while signing a separate immutable association',async()=>{
  ready();const {body}=await setup(),record=await api.sealStudyRecord(body);
  assert.equal(record.event.coreHash,body.event.coreHash);assert.equal(record.event.eventId,'event-one');
  assert.deepEqual(await api.parseStudyRecord(record),record);
  assert.equal(api.compareStudyRecord(record,await api.sealStudyRecord(body)),'duplicate');
  const moved=await api.sealStudyRecord({...body,snapshotId:'snapshot-b'});
  assert.equal(api.compareStudyRecord(record,moved),'conflict');
  await assert.rejects(api.parseStudyRecord({...record,snapshotId:'snapshot-b'}),/integrity/);
});
test('invalid core or extra local association never receives a valid envelope',async()=>{
  ready();const {body}=await setup();body.event.attempt.stageAfter=2;
  await assert.rejects(api.sealStudyRecord(body),/hash|invalid/);
  await assert.rejects(api.sealStudyRecord({...await recordBody(),sourceNote:'private.md'}),/field/);
});
test('portable envelope removes only the declared non-core client projection',async()=>{
  ready();const {body}=await setup();const event=await attempt('event-final','2026-09-01T00:03:00Z',2,3,true,{scheduling:{
    reviewedAt:'2026-09-01T00:03:00.000Z',schedulerVersion:SCHEDULER_VERSION,clientStateAfter:{due:'2026-09-02T00:03:00.000Z',
      stability:1.25,difficulty:4.5,elapsed_days:0,scheduled_days:1,learning_steps:0,reps:1,lapses:0,state:2}}});
  const record=await api.sealStudyRecord({...body,event});assert.equal(record.event.coreHash,event.coreHash);
  assert.equal(record.event.scheduling.clientStateAfter,undefined);assert.ok(event.scheduling.clientStateAfter);
  assert.deepEqual(await api.parseStudyRecord(record),record);
});
test('complete three-stage chain is ready, incomplete ancestry stays pending',async()=>{
  ready();const {item,first,second,third}=await chain();
  assert.equal(api.checkStudyRecordBinding(first,item),'ready');
  assert.equal(api.checkStudyRecordBinding(second,item),'pending-parent');
  assert.equal(api.checkStudyRecordBinding(third,item,[second]),'pending-parent');
  assert.equal(api.checkStudyRecordBinding(third,item,[first,second]),'ready');
});
for(const [field,value] of [['roundId','another-round'],['originDeviceId','another-device'],['snapshotId','another-snapshot'],['libraryId','another-library']]) {
  test(`parent with different ${field} cannot complete another word round`,async()=>{
    ready();const {item,first,second}=await chain();const raw={...first,[field]:value};delete raw.envelopeHash;
    const changed=await api.sealStudyRecord(raw);
    assert.throws(()=>api.checkStudyRecordBinding(second,item,[changed]),/binding|parent/);
  });
}
test('wrong item content, skipped stage and terminal-round continuation cannot apply',async()=>{
  ready();const {item,first,third}=await chain();const {body}=await setup();
  assert.throws(()=>api.checkStudyRecordBinding(first,{...item,contentHash:'b'.repeat(64)}),/binding/);
  const skipped=await api.sealStudyRecord({...body,event:await attempt('skip-stage','2026-09-01T00:01:00Z',0,3)});
  assert.throws(()=>api.checkStudyRecordBinding(skipped,item),/stage/);
  const next=await api.sealStudyRecord({...body,attemptId:'attempt-after-end',parentEventId:third.event.eventId,event:await attempt('after-end','2026-09-01T00:04:00Z',3,3)});
  assert.throws(()=>api.checkStudyRecordBinding(next,item,[first,third]),/stage|terminal/);
});
test('parent cycles and changed timestamps are not valid causal chains',async()=>{
  ready();const {item,body}=await setup();
  const a=await api.sealStudyRecord({...body,parentEventId:'event-two',event:await attempt('event-one','2026-09-01T00:01:00Z',0,0,false)});
  const b=await api.sealStudyRecord({...body,attemptId:'attempt-two',parentEventId:'event-one',event:await attempt('event-two','2026-09-01T00:01:00Z',0,0,false)});
  assert.throws(()=>api.checkStudyRecordBinding(a,item,[b]),/cycle/);
  const {first,second}=await chain();const raw={...first,event:await attempt('event-one','2026-09-01T01:00:00Z',0,1)};delete raw.envelopeHash;
  const late=await api.sealStudyRecord(raw);
  assert.throws(()=>api.checkStudyRecordBinding(second,item,[late]),/time/);
});
test('legacy in-flight stage remains explicitly legacy and cannot prefix a verified round',async()=>{
  ready();const {item,body}=await setup();delete body.roundId;
  const legacy=await api.sealStudyRecord({...body,provenanceMode:'legacy-continuation',resumeId:'resume-one',resumeStateHash:'c'.repeat(64),
    legacyStage:1,legacyAnchorEventId:null,event:await attempt('legacy-next','2026-09-01T00:01:00Z',1,2)});
  assert.equal(api.checkStudyRecordBinding(legacy,item),'ready');assert.equal(legacy.provenanceMode,'legacy-continuation');
  const verified=await api.sealStudyRecord({...await recordBody({contentHash:item.contentHash}),parentEventId:'legacy-next',
    event:await attempt('legacy-end','2026-09-01T00:02:00Z',2,3)});
  assert.throws(()=>api.checkStudyRecordBinding(verified,item,[legacy]),/parent|binding/);
});
test('task envelope binds plan approval without adding fields to TaskEventV1',async()=>{
  ready();const body={schemaVersion:1,libraryId:'library-a',snapshotId:'snapshot-a',originDeviceId:'device-a',provenanceMode:'task',
    planHash:'a'.repeat(64),assignmentId:'assignment-one',completionKey:'completion-one',event:taskCore};
  const record=await api.sealStudyRecord(body);assert.deepEqual(record.event,taskCore);
  assert.equal(api.compareStudyRecord(record,await api.sealStudyRecord({...body,planHash:'b'.repeat(64)})),'conflict');
  assert.deepEqual(await api.parseStudyRecord(record),record);
});
test('baseline imports and forged provenance are not new verified practice records',async()=>{
  ready();await assert.rejects(api.sealStudyRecord({...await recordBody(),event:await baseline()}),/attempt/);
  await assert.rejects(api.sealStudyRecord({...await recordBody(),provenanceMode:['verified-round']}),/provenance/);
});
test('two terminal branches of the same round are isolated before projection',async()=>{
  ready();const {item,first,second,third}=await chain();const raw={...third,attemptId:'another-terminal',
    event:await attempt('terminal-two','2026-09-01T00:04:00Z',2,3)};delete raw.envelopeHash;
  const fork=await api.sealStudyRecord(raw);
  assert.throws(()=>api.checkStudyRecordBinding(third,item,[first,second,fork]),/fork/);
  assert.throws(()=>api.checkStudyRecordBinding(fork,item,[first,second,third]),/fork/);
});
test('completed words require scheduling at the actual attempt time',async()=>{
  ready();const {item,first,second,third}=await chain();const event={...third.event};delete event.scheduling;
  const raw={...third,event:await withStudyEventCoreHash(event)};delete raw.envelopeHash;
  const missing=await api.sealStudyRecord(raw);assert.throws(()=>api.checkStudyRecordBinding(missing,item,[first,second]),/scheduling/);
  raw.event=await withStudyEventCoreHash({...third.event,scheduling:{...third.event.scheduling,reviewedAt:'2026-09-02T00:03:00.000Z'}});
  const delayed=await api.sealStudyRecord(raw);assert.throws(()=>api.checkStudyRecordBinding(delayed,item,[first,second]),/scheduling/);
});
test('successful intermediate word stages do not move the review clock',async()=>{
  ready();const {item,first}=await chain();const raw={...first,event:await withStudyEventCoreHash({...first.event,
    scheduling:{reviewedAt:first.event.occurredAt,schedulerVersion:SCHEDULER_VERSION}})};delete raw.envelopeHash;
  const record=await api.sealStudyRecord(raw);assert.throws(()=>api.checkStudyRecordBinding(record,item),/scheduling/);
});
test('one attempt identity cannot appear twice in a nonadjacent stage chain',async()=>{
  ready();const {item,first,second,third}=await chain();const raw={...third,attemptId:first.attemptId};delete raw.envelopeHash;
  const reused=await api.sealStudyRecord(raw);assert.throws(()=>api.checkStudyRecordBinding(reused,item,[first,second]),/attempt/);
});
test('legacy continuation cannot be used to bypass normal quiz binding',async()=>{
  ready();const item=await sealStudyItem(quizBody()),body=await recordBody({contentHash:item.contentHash});delete body.roundId;
  const record=await api.sealStudyRecord({...body,provenanceMode:'legacy-continuation',resumeId:'resume-one',resumeStateHash:'c'.repeat(64),legacyStage:2,
    legacyAnchorEventId:null,event:await attempt('quiz-legacy','2026-09-01T00:01:00Z',0,3,true,{item:{kind:'due',key:'question-one'}})});
  assert.throws(()=>api.checkStudyRecordBinding(record,item),/legacy/);
});

test('word mode freezes actual grading semantics and preserves complete-card spelling override',async()=>{
  ready();const {item,body}=await setup();
  const spelling=await api.sealStudyRecord({...body,practiceMode:'spelling',event:await attempt('spelling-one','2026-09-01T00:01:00Z',0,3)});
  assert.equal(api.checkStudyRecordBinding(spelling,item),'ready');
  const skipped=await api.sealStudyRecord({...body,practiceMode:'three-stage',event:spelling.event});
  assert.throws(()=>api.checkStudyRecordBinding(skipped,item),/stage/);
  const incomplete=wordBody({completionRule:'graded-practice'});incomplete.word.example='';
  const thin=await sealStudyItem(incomplete);
  const recall=await api.sealStudyRecord({...body,contentHash:thin.contentHash,practiceMode:'recall',event:spelling.event});
  assert.equal(api.checkStudyRecordBinding(recall,thin),'ready');
  const invalid=await api.sealStudyRecord({...body,contentHash:thin.contentHash,practiceMode:'three-stage'});
  assert.throws(()=>api.checkStudyRecordBinding(invalid,thin),/mode/);
});

test('a round cannot switch modes midway or use absent quiz materials',async()=>{
  ready();const {item,first,second}=await chain();const raw={...second,practiceMode:'recall',event:await attempt('changed-mode','2026-09-01T00:02:00Z',1,3)};
  delete raw.envelopeHash;const changed=await api.sealStudyRecord(raw);
  assert.throws(()=>api.checkStudyRecordBinding(changed,item,[first]),/parent|round/);
  const body=await recordBody({contentHash:item.contentHash,practiceMode:'quiz',event:changed.event});
  assert.throws(()=>api.checkStudyRecordBinding({...body,envelopeHash:'a'.repeat(64)},item),/mode/);
});

test('contradictory correctness and rating cannot drive a review projection',async()=>{
  ready();const {item,body}=await setup();
  for(const [correct,rating] of [[false,'good'],[false,'easy'],[true,'again']]) {
    const event=await attempt('contradictory','2026-09-01T00:01:00Z',0,correct?3:0,correct);
    event.attempt.rating=rating;const signed=await withStudyEventCoreHash(event);
    const record=await api.sealStudyRecord({...body,practiceMode:'recall',event:signed});
    assert.throws(()=>api.checkStudyRecordBinding(record,item),/inconsistent-study-rating/);
  }
});
