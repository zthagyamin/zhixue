import assert from 'node:assert/strict';
import test from 'node:test';
import {attempt,baseline,catalog,DAY} from './fixtures/task-event-fixtures.mjs';
let api;
try {api=await import('../app/task-review-projection.ts');}
catch(error) {if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;}
async function project(events,words=[],previous=[],day=DAY) {
  assert.equal(typeof api?.projectReviewObligations,'function','Review-round projector must exist');
  return api.projectReviewObligations({day,words,events,previous,catalog:catalog()});
}
test('legacy baseline can seed a due review without a first-learning date',async()=>{
  const rounds=await project([await baseline()]);
  assert.equal(rounds.length,1);
  assert.equal(rounds[0].completed,false);
  assert.equal(rounds[0].dueAt,'2026-08-31T00:00:00.000Z');
});
test('a review-only registry resolves a baseline without inventing a subject unit',async()=>{
  const data=catalog([]);
  data.practiceSources=[{itemKey:'practice:result',subjectId:'vocab',title:'Result card',sourceHash:'a'.repeat(64),completionRule:'graded-practice'}];
  const result=await api.projectReviewObligations({day:DAY,words:[],events:[await baseline('practice:result')],previous:[],catalog:data});
  assert.equal(result[0].subjectId,'vocab');assert.equal(result[0].blockedReason,undefined);
});
test('initial failure creates no old-word review obligation',async()=>{
  const rounds=await project([await attempt('new-word-failed','2026-08-31T00:00:00Z',0,0,false)],
    [{lexemeKey:'en:tree',itemKeys:['word:tree'],status:'initial-in-progress',firstStartedAt:'2026-08-31T00:00:00.000Z'}]);
  assert.deepEqual(rounds,[]);
});
test('a first completion followed by another due today creates a real review round',async()=>{
  const rounds=await project([await attempt('new-word-learned','2026-08-31T00:00:00Z',0,3)],
    [{lexemeKey:'en:tree',itemKeys:['word:tree'],status:'learned',firstLearnedAt:'2026-08-31T00:00:00.000Z'}]);
  assert.equal(rounds.length,1);
  assert.equal(rounds[0].dueAt,'2026-08-31T00:10:00.000Z');
  assert.equal(rounds[0].completed,false);
});
test('failure retries stay in one round and completion preserves the denominator',async()=>{
  const seed=await baseline();
  const failures=[await attempt('review-fail-one','2026-08-31T01:00:00Z',0,0,false),await attempt('review-fail-two','2026-08-31T01:05:00Z',0,0,false)];
  const before=await project([seed,...failures]);
  assert.equal(before.length,1);
  const success=await attempt('review-final','2026-08-31T01:10:00Z',2,3,true,
    {attempt:{rating:'easy',correct:true,stageBefore:2,stageAfter:3}});
  const after=await project([success,...failures,seed,success]);
  assert.ok(after.some(r=>r.roundId===before[0].roundId && r.completed));
  assert.equal(after.filter(r=>r.completed).length,1);
});
test('previous completion flags are a cache, not proof',async()=>{
  const seed=await baseline();
  const before=await project([seed]);
  const after=await project([seed],[],[{...before[0],completed:true}]);
  assert.equal(after[0].completed,false);
});
test('an unfinished overdue round keeps identity across midnight',async()=>{
  const seed=await baseline('word:tree','2026-08-30T00:00:00.000Z');
  const yesterday=await project([seed],[],[],'2026-08-30');
  const today=await project([seed],[],yesterday);
  assert.equal(today[0].roundId,yesterday[0].roundId);
});
test('review projection never truncates a large required queue',async()=>{
  const events=await Promise.all(Array.from({length:500},(_,i)=>baseline(`word:item-${i}`)));
  assert.equal((await project(events)).length,500);
});
test('future evidence does not complete a previous day',async()=>{
  const seed=await baseline();
  const future=await attempt('future-review','2026-09-01T00:00:00Z',2,3);
  assert.equal((await project([seed,future]))[0].completed,false);
});
test('an early failed review can make a future card due today',async()=>{
  const seed=await baseline('word:tree','2026-09-15T00:00:00.000Z');
  const failed=await attempt('early-review-failed','2026-08-31T01:00:00Z',0,0,false);
  const rounds=await project([seed,failed]);
  assert.equal(rounds.length,1);
  assert.ok(rounds[0].dueAt.startsWith('2026-08-31'));
});
test('a declared source review enters even before its first FSRS event',async()=>{
  assert.ok(api);
  const rounds=await api.projectReviewObligations({day:DAY,words:[],events:[],previous:[],catalog:catalog(),sourceReviews:[{
    roundId:'source-card-one',itemKey:'practice:card-one',subjectId:'reading',dueAt:'2026-08-30T00:00:00.000Z',
    completed:false,completionRule:'graded-practice',
  }]});
  assert.equal(rounds.length,1);
  assert.equal(rounds[0].roundId,'source-card-one');
});
test('completing a review before its due hour preserves the daily denominator',async()=>{
  const seed=await baseline('word:tree','2026-08-31T09:00:00.000Z');
  const before=await project([seed]);
  const early=await attempt('early-success','2026-08-31T01:00:00Z',2,3,true,
    {attempt:{rating:'easy',correct:true,stageBefore:2,stageAfter:3}});
  const after=await project([seed,early]);
  assert.equal(after.length,1);
  assert.equal(after[0].roundId,before[0].roundId);
  assert.equal(after[0].completed,true);
});
test('missing evidence keeps an existing obligation blocked, not silently removed',async()=>{
  const previous={roundId:'unresolved-round',itemKey:'word:missing',subjectId:'vocab',dueAt:'2026-08-30T00:00:00.000Z',completed:false,completionRule:'three-stage'};
  const rounds=await project([],[],[previous]);
  assert.equal(rounds.length,1);
  assert.equal(rounds[0].completed,false);
  assert.ok(rounds[0].blockedReason);
});
test('final uncertain word state does not retroactively turn initial retries into reviews',async()=>{
  const failed=await attempt('uncertain-first-fail','2026-08-31T00:00:00Z',0,0,false);
  const done=await attempt('uncertain-first-done','2026-08-31T00:05:00Z',0,3);
  const words=[{lexemeKey:'en:tree',itemKeys:['word:tree'],status:'learned'}];
  const rounds=await project([failed,done],words);
  assert.equal(rounds.filter(round=>round.completed).length,0);
  assert.equal(rounds.length,1);
});
test('tomorrow final word state cannot backdate today initial failure into a review',async()=>{
  const failed=await attempt('before-future-fail','2026-08-31T00:00:00Z',0,0,false);
  const done=await attempt('tomorrow-first-done','2026-09-01T00:00:00Z',0,3);
  const words=[{lexemeKey:'en:tree',itemKeys:['word:tree'],status:'learned'}];
  assert.deepEqual(await project([failed,done],words),[]);
});

const sourceState=(dueAt='2026-08-31T00:00:00.000Z',enabled=true)=>({enabled,dueAt});
const sourceCurrent=state=>({itemKey:'word:tree',subjectId:'vocab',sourceHash:'a'.repeat(64),completionRule:'three-stage',state});
const observation=(event,beforeReview,afterReview)=>({event,subjectId:'vocab',planningEvidence:{
  schemaVersion:1,eventId:event.eventId,coreHash:event.coreHash,evidenceHash:'a'.repeat(64),beforeReview,afterReview,
}});
const sourceProject=(events=[],extra={})=>api.projectReviewObligations({day:DAY,words:[],events,previous:[],catalog:catalog(),...extra});

test('current source-only review seeds a stable pending round without practice history',async()=>{
  const input={sourceObservedAt:'2026-08-31T00:00:00Z',currentSourceReviews:[sourceCurrent(sourceState())]};
  const first=await sourceProject([],input),second=await sourceProject([],input);
  assert.equal(first.length,1);assert.equal(first[0].completed,false);
  assert.equal(first[0].roundId,second[0].roundId);
});
test('editing source-only due date preserves one existing outstanding round',async()=>{
  const first=await sourceProject([],{sourceObservedAt:'2026-08-31T00:00:00Z',currentSourceReviews:[sourceCurrent(sourceState())]});
  const changed=await sourceProject([],{previous:first,sourceObservedAt:'2026-08-31T01:00:00Z',currentSourceReviews:[sourceCurrent(sourceState('2026-08-30T00:00:00.000Z'))]});
  assert.equal(changed.length,1);assert.equal(changed[0].roundId,first[0].roundId);assert.equal(changed[0].blockedReason,undefined);
});
test('cold source history keeps the completed denominator after machine postponement or disable',async()=>{
  const event=await attempt('source-finish','2026-08-31T01:00:00Z',2,3,true,{scheduling:undefined});
  const first=await sourceProject([],{sourceObservedAt:'2026-08-31T00:00:00Z',currentSourceReviews:[sourceCurrent(sourceState())]});
  for(const after of [sourceState('2026-09-05T00:00:00.000Z'),sourceState(null,false)]) {
    const result=await sourceProject([event],{sourceHistory:[observation(event,sourceState(),after)],
      sourceObservedAt:'2026-08-31T02:00:00Z',currentSourceReviews:[sourceCurrent(after)]});
    assert.equal(result.length,1);assert.equal(result[0].completed,true);
    assert.equal(result[0].roundId,first[0].roundId);
  }
});
test('source-only completion without FSRS still schedules its later current source due date',async()=>{
  const event=await attempt('source-next-without-fsrs','2026-08-31T01:00:00Z',2,3,true,{scheduling:undefined});
  const next=sourceState('2026-09-07T00:00:00.000Z');
  const result=await sourceProject([event],{day:'2026-09-07',sourceHistory:[observation(event,sourceState(),next)],
    sourceObservedAt:'2026-09-07T01:00:00Z',currentSourceReviews:[sourceCurrent(next)]});
  assert.equal(result.length,1);assert.equal(result[0].completed,false);assert.equal(result[0].dueAt,next.dueAt);
});
test('a pending source writeback does not treat unchanged before-state as a fresh round',async()=>{
  const event=await attempt('source-pending-after','2026-08-31T01:00:00Z',2,3,true,{scheduling:undefined});
  const result=await sourceProject([event],{sourceHistory:[observation(event,sourceState())],
    sourceObservedAt:'2026-08-31T02:00:00Z',currentSourceReviews:[sourceCurrent(sourceState())]});
  assert.equal(result.length,1);assert.equal(result[0].completed,true);
});
test('machine source date is compared with actual after-state, not FSRS due',async()=>{
  const seed=await baseline(),event=await attempt('machine-finish','2026-08-31T01:00:00Z',2,3,true,
    {attempt:{rating:'easy',correct:true,stageBefore:2,stageAfter:3}});
  const after=sourceState('2026-08-31T02:00:00.000Z');
  const result=await sourceProject([seed,event],{sourceHistory:[observation(event,sourceState(),after)],
    sourceObservedAt:'2026-08-31T03:00:00Z',currentSourceReviews:[sourceCurrent(after)]});
  assert.equal(result.length,1);assert.equal(result[0].completed,true);
});
test('manual reenable after completion creates exactly one fresh round, which a later attempt closes',async()=>{
  const a=await attempt('source-a','2026-08-31T01:00:00Z',2,3,true,{scheduling:undefined});
  const b=await attempt('source-b','2026-08-31T03:00:00Z',2,3,true,{scheduling:undefined});
  const off=sourceState(null,false),on=sourceState();
  const before=await sourceProject([a],{sourceHistory:[observation(a,on,off)],sourceObservedAt:'2026-08-31T02:00:00Z',currentSourceReviews:[sourceCurrent(on)]});
  assert.equal(before.length,2);assert.equal(before.filter(r=>r.completed).length,1);
  const after=await sourceProject([b,a,b],{sourceHistory:[observation(a,on,off),observation(b,on,off)],
    sourceObservedAt:'2026-08-31T04:00:00Z',currentSourceReviews:[sourceCurrent(off)],previous:before});
  assert.equal(after.length,2);assert.ok(after.every(r=>r.completed));
  assert.deepEqual(after.map(r=>r.roundId).sort(),before.map(r=>r.roundId).sort());
});
test('source requirement pulls forward one future baseline and consumes its prior source alias',async()=>{
  const source={roundId:'source-existing',itemKey:'word:tree',subjectId:'vocab',completionRule:'three-stage',completed:false,dueAt:'2026-08-31T00:00:00.000Z'};
  const result=await sourceProject([await baseline('word:tree','2026-09-15T00:00:00.000Z')],{sourceReviews:[source],previous:[source]});
  assert.equal(result.length,1);assert.equal(result[0].dueAt,source.dueAt);
  assert.ok(result[0].aliasRoundIds.includes(source.roundId));assert.equal(result[0].blockedReason,undefined);
});
test('failed source attempts and machine date changes stay within one outstanding round',async()=>{
  const a=await attempt('source-fail-a','2026-08-31T00:30:00Z',0,0,false);
  const b=await attempt('source-fail-b','2026-08-31T00:35:00Z',0,0,false);
  const later=sourceState('2026-09-05T00:00:00.000Z');
  const first=await sourceProject([],{sourceObservedAt:'2026-08-31T00:00:00Z',currentSourceReviews:[sourceCurrent(sourceState())]});
  const after=await sourceProject([b,a,a],{sourceHistory:[observation(a,sourceState(),later),observation(b,later,later)],
    sourceObservedAt:'2026-08-31T01:00:00Z',currentSourceReviews:[sourceCurrent(later)]});
  assert.equal(after.length,1);assert.equal(after[0].roundId,first[0].roundId);assert.equal(after[0].completed,false);
});
test('future source observations cannot turn today initial failure into a review',async()=>{
  const fail=await attempt('initial-fail-future-source','2026-08-31T00:00:00Z',0,0,false);
  assert.deepEqual(await sourceProject([fail],{sourceObservedAt:'2026-09-01T00:00:00Z',currentSourceReviews:[sourceCurrent(sourceState())]}),[]);
});
test('timed capture requests interleave with practice and retain completed capture identity',async()=>{
  const event=await attempt('after-capture','2026-08-31T02:00:00Z',2,3,true,{scheduling:undefined});
  const capture={roundId:'capture:first',itemKey:'word:tree',subjectId:'vocab',completionRule:'three-stage',
    dueAt:'2026-08-31T00:00:00.000Z',observedAt:'2026-08-31T01:00:00Z'};
  const result=await sourceProject([event],{timedSourceReviews:[capture]});
  assert.equal(result.length,1);assert.equal(result[0].roundId,capture.roundId);assert.equal(result[0].completed,true);
});
test('orphan or cross-item source observations cannot prove a completed review',async()=>{
  const event=await attempt('bound-source','2026-08-31T01:00:00Z',2,3,true,{scheduling:undefined});
  await assert.rejects(sourceProject([],{sourceHistory:[observation(event,sourceState(),sourceState(null,false))]}),/source-observation-event-mismatch/);
  const crossed=structuredClone(event);crossed.item.key='word:other';
  await assert.rejects(sourceProject([event],{sourceHistory:[observation(crossed,sourceState(),sourceState(null,false))]}),/source-observation-event-mismatch/);
});
