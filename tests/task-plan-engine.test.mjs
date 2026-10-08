import assert from 'node:assert/strict';
import test from 'node:test';
import {vocabularyInput,courseSubject} from './fixtures/task-plan-input.mjs';
let api;
try {api=await import('../app/task-plan-engine.ts');}
catch(error) {if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;}
async function generate(input) {
  assert.equal(typeof api?.generateTaskPlan,'function','Task-driven generator must exist');
  return api.generateTaskPlan(input);
}
test('without a time budget all 500 required reviews and 20 new words enter',async()=>{
  const input=vocabularyInput();
  input.reviews=Array.from({length:500},(_,i)=>({roundId:`round:${i}`,itemKey:`practice:${i}`,subjectId:'reading',
    dueAt:'2026-08-30T00:00:00.000Z',completed:false,completionRule:'graded-practice'}));
  const plan=await generate(input);
  assert.equal(plan.vocabulary.assignedLexemeKeys.length,20);
  assert.equal(plan.tasks.filter(task=>task.category==='review').length,500);
  assert.equal(plan.tasks.filter(task=>task.category==='new-word').reduce((sum,t)=>sum+t.quantity,0),20);
  assert.equal(plan.optionalMinutes,undefined);
});
test('free-study first learning keeps its physical library even without a prior plan',async()=>{
  const input=vocabularyInput(30),original=input.catalog.subjects[0].words[0];
  const second={...original,itemKey:'word:second:0',subjectId:'second'};
  input.catalog.subjects.push({...input.catalog.subjects[0],subjectId:'second',priority:1,words:[second]});
  Object.assign(input.words[0],{itemKeys:[original.itemKey,second.itemKey],status:'initial-in-progress',firstStartedItemKey:second.itemKey,firstStartedAt:'2026-08-31T01:00:00.000Z'});
  const plan=await generate(input);
  assert.ok(plan.tasks.some(task=>task.action.itemKeys.includes(second.itemKey)));
  assert.ok(!plan.tasks.some(task=>task.action.itemKeys.includes(original.itemKey)));
});
test('a completed removed word keeps its observed identity without becoming new supply',async()=>{
  const input=vocabularyInput(2),removed=input.catalog.subjects[0].words.pop();
  input.wordIdentities=[removed];
  Object.assign(input.words[1],{status:'learned',firstLearnedAt:'2026-08-31T01:00:00.000Z',firstLearnedItemKey:removed.itemKey});
  const plan=await generate(input);
  assert.ok(plan.vocabulary.snapshot.some(word=>word.itemKey===removed.itemKey));
  assert.equal(plan.vocabulary.assignedLexemeKeys.length,2);
  input.words[1]={...input.words[1],status:'unseen',firstLearnedAt:undefined,firstLearnedItemKey:undefined};
  const fresh=await generate(input);
  assert.ok(!fresh.vocabulary.assignedLexemeKeys.includes('en:term1'));
});
test('review-only registry entries have readable names and their own content hash',async()=>{
  const input=vocabularyInput(0);
  input.catalog.practiceSources=[{itemKey:'practice:result',subjectId:'vocab',title:'Real review point',sourceHash:'c'.repeat(64),completionRule:'graded-practice'}];
  input.reviews=[{roundId:'result-review',itemKey:'practice:result',subjectId:'vocab',dueAt:'2026-08-31T00:00:00.000Z',completed:false,completionRule:'graded-practice'}];
  const task=(await generate(input)).tasks[0];
  assert.equal(task.title,'复习 · Real review point');assert.equal(task.sourceHash,'c'.repeat(64));
});
test('learning the same word elsewhere fulfills the global target but leaves a pinned source optional',async()=>{
  const {editTaskPlan}=await import('../app/task-plan-edit.ts');
  const input=vocabularyInput(30),first=input.catalog.subjects[0].words[0],other={...first,itemKey:'word:second:0',subjectId:'second'};
  input.catalog.subjects.push({...input.catalog.subjects[0],subjectId:'second',priority:1,words:[other]});
  const initial=await generate(input);
  input.previous=await editTaskPlan(initial,{type:'start',taskId:initial.tasks[0].taskId},input.catalog);
  Object.assign(input.words[0],{status:'learned',firstStartedItemKey:first.itemKey,firstLearnedItemKey:other.itemKey,firstLearnedAt:'2026-08-31T01:00:00.000Z'});
  const plan=await generate(input);
  assert.ok(plan.tasks.some(task=>task.required && task.action.itemKeys.includes(other.itemKey)));
  assert.ok(plan.tasks.some(task=>!task.required && task.action.itemKeys.includes(first.itemKey)));
  assert.equal(plan.tasks.filter(task=>task.category==='new-word' && task.required).reduce((sum,task)=>sum+task.quantity,0),20);
  assert.deepEqual(plan.vocabulary.lockedItemKeys,input.previous.vocabulary.lockedItemKeys);
  const again=await generate({...input,previous:plan});
  assert.ok(again.tasks.some(task=>!task.required && task.action.itemKeys.includes(first.itemKey)));
});

test('starting the same word in a second library retains both the pinned choice and actual continuation',async()=>{
  const {editTaskPlan}=await import('../app/task-plan-edit.ts');
  const input=vocabularyInput(30),first=input.catalog.subjects[0].words[0],other={...first,itemKey:'word:second:0',subjectId:'second'};
  input.catalog.subjects.push({...input.catalog.subjects[0],subjectId:'second',priority:1,words:[other]});
  const initial=await generate(input);
  input.previous=await editTaskPlan(initial,{type:'start',taskId:initial.tasks[0].taskId},input.catalog);
  Object.assign(input.words[0],{status:'initial-in-progress',firstStartedItemKey:other.itemKey,firstStartedAt:'2026-08-31T01:00:00.000Z'});
  const plan=await generate(input);
  assert.ok(plan.tasks.some(task=>task.action.itemKeys.includes(other.itemKey)));
  assert.ok(plan.tasks.some(task=>task.action.itemKeys.includes(first.itemKey)));
  assert.equal(plan.tasks.filter(task=>task.required && task.category==='new-word').reduce((sum,t)=>sum+t.quantity,0),20);
});

test('actual first-start identity never adopts a changed live source over its frozen snapshot',async()=>{
  const {editTaskPlan}=await import('../app/task-plan-edit.ts');
  const input=vocabularyInput(1),initial=await generate(input);
  input.previous=await editTaskPlan(initial,{type:'start',taskId:initial.tasks[0].taskId},input.catalog);
  Object.assign(input.words[0],{status:'initial-in-progress',firstStartedItemKey:'word:0',firstStartedAt:'2026-08-31T01:00:00.000Z'});
  input.catalog.subjects[0].words[0].sourceHash='b'.repeat(64);
  const plan=await generate(input);
  assert.equal(plan.vocabulary.snapshot[0].sourceHash,'a'.repeat(64));assert.ok(plan.tasks[0].blockedReason);
});
test('seven new completions leave thirteen, not a fresh allocation of twenty',async()=>{
  const input=vocabularyInput();input.previous=await generate(input);
  const completed=new Set(input.previous.vocabulary.assignedLexemeKeys.slice(0,7));
  input.words.filter(w=>completed.has(w.lexemeKey)).forEach(w=>Object.assign(w,{status:'learned',firstLearnedAt:'2026-08-31T01:00:00.000Z'}));
  const plan=await generate(input);
  assert.deepEqual(plan.vocabulary.assignedLexemeKeys,input.previous.vocabulary.assignedLexemeKeys);
  assert.equal(api.remainingNewWords(input.day,input.words),13);
});
test('short libraries expose actual available count without using old reviews as new words',async()=>{
  const input=vocabularyInput(12);
  input.words[0]={...input.words[0],status:'learned',firstLearnedAt:'2026-08-30T00:00:00.000Z'};
  const plan=await generate(input);
  assert.equal(plan.vocabulary.target,20);
  assert.equal(plan.vocabulary.assignedLexemeKeys.length,11);
});
test('yesterday unfinished first learning fills today quota instead of adding a second quota',async()=>{
  const input=vocabularyInput(30);
  input.words[25].status='initial-in-progress';input.words[25].firstStartedAt='2026-08-30T01:00:00.000Z';
  const plan=await generate(input);
  assert.equal(plan.vocabulary.assignedLexemeKeys.length,20);
  assert.ok(plan.vocabulary.assignedLexemeKeys.includes('en:term25'));
});
test('the daily target is global across vocabulary subjects',async()=>{
  const input=vocabularyInput(15),other=vocabularyInput(15);
  other.catalog.subjects[0].subjectId='other';
  other.catalog.subjects[0].words.forEach((w,i)=>Object.assign(w,{subjectId:'other',itemKey:`word:other:${i}`,word:`other${i}`}));
  input.catalog.subjects.push(other.catalog.subjects[0]);
  input.words.push(...other.catalog.subjects[0].words.map(w=>({lexemeKey:`en:${w.word}`,itemKeys:[w.itemKey],status:'unseen'})));
  assert.equal((await generate(input)).vocabulary.assignedLexemeKeys.length,20);
});
test('zero optional minutes does not delete mandatory work',async()=>{
  const input=vocabularyInput(20);input.optionalMinutes=0;
  assert.equal((await generate(input)).vocabulary.assignedLexemeKeys.length,20);
});
test('review tasks name the real learning content instead of an internal identifier',async()=>{
  const input=vocabularyInput(1);
  input.reviews=[{roundId:'known-review',itemKey:'word:0',subjectId:'vocab',dueAt:'2026-08-30T00:00:00.000Z',
    completed:false,completionRule:'three-stage'}];
  const task=(await generate(input)).tasks.find(t=>t.category==='review');
  assert.match(task.title,/term0/);
});
test('goals consume real unit completion with the matching evidence basis',async()=>{
  const input=vocabularyInput(0);input.catalog.subjects.push(courseSubject());
  input.completions=[{taskId:'already',unitId:'course:u0',occurredAt:'2026-08-31T00:00:00.000Z',basis:'self-report'}];
  const plan=await generate(input);
  const tasks=plan.tasks.filter(task=>task.category==='subject');
  assert.equal(tasks.length,1);assert.deepEqual(tasks[0].unitIds,['course:u1']);
  input.completions[0].basis='practice-round';
  assert.equal((await generate(input)).tasks.filter(task=>task.category==='subject').length,2);
});

test('formal-state goals subtract already satisfied canonical units without fabricating completion dates',async()=>{
  const input=vocabularyInput(0),subject=courseSubject(5,{completionBasis:'formal-state',targetCount:2});
  subject.units.forEach(unit=>{unit.completionRule='formal-done';});subject.units[0].formalComplete=true;
  input.catalog.subjects.push(subject);
  assert.equal((await generate(input)).tasks.filter(task=>task.category==='subject').length,1);
  subject.units[1].formalComplete=true;
  assert.equal((await generate(input)).tasks.filter(task=>task.category==='subject').length,0);
  assert.deepEqual(input.completions,[]);
});
test('weekly and deadline quotas distribute only the remaining target',()=>{
  assert.ok(api);
  const goal=courseSubject(9,{kind:'weekly',targetCount:7}).goals[0];
  const done=[{taskId:'done',unitId:'course:u0',occurredAt:'2026-08-31T00:00:00.000Z',basis:'self-report'}];
  assert.equal(api.goalQuota(goal,'2026-08-31',done,8),1);
  assert.equal(api.goalQuota(goal,'2026-09-06',done,8),6);
  assert.equal(api.goalQuota({...goal,kind:'deadline',dueOn:'2026-09-02'},'2026-08-31',done,8),2);
  assert.equal(api.goalQuota({...goal,kind:'deadline',dueOn:'2026-08-30',startOn:'2026-08-24'},'2026-08-31',done,8),6);
});
test('overlapping goals do not duplicate the same learning unit',async()=>{
  const input=vocabularyInput(0),subject=courseSubject();
  subject.goals.push({...subject.goals[0],goalId:'course:overlap'});
  input.catalog.subjects.push(subject);
  const units=(await generate(input)).tasks.flatMap(task=>task.unitIds);
  assert.equal(units.length,2);assert.equal(new Set(units).size,2);
});
test('invalid explicit goals and unsatisfied prerequisites do not create guesswork',async()=>{
  const input=vocabularyInput(0),subject=courseSubject();
  subject.units.forEach(unit=>unit.prerequisites=['course:missing']);input.catalog.subjects.push(subject);
  assert.equal((await generate(input)).tasks.length,0);
  subject.planningStatus='invalid';subject.units.forEach(unit=>unit.prerequisites=[]);
  assert.equal((await generate(input)).tasks.length,0);
});
test('same explicit input produces the same plan and hash without mutating it',async()=>{
  const input=vocabularyInput(),before=structuredClone(input);
  assert.deepEqual(await generate(input),await generate(input));
  assert.deepEqual(input,before);
});
test('extra first completions do not raise tomorrow target or issue more mandatory words',async()=>{
  const input=vocabularyInput(30);
  input.words.slice(0,25).forEach(w=>Object.assign(w,{status:'learned',firstLearnedAt:'2026-08-31T01:00:00.000Z'}));
  const plan=await generate(input);
  assert.equal(plan.vocabulary.target,20);
  assert.equal(api.remainingNewWords(input.day,input.words),0);
  assert.equal(plan.tasks.filter(task=>task.category==='new-word').flatMap(t=>t.action.itemKeys).filter(key=>Number(key.split(':')[1])>=25).length,0);
});
test('completed recurring practice is counted once per period after its deadline',()=>{
  assert.ok(api);
  for (const [kind,startOn,dueOn,dates] of [
    ['daily','2026-08-29','2026-08-30',['2026-08-29','2026-08-30']],
    ['weekly','2026-08-17','2026-08-30',['2026-08-17','2026-08-24']],
  ]) {
    const goal=courseSubject(6,{kind,startOn,dueOn,targetCount:2,completionBasis:'practice-round'}).goals[0];
    const done=dates.flatMap(day=>[0,1].map(i=>({taskId:`done-${day}-${i}`,unitId:`course:u${i}`,occurredAt:`${day}T00:00:00.000Z`,basis:'practice-round'})));
    assert.equal(api.goalQuota(goal,'2026-08-31',done,6),0);
  }
});
test('shrinking an allocation retains an already started word before untouched words',async()=>{
  const input=vocabularyInput(30);input.previous=await generate(input);
  input.words[19].status='initial-in-progress';input.words[19].firstStartedAt='2026-08-31T00:00:00.000Z';
  input.words.slice(20,27).forEach(w=>Object.assign(w,{status:'learned',firstLearnedAt:'2026-08-31T01:00:00.000Z'}));
  assert.ok((await generate(input)).vocabulary.assignedLexemeKeys.includes('en:term19'));
});
test('already started excess words remain optional without increasing the fixed target',async()=>{
  const input=vocabularyInput(40);input.previous=await generate(input);
  input.words.slice(0,15).forEach(w=>Object.assign(w,{status:'initial-in-progress',firstStartedAt:'2026-08-31T00:00:00.000Z'}));
  input.words.slice(20,27).forEach(w=>Object.assign(w,{status:'learned',firstLearnedAt:'2026-08-31T01:00:00.000Z'}));
  const plan=await generate(input),tasks=plan.tasks.filter(t=>t.category==='new-word');
  assert.ok(input.words.slice(0,15).every(w=>plan.vocabulary.assignedLexemeKeys.includes(w.lexemeKey)));
  assert.equal(tasks.filter(t=>t.required).reduce((n,t)=>n+t.quantity,0),20);
  assert.equal(tasks.filter(t=>!t.required).reduce((n,t)=>n+t.quantity,0),2);
});
test('equally ranked vocabulary sources rotate instead of starving the later source',async()=>{
  const input=vocabularyInput(30),other=vocabularyInput(30);
  other.catalog.subjects[0].subjectId='z-other';
  other.catalog.subjects[0].words.forEach((w,i)=>Object.assign(w,{subjectId:'z-other',itemKey:`word:z:${i}`,word:`other${i}`}));
  input.catalog.subjects.push(other.catalog.subjects[0]);
  input.words.push(...other.catalog.subjects[0].words.map(w=>({lexemeKey:`en:${w.word}`,itemKeys:[w.itemKey],status:'unseen'})));
  const tasks=(await generate(input)).tasks.filter(t=>t.category==='new-word');
  assert.equal(tasks.find(t=>t.subjectId==='vocab').quantity,10);
  assert.equal(tasks.find(t=>t.subjectId==='z-other').quantity,10);
});
test('unfinished vocabulary retains its physical source across the day rotation',async()=>{
  const input=vocabularyInput(1),other=vocabularyInput(1).catalog.subjects[0];
  other.subjectId='z-other';other.words[0]={...other.words[0],subjectId:'z-other',itemKey:'word:other:0'};
  input.catalog.subjects.push(other);input.words[0].itemKeys.push('word:other:0');
  input.previous=await generate(input);
  const physical=input.previous.tasks.find(t=>t.category==='new-word').action.itemKeys[0];
  input.words[0].status='initial-in-progress';input.words[0].firstStartedAt='2026-08-31T00:00:00.000Z';
  input.day='2026-09-01';
  const carried=(await generate(input)).tasks.find(t=>t.category==='new-word');
  assert.deepEqual(carried.action.itemKeys,[physical]);
});
test('an overdue recurring practice goal can reuse units from a previously completed period',async()=>{
  const input=vocabularyInput(0),subject=courseSubject(2,{kind:'daily',targetCount:2,startOn:'2026-08-29',dueOn:'2026-08-30',completionBasis:'practice-round'});
  subject.units.forEach((unit,i)=>Object.assign(unit,{action:{kind:'practice',itemKeys:[`practice:u${i}`]},completionRule:'graded-practice'}));
  input.catalog.subjects.push(subject);
  input.completions=[0,1].map(i=>({taskId:`old-u${i}`,unitId:`course:u${i}`,occurredAt:'2026-08-29T00:00:00.000Z',basis:'practice-round'}));
  assert.equal((await generate(input)).tasks.filter(t=>t.category==='subject').length,2);
});
test('practice completed before a new weekly goal starts does not block its quota',async()=>{
  const input=vocabularyInput(0),subject=courseSubject(2,{kind:'weekly',targetCount:2,startOn:'2026-09-02',completionBasis:'practice-round'});
  input.day='2026-09-02';
  subject.units.forEach((unit,i)=>Object.assign(unit,{action:{kind:'practice',itemKeys:[`practice:u${i}`]},completionRule:'graded-practice'}));
  input.catalog.subjects.push(subject);
  input.completions=[0,1].map(i=>({taskId:`before-goal-${i}`,unitId:`course:u${i}`,occurredAt:'2026-08-31T00:00:00.000Z',basis:'practice-round'}));
  assert.equal((await generate(input)).tasks.filter(t=>t.category==='subject').length,1);
});
