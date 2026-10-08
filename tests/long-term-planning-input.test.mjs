import assert from 'node:assert/strict';
import test from 'node:test';
import {vocabularyInput,courseSubject} from './fixtures/task-plan-input.mjs';
import {generateLongTermSchedule} from '../app/long-term-pacing.ts';

let api;
try { api=await import('../app/long-term-planning-input.ts'); }
catch(error) { if(error.code!=='ERR_MODULE_NOT_FOUND')throw error; }
function build(input,options={}) {
  assert.equal(typeof api?.buildLongTermPlanningInput,'function','Long-term inventory adapter must exist');
  return api.buildLongTermPlanningInput(input,options);
}

test('cross-library vocabulary deduplicates by lexeme and preserves the started physical source',()=>{
  const input=vocabularyInput(1),word=input.catalog.subjects[0].words[0];
  input.catalog.subjects.push({...input.catalog.subjects[0],subjectId:'second',priority:1,words:[{...word,itemKey:'second:word',subjectId:'second'}]});
  Object.assign(input.words[0],{status:'initial-in-progress',firstStartedItemKey:'second:word',firstStartedAt:'2026-08-30T03:00:00Z',itemKeys:['word:0','second:word']});
  const result=build(input);
  assert.equal(result.inventory.length,1);
  assert.equal(result.inventory[0].itemId,'second:word');
  assert.equal(result.inventory[0].subjectId,'second');
  assert.deepEqual(result.bindings[0].itemKeys,['second:word']);
});

test('first learning completion counts a round without claiming mastery or deleting its review card',()=>{
  const input=vocabularyInput(1);
  Object.assign(input.words[0],{status:'learned',firstLearnedAt:'2026-08-30T03:00:00Z',firstLearnedItemKey:'word:0'});
  const card={due:'2026-09-01T03:00:00Z',stability:2,difficulty:4,elapsed_days:1,scheduled_days:2,learning_steps:0,reps:1,lapses:0,state:2,last_review:'2026-08-30T03:00:00Z'};
  const result=build(input,{fsrsByItemKey:{'word:0':{sourceHash:'a'.repeat(64),card}}});
  assert.equal(result.inventory[0].completedRounds,1);
  assert.notEqual(result.inventory[0].mastered,true);
  assert.deepEqual(result.fsrsMap['word:0'],card);
});

test('unknown historical vocabulary remains visible and blocked rather than becoming unseen or mastered',()=>{
  const input=vocabularyInput(1); input.words[0].status='history-unknown';
  const result=build(input);
  assert.equal(result.inventory.length,1);
  assert.match(result.inventory[0].blockedReason,/历史/);
  assert.equal(result.inventory[0].completedRounds,0);
  assert.notEqual(result.inventory[0].mastered,true);
});

test('self-reported lessons count distinct completed days but cannot satisfy formal mastery',()=>{
  const input=vocabularyInput(0);input.catalog.subjects.push(courseSubject(1));
  input.completions=[
    {taskId:'a',unitId:'course:u0',occurredAt:'2026-08-30T03:00:00Z',basis:'self-report'},
    {taskId:'duplicate-day',unitId:'course:u0',occurredAt:'2026-08-30T04:00:00Z',basis:'self-report'},
    {taskId:'future',unitId:'course:u0',occurredAt:'2026-09-01T03:00:00Z',basis:'self-report'},
    {taskId:'wrong-basis',unitId:'course:u0',occurredAt:'2026-08-29T03:00:00Z',basis:'practice-round'},
  ];
  const item=build(input).inventory[0];
  assert.equal(item.completedRounds,1);
  assert.notEqual(item.mastered,true);
});

test('only the explicit formal-mastered rule can project formal mastery',()=>{
  const input=vocabularyInput(0),subject=courseSubject(2);input.catalog.subjects.push(subject);
  Object.assign(subject.units[0],{completionRule:'formal-mastered',formalComplete:true});
  Object.assign(subject.units[1],{completionRule:'formal-done',formalComplete:true});
  const result=build(input);
  assert.equal(result.inventory.find(item=>item.itemId==='course:u0').mastered,true);
  assert.notEqual(result.inventory.find(item=>item.itemId==='course:u1').mastered,true);
  assert.equal(result.inventory.find(item=>item.itemId==='course:u1').completedRounds,1);
});

test('review-only practice sources enter inventory and changed source versions do not inherit old FSRS cards',()=>{
  const input=vocabularyInput(0);
  input.catalog.subjects.push({...courseSubject(0),subjectId:'concept'});
  input.catalog.practiceSources=[{itemKey:'recall:1',subjectId:'concept',sourceHash:'c'.repeat(64),title:'Recall',completionRule:'graded-practice'}];
  const result=build(input,{fsrsByItemKey:{'recall:1':{sourceHash:'b'.repeat(64),card:{due:'2026-09-01T03:00:00Z'}}}});
  assert.equal(result.inventory[0].itemId,'recall:1');
  assert.equal(result.fsrsMap['recall:1'],undefined);
  assert.ok(result.diagnostics.some(entry=>entry.code==='stale-review-card'));
});

test('duplicate physical identities with conflicting content fail before an ambiguous plan can be built',()=>{
  const input=vocabularyInput(1),word=input.catalog.subjects[0].words[0];
  input.catalog.subjects.push({...input.catalog.subjects[0],subjectId:'other',words:[{...word,subjectId:'other',word:'different',sourceHash:'b'.repeat(64)}]});
  assert.throws(()=>build(input),/conflicting-long-term-item/);
});

test('explicit item estimates override declared fallback estimates without modifying source material',()=>{
  const input=vocabularyInput(1),subject=courseSubject(1);input.catalog.subjects.push(subject);subject.units[0].estimatedMinutes=25;
  const before=structuredClone(input);
  const result=build(input,{estimates:{vocabularyMinutes:4,practiceMinutes:12,materialMinutes:18,reviewMinutes:2}});
  assert.equal(result.inventory.find(item=>item.itemId==='word:0').estimatedMinutes,4);
  assert.equal(result.inventory.find(item=>item.itemId==='course:u0').estimatedMinutes,25);
  assert.deepEqual(input,before);
  assert.ok(result.assumptions.some(entry=>entry.includes('4')));
});

test('invalid fallback estimates are rejected rather than making impossible capacity look feasible',()=>{
  assert.throws(()=>build(vocabularyInput(1),{estimates:{vocabularyMinutes:0,practiceMinutes:12,materialMinutes:18,reviewMinutes:2}}),/invalid-long-term-estimate/);
});

test('declared prerequisites survive inventory conversion so pacing cannot place advanced work first',()=>{
  const input=vocabularyInput(0),subject=courseSubject(2);input.catalog.subjects.push(subject);
  subject.units[1].prerequisites=['course:u0'];
  const result=build(input);
  assert.deepEqual(result.inventory.find(item=>item.itemId==='course:u1').prerequisiteItemIds,['course:u0']);
});

test('removed prerequisite material blocks dependent work explicitly',()=>{
  const input=vocabularyInput(0),subject=courseSubject(1);input.catalog.subjects.push(subject);
  subject.units[0].prerequisites=['removed-unit'];
  const item=build(input).inventory[0];
  assert.match(item.blockedReason,/前置/);
});

test('estimate objects cannot substitute an unrelated field for a required duration',()=>{
  assert.throws(()=>build(vocabularyInput(1),{estimates:{typoMinutes:3,practiceMinutes:12,materialMinutes:18,reviewMinutes:2}}),/invalid-long-term-estimate/);
});

test('single-source practice uses the physical source identity, hash, card, and unit binding',()=>{
  const input=vocabularyInput(0),subject=courseSubject(1),sourceHash='c'.repeat(64);
  input.catalog.subjects.push(subject);
  Object.assign(subject.units[0],{action:{kind:'practice',itemKeys:['practice:one']},estimatedMinutes:18});
  input.catalog.practiceSources=[{itemKey:'practice:one',subjectId:'course',sourceHash,title:'One',completionRule:'graded-practice'}];
  const card={due:'2026-08-31T00:00:00Z',stability:2,difficulty:4,elapsed_days:1,scheduled_days:2,learning_steps:0,reps:1,lapses:1,state:1,last_review:'2026-08-30T00:00:00Z'};
  const result=build(input,{fsrsByItemKey:{'practice:one':{sourceHash,card}}});
  assert.deepEqual(result.inventory.map(item=>({itemId:item.itemId,sourceHash:item.sourceHash,estimatedMinutes:item.estimatedMinutes})),[
    {itemId:'practice:one',sourceHash,estimatedMinutes:18},
  ]);
  assert.deepEqual(result.bindings[0].unitIds,['course:u0']);
  assert.deepEqual(result.fsrsMap['practice:one'],card);
});

test('grouped practice expands to physical cards, preserves dependencies, and retains the declared unit cost once',()=>{
  const input=vocabularyInput(0),subject=courseSubject(2),hashOne='c'.repeat(64),hashTwo='d'.repeat(64);
  input.catalog.subjects.push(subject);
  Object.assign(subject.units[0],{action:{kind:'practice',itemKeys:['practice:one','practice:two']},estimatedMinutes:21});
  subject.units[1].prerequisites=['course:u0'];
  input.catalog.practiceSources=[
    {itemKey:'practice:one',subjectId:'course',sourceHash:hashOne,title:'One',completionRule:'graded-practice'},
    {itemKey:'practice:two',subjectId:'course',sourceHash:hashTwo,title:'Two',completionRule:'graded-practice'},
  ];
  const cardOne={due:'2026-08-31T00:00:00Z',stability:2,difficulty:4,elapsed_days:1,scheduled_days:2,learning_steps:0,reps:2,lapses:0,state:2,last_review:'2026-08-30T00:00:00Z'};
  const cardTwo={...cardOne,difficulty:5};
  input.completions=[{taskId:'done',unitId:'course:u0',occurredAt:'2026-08-30T03:00:00Z',basis:'self-report'}];
  const result=build(input,{fsrsByItemKey:{'practice:one':{sourceHash:hashOne,card:cardOne},'practice:two':{sourceHash:hashTwo,card:cardTwo}}});
  const practices=result.inventory.filter(item=>item.itemId.startsWith('practice:'));
  assert.deepEqual(practices.map(item=>item.itemId),['practice:one','practice:two']);
  assert.equal(practices.reduce((sum,item)=>sum+item.estimatedMinutes,0),21);
  assert.ok(practices.every(item=>item.completedRounds===1));
  assert.deepEqual(result.inventory.find(item=>item.itemId==='course:u1').prerequisiteItemIds,['practice:one','practice:two']);
  assert.deepEqual(Object.keys(result.fsrsMap).sort(),['practice:one','practice:two']);
});

test('matching FSRS activity alone retains review work but blocks uncertain source-only fresh acquisition',()=>{
  const input=vocabularyInput(0),sourceHash='c'.repeat(64);
  input.catalog.subjects.push({...courseSubject(0),subjectId:'practice'});
  input.catalog.practiceSources=[{itemKey:'practice:one',subjectId:'practice',sourceHash,title:'One',completionRule:'graded-practice'}];
  const card={due:'2026-08-31T00:00:00Z',stability:2,difficulty:4,elapsed_days:1,scheduled_days:1,learning_steps:1,reps:3,lapses:2,state:1,last_review:'2026-08-30T00:00:00Z'};
  const result=build(input,{fsrsByItemKey:{'practice:one':{sourceHash,card}}});
  const item=result.inventory[0];
  assert.equal(item.completedRounds,0);
  assert.match(item.blockedReason,/完成证据/);
  assert.deepEqual(result.fsrsMap['practice:one'],card);
});

test('expanded practice reaches scheduling with both cards and without duplicated acquisition workload',()=>{
  const input=vocabularyInput(0),subject=courseSubject(1),hashOne='c'.repeat(64),hashTwo='d'.repeat(64);
  input.catalog.subjects.push(subject);
  Object.assign(subject.units[0],{action:{kind:'practice',itemKeys:['practice:one','practice:two']},estimatedMinutes:20});
  input.catalog.practiceSources=[
    {itemKey:'practice:one',subjectId:'course',sourceHash:hashOne,title:'One',completionRule:'graded-practice'},
    {itemKey:'practice:two',subjectId:'course',sourceHash:hashTwo,title:'Two',completionRule:'graded-practice'},
  ];
  input.completions=[{taskId:'done',unitId:'course:u0',occurredAt:'2026-08-30T03:00:00Z',basis:'self-report'}];
  const card={due:'2026-08-31T00:00:00Z',stability:2,difficulty:4,elapsed_days:1,scheduled_days:1,learning_steps:0,reps:1,lapses:0,state:2,last_review:'2026-08-30T00:00:00Z'};
  const result=build(input,{fsrsByItemKey:{'practice:one':{sourceHash:hashOne,card},'practice:two':{sourceHash:hashTwo,card}}});
  const plan=generateLongTermSchedule(result.inventory,{planId:'p',startDate:'2026-08-31',targetDeadline:'2026-08-31',dailyMinutesBudget:{workdayMin:0,workdayMax:30,weekendMax:30,minReviewRatio:0},subjectsConfig:[{subjectId:'course',priority:1,completionCriteria:'all-mastered'}],bufferRatio:0},result.fsrsMap,{asOfDate:'2026-08-31',generatedAt:'2026-08-31T00:00:00.000Z'});
  assert.equal(plan.inventory.reduce((sum,item)=>sum+item.estimatedMinutes,0),20);
  assert.deepEqual(plan.schedule[0].reviewItemIds.sort(),['practice:one','practice:two']);
  assert.equal(plan.schedule[0].reviewMinutes,4);
  assert.deepEqual(plan.schedule[0].newItemIds,[]);
});

test('shared physical practice merges unit bindings, dependencies, evidence, cost, and card without duplication',()=>{
  const input=vocabularyInput(0),subject=courseSubject(4),sourceHash='c'.repeat(64);
  input.catalog.subjects.push(subject);
  Object.assign(subject.units[0],{action:{kind:'practice',itemKeys:['practice:shared']},estimatedMinutes:18,prerequisites:['course:u2']});
  Object.assign(subject.units[1],{action:{kind:'practice',itemKeys:['practice:shared']},estimatedMinutes:30,prerequisites:['course:u3']});
  input.catalog.practiceSources=[{itemKey:'practice:shared',subjectId:'course',sourceHash,title:'Shared',completionRule:'graded-practice'}];
  input.completions=[{taskId:'done',unitId:'course:u0',occurredAt:'2026-08-30T03:00:00Z',basis:'self-report'}];
  const card={due:'2026-08-31T00:00:00Z',stability:2,difficulty:4,elapsed_days:1,scheduled_days:1,learning_steps:0,reps:1,lapses:0,state:2,last_review:'2026-08-30T00:00:00Z'};
  const result=build(input,{fsrsByItemKey:{'practice:shared':{sourceHash,card}}});
  const items=result.inventory.filter(item=>item.itemId==='practice:shared');
  assert.equal(items.length,1);
  assert.equal(items[0].estimatedMinutes,30);
  assert.equal(items[0].completedRounds,1);
  assert.deepEqual(items[0].prerequisiteItemIds,['course:u2','course:u3']);
  assert.deepEqual(result.bindings.find(binding=>binding.itemId==='practice:shared').unitIds,['course:u0','course:u1']);
  assert.deepEqual(result.fsrsMap['practice:shared'],card);
  assert.ok(result.assumptions.some(entry=>entry.includes('只计一次获取成本')));
});

test('duplicate practice declarations deduplicate only when physical subject and hash agree',()=>{
  const input=vocabularyInput(0),subject=courseSubject(1),sourceHash='c'.repeat(64);
  input.catalog.subjects.push(subject);
  subject.units[0].action={kind:'practice',itemKeys:['practice:shared']};
  const source={itemKey:'practice:shared',subjectId:'course',sourceHash,title:'Shared',completionRule:'graded-practice'};
  input.catalog.practiceSources=[source,{...source,title:'Shared alias'}];
  assert.equal(build(input).inventory.filter(item=>item.itemId==='practice:shared').length,1);
  input.catalog.practiceSources[1]={...source,sourceHash:'d'.repeat(64)};
  assert.throws(()=>build(input),/conflicting-long-term-item/);
});

test('shared practice unions distinct qualifying completion days across units',()=>{
  const input=vocabularyInput(0),subject=courseSubject(2),sourceHash='c'.repeat(64);
  input.catalog.subjects.push(subject);
  for(const unit of subject.units)Object.assign(unit,{action:{kind:'practice',itemKeys:['practice:shared']},completionRule:'graded-practice'});
  input.catalog.practiceSources=[{itemKey:'practice:shared',subjectId:'course',sourceHash,title:'Shared',completionRule:'graded-practice'}];
  input.completions=[
    {taskId:'first',unitId:'course:u0',occurredAt:'2026-08-29T03:00:00Z',basis:'practice-round'},
    {taskId:'second',unitId:'course:u1',occurredAt:'2026-08-30T03:00:00Z',basis:'practice-round'},
    {taskId:'wrong-basis',unitId:'course:u1',occurredAt:'2026-08-28T03:00:00Z',basis:'self-report'},
    {taskId:'future',unitId:'course:u0',occurredAt:'2026-09-01T03:00:00Z',basis:'practice-round'},
  ];
  const item=build(input).inventory.find(entry=>entry.itemId==='practice:shared');
  assert.equal(item.completedRounds,2);
  assert.notEqual(item.mastered,true);
});

test('shared practice counts same-day unit completion aliases once',()=>{
  const input=vocabularyInput(0),subject=courseSubject(2),sourceHash='c'.repeat(64);
  input.catalog.subjects.push(subject);
  for(const unit of subject.units)Object.assign(unit,{action:{kind:'practice',itemKeys:['practice:shared']},completionRule:'graded-practice'});
  input.catalog.practiceSources=[{itemKey:'practice:shared',subjectId:'course',sourceHash,title:'Shared',completionRule:'graded-practice'}];
  input.completions=[
    {taskId:'first-day',unitId:'course:u0',occurredAt:'2026-08-29T03:00:00Z',basis:'practice-round'},
    {taskId:'alias-one',unitId:'course:u0',occurredAt:'2026-08-30T03:00:00Z',basis:'practice-round'},
    {taskId:'alias-two',unitId:'course:u1',occurredAt:'2026-08-30T04:00:00Z',basis:'practice-round'},
    {taskId:'third-day',unitId:'course:u1',occurredAt:'2026-08-31T04:00:00Z',basis:'practice-round'},
  ];
  const item=build(input).inventory.find(entry=>entry.itemId==='practice:shared');
  assert.equal(item.completedRounds,3);
  assert.notEqual(item.mastered,true);
});
test('versioned physical completion days union with unit evidence and reject stale or future days',()=>{
 const input=vocabularyInput(0),subject=courseSubject(1),sourceHash='c'.repeat(64);input.catalog.subjects.push(subject);subject.units[0].action={kind:'practice',itemKeys:['practice:one']};input.catalog.practiceSources=[{itemKey:'practice:one',subjectId:'course',sourceHash,title:'One',completionRule:'graded-practice'}];input.completions=[{taskId:'unit',unitId:'course:u0',occurredAt:'2026-08-30T03:00:00Z',basis:'self-report'}];
 const options={completedPracticeDays:{'practice:one':{sourceHash,days:['2026-08-30','2026-08-30','2026-08-31','2026-09-01']}}};const before=structuredClone({input,options});assert.equal(build(input,options).inventory[0].completedRounds,2);assert.deepEqual({input,options},before);options.completedPracticeDays['practice:one'].sourceHash='d'.repeat(64);assert.equal(build(input,options).inventory[0].completedRounds,1);
});
