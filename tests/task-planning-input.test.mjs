import assert from 'node:assert/strict';
import test from 'node:test';
import {attempt,catalog,word,DAY} from './fixtures/task-event-fixtures.mjs';
import {courseSubject} from './fixtures/task-plan-input.mjs';
import {generateTaskPlan,planningHash} from '../app/task-plan-engine.ts';
import {hashTaskEvent} from '../app/task-event-v1.ts';
let api;
try {api=await import('../app/task-planning-input.ts');}
catch(error) {if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;}
const history={local:'complete',cloud:'not-applicable',companion:'complete',tasks:'complete'};
const context=(data=catalog())=>({catalog:data,sourceReviews:[],captureReviews:[],observedAt:'2026-08-31T05:00:00.000Z',planRevision:0,capabilities:[]});
async function compose(changes={}) {
  assert.equal(typeof api?.buildDailyPlanningInput,'function','Complete planning composition must exist');
  return api.buildDailyPlanningInput({day:DAY,context:context(),localEvents:[],companionRecords:[],taskEvents:[],history,
    legacyItemKeys:[],previous:null,...changes});
}
async function observed(event,identity=word()) {
  const body={schemaVersion:1,eventId:event.eventId,coreHash:event.coreHash,word:identity};
  return {event,subjectId:identity.subjectId,planningEvidence:{...body,evidenceHash:await planningHash(body)}};
}
async function taskReport(unitIds=[],overrides={}) {
  const body={schemaVersion:1,eventType:'task-completed',eventId:'report-test-001',taskId:'manual:test',subjectId:'course',day:DAY,
    occurredAt:'2026-08-31T02:00:00.000Z',unitIds,source:'self-report',evidenceRefs:[],...overrides};
  return {...body,coreHash:await hashTaskEvent(body)};
}
test('every enabled history channel must finish and local/companion/task channels cannot be omitted',async()=>{
  for(const channel of Object.keys(history)) for(const status of ['loading','failed']) {
    await assert.rejects(compose({history:{...history,[channel]:status}}),/planning-history-not-ready/);
  }
  await assert.rejects(compose({history:{...history,companion:'not-applicable'}}),/planning-history-not-ready/);
  assert.equal((await compose()).input.words[0].status,'unseen');
});
test('cold replay merges duplicate V3 and retains removed learned identity without creating new supply',async()=>{
  const event=await attempt('removed-learned','2026-08-31T01:00:00Z',0,3);
  const result=await compose({context:context(catalog([])),localEvents:[event],companionRecords:[await observed(event)]});
  assert.equal(result.events.length,1);assert.equal(result.input.words[0].firstLearnedItemKey,'word:tree');
  assert.equal(result.input.wordIdentities[0].itemKey,'word:tree');
  const plan=await generateTaskPlan(result.input);
  assert.deepEqual(plan.vocabulary.assignedLexemeKeys,['en:tree']);assert.ok(plan.tasks.find(t=>t.category==='new-word').blockedReason);
});
test('future word history does not retroactively classify a new word as learned',async()=>{
  const event=await attempt('future-word-complete','2026-09-01T01:00:00Z',0,3);
  const result=await compose({localEvents:[event],companionRecords:[await observed(event)]});
  assert.equal(result.input.words[0].status,'unseen');assert.equal(result.input.words[0].firstLearnedAt,undefined);
});
test('same physical key changing lexeme is never used to credit the new word with old evidence',async()=>{
  const event=await attempt('old-identity-complete','2026-08-31T01:00:00Z',0,3);
  const result=await compose({context:context(catalog([word({word:'other'})])),companionRecords:[await observed(event)]});
  assert.ok(result.input.words.every(w=>w.status==='history-unknown' && w.firstLearnedAt===undefined));
});
test('self-report completions never fulfill formal units and formal state never invents a timestamp',async()=>{
  const subject=courseSubject(2);subject.goals=[];
  subject.units[1].completionRule='formal-done';subject.units[1].formalComplete=true;
  const data=catalog([]);data.subjects.push(subject);
  const result=await compose({context:context(data),taskEvents:[await taskReport(['course:u0','course:u1'])]});
  assert.deepEqual(result.input.completions.map(c=>[c.unitId,c.basis]),[['course:u0','self-report']]);
  assert.equal(result.input.catalog.subjects[1].units[1].formalComplete,true);
});
test('multi-item practice unit only completes when all exact keys finish on one study day',async()=>{
  const subject=courseSubject(1);subject.goals=[];
  subject.units[0].action={kind:'practice',itemKeys:['practice:one','practice:two']};subject.units[0].completionRule='graded-practice';
  const data=catalog([]);data.subjects.push(subject);
  const first=await attempt('unit-first','2026-08-30T01:00:00Z',0,3,true,{item:{kind:'due',key:'practice:one'}});
  const second=await attempt('unit-second','2026-08-31T01:00:00Z',0,3,true,{item:{kind:'due',key:'practice:two'}});
  const incomplete=await compose({context:context(data),localEvents:[first,second]});
  assert.equal(incomplete.input.completions.length,0);
  const today=await attempt('unit-first-today','2026-08-31T02:00:00Z',0,3,true,{item:{kind:'due',key:'practice:one'}});
  const complete=await compose({context:context(data),localEvents:[first,second,today]});
  assert.equal(complete.input.completions.length,1);assert.equal(complete.input.completions[0].occurredAt,today.occurredAt);
});
test('same lexeme completion in library B never ticks the pinned physical task in library A',async()=>{
  const a=word(),b=word({itemKey:'word:second',subjectId:'second'}),data=catalog([a]);
  data.subjects.push({...data.subjects[0],subjectId:'second',priority:1,words:[b]});
  const initial=await compose({context:context(data)}),plan=await generateTaskPlan(initial.input);
  const sourceTask=plan.tasks.find(t=>t.action.itemKeys.includes(a.itemKey));assert.ok(sourceTask);
  const event=await attempt('other-physical-done','2026-08-31T01:00:00Z',0,3,true,{item:{kind:'word',key:b.itemKey}});
  const result=await compose({context:context(data),localEvents:[event],companionRecords:[await observed(event,b)],previous:plan});
  assert.ok(!result.completedTaskIds.includes(sourceTask.taskId));
  assert.equal(result.input.words[0].firstLearnedItemKey,b.itemKey);
});
test('a task report with unverified practice references cannot mint evidence completion',async()=>{
  const subject=courseSubject(1);subject.goals=[];subject.units[0].completionRule='graded-practice';subject.units[0].action={kind:'practice',itemKeys:['practice:one']};
  const data=catalog([]);data.subjects.push(subject);
  const report=await taskReport(['course:u0'],{source:'evidence',evidenceRefs:['missing-practice']});
  const result=await compose({context:context(data),taskEvents:[report]});
  assert.equal(result.input.completions.length,0);
});
