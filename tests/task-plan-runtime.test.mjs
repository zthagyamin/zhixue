import assert from 'node:assert/strict';
import test from 'node:test';
import {vocabularyInput,courseSubject} from './fixtures/task-plan-input.mjs';
import {generateTaskPlan} from '../app/task-plan-engine.ts';
import {attempt,catalog} from './fixtures/task-event-fixtures.mjs';
let api;
try {api=await import('../app/task-plan-runtime.ts');}
catch(error) {if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;}
function ready(){assert.equal(typeof api?.summarizeTaskPlan,'function','Task runtime adapter must exist');}
test('review completion cannot fill the new-word target',async()=>{
  ready();const input=vocabularyInput(20),plan=await generateTaskPlan(input);
  const reviews=[{roundId:'r1',itemKey:'word:old',subjectId:'vocab',dueAt:'2026-08-30T00:00:00Z',completed:true,completionRule:'three-stage'}];
  const result=api.summarizeTaskPlan(plan,[],reviews,[]);
  assert.equal(result.newDone,0);assert.equal(result.reviewDone,1);assert.equal(result.reviewTotal,1);
});
test('short available word supply displays the real shortage',async()=>{
  ready();const input=vocabularyInput(7),plan=await generateTaskPlan(input);
  assert.equal(api.summarizeTaskPlan(plan,input.words,[],[]).newMissing,13);
});
test('vocabulary practice adapter contains only exact task keys and never a whole library',async()=>{
  ready();const input=vocabularyInput(40),plan=await generateTaskPlan(input),task=plan.tasks[0];
  const adapted=api.practicePlanForTask(plan,task.taskId,input.catalog);
  assert.equal(adapted.items.length,1);assert.equal(adapted.items[0].practice.kind,'vocab-group');
  assert.deepEqual(adapted.items[0].practice.itemKeys,task.action.itemKeys);assert.equal(adapted.items[0].practice.count,20);
});
test('multi-question task maps and loads each exact question independently',async()=>{
  ready();const input=vocabularyInput(0),subject=courseSubject(1);
  subject.units[0].action={kind:'practice',itemKeys:['practice:q1','practice:q2']};subject.units[0].completionRule='graded-practice';
  subject.goals[0].completionBasis='practice-round';input.catalog.subjects.push(subject);
  const plan=await generateTaskPlan(input),task=plan.tasks[0];
  const pool=['q1','q2','q3'].map(itemId=>({itemId,abilityId:`ability:${itemId}`,domain:'paper',sourceNote:'n.md',stateRef:'s.md',questionType:'recall',prompt:itemId,fingerprint:itemId,sourceLabel:'fixture'}));
  assert.deepEqual(api.practiceForTask(plan,task.taskId,input.catalog,[],pool).map(item=>item.itemId),['q1','q2']);
  assert.equal(api.practicePlanForTask(plan,task.taskId,input.catalog).items.length,2);
});
test('a review-only source can load its embedded question even after leaving the due-only remote pool',async()=>{
  ready();const input=vocabularyInput(0);
  input.catalog.practiceSources=[{itemKey:'practice:result',subjectId:'vocab',title:'Review',sourceHash:'a'.repeat(64),completionRule:'graded-practice'}];
  input.reviews=[{roundId:'review:result',itemKey:'practice:result',subjectId:'vocab',dueAt:'2026-08-31T00:00:00Z',completed:false,completionRule:'graded-practice'}];
  const plan=await generateTaskPlan(input),item={itemId:'result',abilityId:'result',domain:'paper',sourceNote:'n.md',stateRef:'s.md',questionType:'recall',prompt:'Real review point',fingerprint:'r',sourceLabel:'Review'};
  const subjects=[{id:'vocab',name:'Subject',pluginType:'recall',items:[{itemId:'result',abilityId:'result',practiceItem:item,reviewOnly:true}]}];
  assert.equal(api.practiceForTask(plan,plan.tasks[0].taskId,input.catalog,subjects,[])[0].prompt,item.prompt);
});
test('note tasks and blocked source tasks cannot create invented practice questions',async()=>{
  ready();const input=vocabularyInput(0);input.catalog.subjects.push(courseSubject(1));
  const plan=await generateTaskPlan(input);
  assert.throws(()=>api.practicePlanForTask(plan,plan.tasks[0].taskId,input.catalog),/not-practice/);
  const vocab=vocabularyInput(1),words=await generateTaskPlan(vocab);words.tasks[0].blockedReason='source changed';
  assert.throws(()=>api.practicePlanForTask(words,words.tasks[0].taskId,vocab.catalog),/source changed/);
});
test('AI suggestions add real registered optional units while less preserves protected work',async()=>{
  ready();assert.equal(typeof api.applyTaskSuggestions,'function');
  const input=vocabularyInput(1),subject=courseSubject(4);subject.goals=[];input.catalog.subjects.push(subject);
  const plan=await generateTaskPlan(input);
  const response={day:plan.day,sourceHash:plan.sourceHash,draftVersion:plan.draftVersion,mode:'fallback',message:'no key',selections:[{unitIds:['course:u0'],reason:'next'}]};
  const withSuggestion=await api.applyTaskSuggestions(plan,response,input.catalog);
  const task=withSuggestion.tasks.find(task=>task.origin==='fallback');assert.ok(task);assert.equal(task.required,false);
  const protectedPlan={...withSuggestion,manual:{...withSuggestion.manual,lockedTaskIds:[task.taskId]}};
  assert.ok((await api.prepareTaskSuggestion(protectedPlan,'less',[])).tasks.some(item=>item.taskId===task.taskId));
  const reduced=await api.prepareTaskSuggestion(withSuggestion,'less',[]);
  assert.ok(!reduced.tasks.some(item=>item.taskId===task.taskId));assert.ok(reduced.tasks.some(item=>item.required));
  assert.ok(reduced.manual.excludedUnitIds.includes('course:u0'));
});
test('stale or invented suggestion identities cannot enter the task list',async()=>{
  ready();assert.equal(typeof api.applyTaskSuggestions,'function');
  const input=vocabularyInput(0),plan=await generateTaskPlan(input);
  const response={day:plan.day,sourceHash:plan.sourceHash,draftVersion:plan.draftVersion,mode:'ai',message:'',selections:[{unitIds:['invented'],reason:'next'}]};
  await assert.rejects(api.applyTaskSuggestions(plan,response,input.catalog),/unknown-suggestion-unit/);
  await assert.rejects(api.applyTaskSuggestions(plan,{...response,sourceHash:'b'.repeat(64)},input.catalog),/stale-suggestion/);
});
test('a second review round cannot inherit the first completed round stages',async()=>{
  ready();assert.equal(typeof api.taskWordStages,'function');
  const a=await attempt('review-stage-anchor','2026-08-31T01:00:00Z',2,3);
  const b=await attempt('review-stage-next','2026-08-31T02:00:00Z',0,1);
  const task={subjectId:'vocab',category:'review',action:{kind:'practice',itemKeys:['word:tree']}};
  const round={anchorEventId:a.eventId,itemKey:'word:tree',completed:false};
  assert.equal(api.taskWordStages(task,round,[a],{'word:tree':3},catalog())['word:tree'],0);
  assert.equal(api.taskWordStages(task,round,[a,b],{'word:tree':3},catalog())['word:tree'],1);
});
test('a legacy review alias also resets the canonical progress key used by the module',()=>{
  ready();const data=catalog();data.subjects[0].words[0].legacyKeys=['legacy:tree'];
  const task={subjectId:'vocab',category:'review',action:{kind:'practice',itemKeys:['legacy:tree']}};
  const stages=api.taskWordStages(task,undefined,[],{'word:tree':3,'legacy:tree':3},data);
  assert.equal(stages['word:tree'],0);assert.equal(stages['legacy:tree'],0);
});
test('planning source hashes must match the actual study content before task practice is offered',()=>{
  ready();assert.equal(typeof api.assertPlanningStudySources,'function');
  const data=catalog(),subjects=[{id:'vocab',items:[{abilityId:'word:tree',word:'Tree',contentHash:'b'.repeat(64)}]}];
  assert.throws(()=>api.assertPlanningStudySources(data,subjects),/资料版本/);
  subjects[0].items[0].contentHash='a'.repeat(64);api.assertPlanningStudySources(data,subjects);
});
