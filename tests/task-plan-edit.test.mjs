import assert from 'node:assert/strict';
import test from 'node:test';
import {generateTaskPlan,hashTaskPlan,planningHash} from '../app/task-plan-engine.ts';
import {vocabularyInput,courseSubject} from './fixtures/task-plan-input.mjs';
let api;
try {api=await import('../app/task-plan-edit.ts');}
catch(error) {if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;}
async function setup() {
  const input=vocabularyInput(0),subject=courseSubject(4);subject.goals=[];
  input.catalog.subjects.push(subject);
  return {input,plan:await generateTaskPlan(input),catalog:input.catalog,subject};
}
function linked(subject,index=0) {
  const unit=subject.units[index];
  return {taskId:`manual-${unit.unitId}`,subjectId:subject.subjectId,title:unit.title,category:'subject',origin:'manual',
    required:false,unitIds:[unit.unitId],quantity:1,action:structuredClone(unit.action),completionRule:unit.completionRule,sourceHash:unit.sourceHash};
}
async function edit(...args) {assert.equal(typeof api?.editTaskPlan,'function','Manual task editor must exist');return api.editTaskPlan(...args);}
async function merge(...args) {assert.equal(typeof api?.mergeTaskPlans,'function','Task-plan merger must exist');return api.mergeTaskPlans(...args);}
async function seal(plan) {const body=structuredClone(plan);delete body.planHash;return {...body,planHash:await hashTaskPlan(body)};}
test('source validation can serve a review-only registered result card',async()=>{
  const input=vocabularyInput(0);
  input.catalog.practiceSources=[{itemKey:'practice:result',subjectId:'vocab',title:'Result',sourceHash:'c'.repeat(64),completionRule:'graded-practice'}];
  input.reviews=[{roundId:'result-round',itemKey:'practice:result',subjectId:'vocab',dueAt:'2026-08-31T00:00:00.000Z',completed:false,completionRule:'graded-practice'}];
  const plan=await generateTaskPlan(input);
  assert.equal(await api.taskSourceHash(plan.tasks[0],input.catalog),'c'.repeat(64));
});
test('adding a linked task locks its real unit and leaves the old plan unchanged',async()=>{
  const {plan,catalog,subject}=await setup(),before=structuredClone(plan);
  const updated=await edit(plan,{type:'upsert',task:linked(subject)},catalog);
  assert.equal(updated.tasks.length,1);assert.equal(updated.tasks[0].sourceHash,subject.units[0].sourceHash);
  assert.ok(updated.manual.lockedTaskIds.includes(updated.tasks[0].taskId));
  assert.ok(updated.draftVersion>plan.draftVersion);assert.notEqual(updated.planHash,plan.planHash);
  assert.deepEqual(plan,before);
});
test('deleting an optional task prevents its immediate regeneration',async()=>{
  const {plan,catalog,subject}=await setup(),task=linked(subject);
  const selected=await edit(plan,{type:'upsert',task},catalog);
  const removed=await edit(selected,{type:'remove',taskId:task.taskId},catalog);
  assert.ok(removed.manual.excludedUnitIds.includes('course:u0'));
  const generated=await seal({...plan,tasks:[{...task,origin:'ai',taskId:'ai-unit-zero'}]});
  assert.equal((await merge(removed,generated,[],catalog)).tasks.length,0);
});
test('a mandatory goal cannot be deleted or quietly downgraded',async()=>{
  const input=vocabularyInput(0);input.catalog.subjects.push(courseSubject(2,{targetCount:1}));
  const plan=await generateTaskPlan(input),task=plan.tasks[0];
  await assert.rejects(edit(plan,{type:'remove',taskId:task.taskId},input.catalog),/required-task/);
  await assert.rejects(edit(plan,{type:'upsert',task:{...task,required:false}},input.catalog),/required-task/);
});
test('manual quantity has room without claiming formal source progress',async()=>{
  const {plan,catalog}=await setup();
  const task={taskId:'manual-pages',subjectId:'course',title:'Read pages',category:'subject',origin:'manual',required:false,
    unitIds:[],quantity:3,action:{kind:'manual'},completionRule:'self-report',sourceHash:catalog.sourceHash};
  const selected=await edit(plan,{type:'upsert',task},catalog);
  const changed=await edit(selected,{type:'upsert',task:{...task,quantity:5}},catalog);
  assert.equal((await merge(changed,plan,[],catalog)).tasks[0].quantity,5);
});
test('explicit ordering survives regeneration including a move to the end',async()=>{
  const {plan,catalog,subject}=await setup();let selected=plan;
  for(let i=0;i<3;i++) selected=await edit(selected,{type:'upsert',task:linked(subject,i)},catalog);
  selected=await edit(selected,{type:'move',taskId:linked(subject,0).taskId,beforeTaskId:null},catalog);
  const result=await merge(selected,plan,[],catalog);
  assert.deepEqual(result.tasks.map(t=>t.unitIds[0]),['course:u1','course:u2','course:u0']);
});
test('a manual move remains ordered relative to still automatic tasks',async()=>{
  const {plan,catalog,subject}=await setup();
  const generated=await seal({...plan,tasks:[0,1,2].map(i=>({...linked(subject,i),origin:'ai'}))});
  const moved=await edit(generated,{type:'move',taskId:linked(subject,0).taskId,beforeTaskId:null},catalog);
  const result=await merge(moved,generated,[],catalog);
  assert.deepEqual(result.tasks.map(t=>t.unitIds[0]),['course:u1','course:u2','course:u0']);
});
test('started tasks remain pinned but are not marked completed by starting',async()=>{
  const {plan,catalog,subject}=await setup(),task={...linked(subject),origin:'ai'};
  const candidate=await seal({...plan,tasks:[task]});
  const started=await edit(candidate,{type:'start',taskId:task.taskId},catalog);
  assert.equal((await merge(started,plan,[],catalog)).tasks.length,1);
  assert.equal(started.tasks[0].done,undefined);
});
test('completed tasks survive even without a manual lock',async()=>{
  const {plan,catalog,subject}=await setup(),task={...linked(subject),origin:'ai'};
  const previous=await seal({...plan,tasks:[task]});
  assert.equal((await merge(previous,plan,[task.taskId],catalog)).tasks.length,1);
});

test('source/capture review aliases coalesce while preserving manual title, locks and order',async()=>{
  const input=vocabularyInput(1);
  input.reviews=[{roundId:'capture:old',itemKey:'word:0',subjectId:'vocab',dueAt:'2026-08-31T00:00:00.000Z',completed:false,completionRule:'three-stage'}];
  const original=await generateTaskPlan(input),old=original.tasks.find(task=>task.category==='review');
  const named=await edit(original,{type:'upsert',task:{...old,title:'My retained review',estimatedMinutes:7}},input.catalog);
  const ordered=await edit(named,{type:'move',taskId:old.taskId,beforeTaskId:original.tasks[0].taskId},input.catalog);
  input.reviews=[{...input.reviews[0],roundId:'review:canonical',aliasRoundIds:['capture:old']}];
  const fresh=await generateTaskPlan({...input,previous:ordered});
  const result=await api.mergeTaskPlans(ordered,fresh,[],input.catalog,input.reviews);
  const reviews=result.tasks.filter(task=>task.category==='review');assert.equal(reviews.length,1);
  assert.equal(reviews[0].reviewRoundId,'review:canonical');assert.equal(reviews[0].title,'My retained review');
  assert.equal(reviews[0].estimatedMinutes,7);assert.equal(result.tasks[0].taskId,reviews[0].taskId);
  assert.ok(result.manual.lockedTaskIds.includes(reviews[0].taskId));
});
test('alias coalescing favors an explicitly edited capture over an earlier completed canonical row',async()=>{
  const input=vocabularyInput(1);
  input.reviews=[{roundId:'review:canonical',itemKey:'word:0',subjectId:'vocab',dueAt:'2026-08-31T00:00:00.000Z',completed:false,completionRule:'three-stage'}];
  const original=await generateTaskPlan(input),canonical=original.tasks.find(task=>task.category==='review');
  const appended=await seal({...original,tasks:[...original.tasks,{...canonical,taskId:'capture:new',reviewRoundId:'capture:new'}]});
  const capture=appended.tasks.at(-1),edited=await edit(appended,{type:'upsert',task:{...capture,title:'My explicit title',estimatedMinutes:8}},input.catalog);
  input.reviews[0].aliasRoundIds=['capture:new'];
  const result=await api.mergeTaskPlans(edited,original,[canonical.taskId,capture.taskId],input.catalog,input.reviews);
  const reviews=result.tasks.filter(task=>task.category==='review');assert.equal(reviews.length,1);
  assert.equal(reviews[0].title,'My explicit title');assert.equal(reviews[0].estimatedMinutes,8);
});

test('deleting an optional physical source never excludes the same lexeme still in a required task',async()=>{
  const input=vocabularyInput(30),first=input.catalog.subjects[0].words[0],other={...first,itemKey:'word:second:0',subjectId:'second'};
  input.catalog.subjects.push({...input.catalog.subjects[0],subjectId:'second',priority:1,words:[other]});
  const initial=await generateTaskPlan(input);
  input.previous=await edit(initial,{type:'start',taskId:initial.tasks[0].taskId},input.catalog);
  Object.assign(input.words[0],{status:'learned',firstLearnedItemKey:other.itemKey,firstLearnedAt:'2026-08-31T01:00:00.000Z'});
  const plan=await generateTaskPlan(input),optional=plan.tasks.find(task=>!task.required && task.action.itemKeys.includes(first.itemKey));
  const result=await edit(plan,{type:'remove',taskId:optional.taskId},input.catalog);
  assert.deepEqual(result.vocabulary.assignedLexemeKeys,plan.vocabulary.assignedLexemeKeys);
  assert.ok(!result.vocabulary.excludedLexemeKeys.includes(input.words[0].lexemeKey));
  assert.ok(result.vocabulary.snapshot.some(word=>word.itemKey===other.itemKey));
});

test('deleting a second-library continuation remains deleted after regeneration without removing the first library',async()=>{
  const input=vocabularyInput(30),first=input.catalog.subjects[0].words[0],other={...first,itemKey:'word:second:0',subjectId:'second'};
  input.catalog.subjects.push({...input.catalog.subjects[0],subjectId:'second',priority:1,words:[other]});
  const initial=await generateTaskPlan(input);
  input.previous=await edit(initial,{type:'start',taskId:initial.tasks[0].taskId},input.catalog);
  Object.assign(input.words[0],{status:'initial-in-progress',firstStartedItemKey:other.itemKey,firstStartedAt:'2026-08-31T01:00:00.000Z'});
  const both=await generateTaskPlan(input),extra=both.tasks.find(task=>!task.required && task.action.itemKeys.includes(other.itemKey));
  const removed=await edit(both,{type:'remove',taskId:extra.taskId},input.catalog);
  const again=await generateTaskPlan({...input,previous:removed});
  assert.ok(!again.tasks.some(task=>task.action.itemKeys.includes(other.itemKey)));
  assert.ok(again.tasks.some(task=>task.action.itemKeys.includes(first.itemKey)));
  assert.deepEqual(again.vocabulary.excludedItemKeys,[other.itemKey]);
});

test('pinning an old manual-selection draft migrates all word choices, including other libraries',async()=>{
  const input=vocabularyInput(30),other=vocabularyInput(10).catalog.subjects[0];
  other.subjectId='second';other.words=other.words.map((word,i)=>({...word,itemKey:`word:second:${i}`,subjectId:'second',word:`other${i}`}));
  input.catalog.subjects.push(other);input.words.push(...other.words.map(word=>({lexemeKey:`en:${word.word}`,itemKeys:[word.itemKey],status:'unseen'})));
  const initial=await generateTaskPlan(input);
  const legacy=await seal({...initial,vocabulary:{...initial.vocabulary,manualSelection:true},manual:{...initial.manual,lockedTaskIds:[initial.tasks[0].taskId]}});
  const pinned=await edit(legacy,{type:'start',taskId:initial.tasks[0].taskId},input.catalog);
  const original=initial.tasks.flatMap(task=>task.action.itemKeys);
  assert.deepEqual(new Set(pinned.vocabulary.lockedItemKeys),new Set(original));
  const unselected=input.words.filter(word=>!initial.vocabulary.assignedLexemeKeys.includes(word.lexemeKey)).slice(0,7);
  unselected.forEach(word=>Object.assign(word,{status:'learned',firstLearnedAt:'2026-08-31T01:00:00.000Z'}));
  const regenerated=await generateTaskPlan({...input,previous:pinned});
  assert.ok(original.every(key=>regenerated.tasks.some(task=>task.action.itemKeys.includes(key))));
});
test('a changed source is blocked instead of silently replacing a locked choice',async()=>{
  const {plan,catalog,subject}=await setup(),task=linked(subject);
  const selected=await edit(plan,{type:'upsert',task},catalog);
  const changed=structuredClone(catalog);changed.sourceHash='c'.repeat(64);changed.subjects[1].units[0].sourceHash='d'.repeat(64);
  const generated=await seal({...plan,sourceHash:changed.sourceHash});
  const result=await merge(selected,generated,[],changed);
  assert.equal(result.tasks[0].sourceHash,task.sourceHash);
  assert.ok(result.tasks[0].blockedReason);
});
test('unknown subjects, units and fabricated actions cannot be added',async()=>{
  const {plan,catalog,subject}=await setup(),task=linked(subject);
  await assert.rejects(edit(plan,{type:'upsert',task:{...task,subjectId:'unknown'}},catalog),/subject/);
  await assert.rejects(edit(plan,{type:'upsert',task:{...task,unitIds:['course:missing']}},catalog),/unit/);
  await assert.rejects(edit(plan,{type:'upsert',task:{...task,action:{kind:'open-note',contentRef:'[[outside/private]]'}}},catalog),/action/);
});
test('same source unit is not duplicated by another optional suggestion',async()=>{
  const {plan,catalog,subject}=await setup(),task=linked(subject);
  const selected=await edit(plan,{type:'upsert',task},catalog);
  const suggestion=await seal({...plan,tasks:[{...task,taskId:'ai-duplicate',origin:'ai'}]});
  const result=await merge(selected,suggestion,[],catalog);
  assert.equal(result.tasks.length,1);
  assert.equal(result.tasks[0].taskId,task.taskId);
});
test('yesterday manual exclusions do not silently carry into a new day',async()=>{
  const {plan,catalog,subject}=await setup(),task=linked(subject);
  const yesterday=await seal({...plan,day:'2026-08-30',manual:{lockedTaskIds:[],excludedUnitIds:['course:u0']}});
  const generated=await seal({...plan,tasks:[{...task,origin:'ai'}]});
  const result=await merge(yesterday,generated,[],catalog);
  assert.equal(result.tasks.length,1);assert.deepEqual(result.manual.excludedUnitIds,[]);
});
test('an allocated word snapshot contains identities, not source meanings',async()=>{
  const plan=await generateTaskPlan(vocabularyInput(30));
  assert.equal(plan.vocabulary.snapshot?.length,20);
  assert.equal(plan.vocabulary.snapshot.some(word=>'meaning' in word),false);
});
test('typed replacement changes an unstarted word and retains the manual choice',async()=>{
  const input=vocabularyInput(30),plan=await generateTaskPlan(input),task=plan.tasks[0];
  const selected=await edit(plan,{type:'replace-new-word',taskId:task.taskId,fromItemKey:'word:0',toItemKey:'word:29'},input.catalog,{words:input.words});
  assert.ok(selected.tasks[0].action.itemKeys.includes('word:29'));
  assert.equal(selected.vocabulary.manualSelection,true);
  assert.ok(!selected.vocabulary.assignedLexemeKeys.includes('en:term0'));
  const regenerated=await generateTaskPlan({...input,previous:selected});
  const result=await merge(selected,regenerated,[],input.catalog);
  assert.ok(result.vocabulary.assignedLexemeKeys.includes('en:term29'));
  assert.ok(!result.vocabulary.assignedLexemeKeys.includes('en:term0'));
});
test('word replacement rejects already started words and old-word destinations',async()=>{
  const input=vocabularyInput(30),plan=await generateTaskPlan(input),task=plan.tasks[0];
  input.words[0].status='initial-in-progress';
  await assert.rejects(edit(plan,{type:'replace-new-word',taskId:task.taskId,fromItemKey:'word:0',toItemKey:'word:29'},input.catalog,{words:input.words}),/started-word/);
  input.words[0].status='unseen';input.words[29].status='learned';
  await assert.rejects(edit(plan,{type:'replace-new-word',taskId:task.taskId,fromItemKey:'word:0',toItemKey:'word:29'},input.catalog,{words:input.words}),/not-new-word/);
});
test('generic upsert cannot bypass review or new-word identity constraints',async()=>{
  const input=vocabularyInput(30);input.reviews=[{roundId:'fixed-review',itemKey:'word:0',subjectId:'vocab',dueAt:'2026-08-30T00:00:00.000Z',completed:false,completionRule:'three-stage'}];
  const plan=await generateTaskPlan(input),review=plan.tasks.find(t=>t.category==='review'),words=plan.tasks.find(t=>t.category==='new-word');
  await assert.rejects(edit(plan,{type:'upsert',task:{...review,action:{kind:'practice',itemKeys:['word:1']}}},input.catalog),/required-review/);
  const keys=words.action.itemKeys.map(key=>key==='word:0'?'word:29':key);
  const sourceHash=await planningHash(keys.map(key=>[key,'a'.repeat(64)]));
  await assert.rejects(edit(plan,{type:'upsert',task:{...words,sourceHash,action:{kind:'practice',itemKeys:keys}}},input.catalog),/typed-word/);
});
test('manual word selection stays present as optional continuation when other words fulfill the goal',async()=>{
  const input=vocabularyInput(40),plan=await generateTaskPlan(input),task=plan.tasks[0];
  const selected=await edit(plan,{type:'replace-new-word',taskId:task.taskId,fromItemKey:'word:0',toItemKey:'word:20'},input.catalog,{words:input.words});
  const chosen=[...selected.vocabulary.assignedLexemeKeys];
  input.words.slice(21,28).forEach(word=>Object.assign(word,{status:'learned',firstLearnedAt:'2026-08-31T02:00:00.000Z'}));
  const generated=await generateTaskPlan({...input,previous:selected});
  const result=await merge(selected,generated,[],input.catalog);
  assert.ok(chosen.every(key=>result.vocabulary.assignedLexemeKeys.includes(key)));
  assert.equal(result.tasks.filter(t=>t.category==='new-word' && t.required).reduce((n,t)=>n+t.quantity,0),20);
  assert.equal(result.tasks.filter(t=>t.category==='new-word' && !t.required).reduce((n,t)=>n+t.quantity,0),7);
});
test('a disappeared manually selected word remains a blocked choice rather than being swapped silently',async()=>{
  const input=vocabularyInput(30),plan=await generateTaskPlan(input);
  const selected=await edit(plan,{type:'replace-new-word',taskId:plan.tasks[0].taskId,fromItemKey:'word:0',toItemKey:'word:29'},input.catalog,{words:input.words});
  input.catalog=structuredClone(input.catalog);input.catalog.sourceHash='d'.repeat(64);
  input.catalog.subjects[0].words=input.catalog.subjects[0].words.filter(w=>w.itemKey!=='word:29');
  const generated=await generateTaskPlan({...input,previous:selected});
  const result=await merge(selected,generated,[],input.catalog);
  assert.ok(result.vocabulary.assignedLexemeKeys.includes('en:term29'));
  assert.ok(result.tasks.some(t=>t.blockedReason && t.action.kind==='practice' && t.action.itemKeys.includes('word:29')));
});
test('a hand-picked unit can cover a required metric instead of adding redundant work',async()=>{
  const {input,plan,catalog,subject}=await setup();
  const selected=await edit(plan,{type:'upsert',task:linked(subject,3)},catalog);
  const required=courseSubject(4,{targetCount:1});input.catalog.subjects[1]=required;
  const generated=await generateTaskPlan({...input,previous:selected});
  const result=await merge(selected,generated,[],input.catalog);
  assert.equal(result.tasks.length,1);
  assert.deepEqual(result.tasks[0].unitIds,['course:u3']);
  assert.equal(result.tasks[0].required,true);
});
test('a required metric uses alternatives to manually excluded units and exposes a conflict when none exist',async()=>{
  const input=vocabularyInput(0),subject=courseSubject(3,{targetCount:1});input.catalog.subjects.push(subject);
  const base=await generateTaskPlan(input);
  const previous=await seal({...base,tasks:[],manual:{lockedTaskIds:[],excludedUnitIds:['course:u0']}});
  const generated=await generateTaskPlan({...input,previous});
  assert.deepEqual(generated.tasks[0].unitIds,['course:u1']);
  input.catalog.subjects[1].goals[0].unitIds=['course:u0'];
  const conflict=await generateTaskPlan({...input,previous});
  assert.equal(conflict.tasks[0].required,true);
  assert.ok(conflict.tasks[0].blockedReason);
});
test('removing optional started words keeps them out of same-day regeneration only',async()=>{
  const input=vocabularyInput(30);
  input.words.slice(0,20).forEach(word=>Object.assign(word,{status:'learned',firstLearnedAt:'2026-08-31T02:00:00.000Z'}));
  Object.assign(input.words[20],{status:'initial-in-progress',firstStartedAt:'2026-08-31T03:00:00.000Z'});
  const plan=await generateTaskPlan(input),optional=plan.tasks.find(task=>!task.required);
  const removed=await edit(plan,{type:'remove',taskId:optional.taskId},input.catalog);
  const result=await generateTaskPlan({...input,previous:removed});
  assert.ok(!result.tasks.some(task=>task.action.itemKeys.includes('word:20')));
  const tomorrow=await generateTaskPlan({...input,day:'2026-09-01',previous:removed});
  assert.ok(tomorrow.tasks.some(task=>task.action.itemKeys.includes('word:20')));
});
test('a locked task recovers when the original source is restored',async()=>{
  const {plan,catalog,subject}=await setup(),task=linked(subject);
  const selected=await edit(plan,{type:'upsert',task},catalog);
  const missing=structuredClone(catalog);missing.subjects[1].units=[];
  const blocked=await merge(selected,plan,[],missing);
  const restored=await merge(blocked,plan,[],catalog);
  assert.equal(restored.tasks[0].blockedReason,undefined);
});
test('explicit source adoption updates the selected unit without silently choosing another one',async()=>{
  const {plan,catalog,subject}=await setup(),task=linked(subject);
  const selected=await edit(plan,{type:'upsert',task},catalog);
  const changed=structuredClone(catalog);changed.sourceHash='d'.repeat(64);
  changed.subjects[1].units[0].sourceHash='c'.repeat(64);
  changed.subjects[1].units[0].title='Updated unit';
  const generated=await seal({...plan,sourceHash:changed.sourceHash});
  const blocked=await merge(selected,generated,[],changed);
  const accepted=await edit(blocked,{type:'refresh-source',taskId:task.taskId},changed);
  assert.equal(accepted.tasks[0].sourceHash,'c'.repeat(64));
  assert.equal(accepted.tasks[0].title,'Updated unit');
  assert.equal(accepted.tasks[0].blockedReason,undefined);
});
test('explicit word source adoption preserves the word identity and updates its snapshot',async()=>{
  const input=vocabularyInput(30),plan=await generateTaskPlan(input);
  const selected=await edit(plan,{type:'replace-new-word',taskId:plan.tasks[0].taskId,fromItemKey:'word:0',toItemKey:'word:29'},input.catalog,{words:input.words});
  input.catalog.sourceHash='c'.repeat(64);input.catalog.subjects[0].words[29].sourceHash='d'.repeat(64);
  const generated=await generateTaskPlan({...input,previous:selected});
  const blocked=await merge(selected,generated,[],input.catalog),task=blocked.tasks.find(task=>task.blockedReason);
  const accepted=await edit(blocked,{type:'refresh-source',taskId:task.taskId},input.catalog,{words:input.words});
  assert.equal(accepted.tasks.find(t=>t.taskId===task.taskId).blockedReason,undefined);
  assert.equal(accepted.vocabulary.snapshot.find(w=>w.itemKey==='word:29').sourceHash,'d'.repeat(64));
});
test('a started word group keeps its blocked source through repeated regeneration',async()=>{
  const input=vocabularyInput(30),plan=await generateTaskPlan(input);
  const started=await edit(plan,{type:'start',taskId:plan.tasks[0].taskId},input.catalog);
  input.catalog.sourceHash='c'.repeat(64);input.catalog.subjects[0].words[0].sourceHash='d'.repeat(64);
  const first=await merge(started,await generateTaskPlan({...input,previous:started}),[],input.catalog);
  const second=await merge(first,await generateTaskPlan({...input,previous:first}),[],input.catalog);
  assert.ok(second.tasks.find(task=>task.action.itemKeys.includes('word:0')).blockedReason);
  assert.equal(second.vocabulary.snapshot.find(word=>word.itemKey==='word:0').sourceHash,'a'.repeat(64));
});
test('starting a group preserves all its selected words when outside learning shrinks the quota',async()=>{
  const input=vocabularyInput(40),plan=await generateTaskPlan(input);
  const started=await edit(plan,{type:'start',taskId:plan.tasks[0].taskId},input.catalog);
  input.words.slice(20,27).forEach(word=>Object.assign(word,{status:'learned',firstLearnedAt:'2026-08-31T02:00:00.000Z'}));
  const regenerated=await generateTaskPlan({...input,previous:started});
  const result=await merge(started,regenerated,[],input.catalog);
  assert.ok(started.vocabulary.assignedLexemeKeys.every(key=>result.vocabulary.assignedLexemeKeys.includes(key)));
  assert.equal(result.tasks.filter(task=>!task.required).reduce((n,t)=>n+t.quantity,0),7);
});
test('adopting word sources cannot clear unknown first-learning evidence',async()=>{
  const input=vocabularyInput(30),plan=await generateTaskPlan(input);
  const selected=await edit(plan,{type:'replace-new-word',taskId:plan.tasks[0].taskId,fromItemKey:'word:0',toItemKey:'word:29'},input.catalog,{words:input.words});
  input.words[29].status='history-unknown';
  const generated=await generateTaskPlan({...input,previous:selected});
  const blocked=await merge(selected,generated,[],input.catalog),task=blocked.tasks.find(task=>task.blockedReason);
  await assert.rejects(edit(blocked,{type:'refresh-source',taskId:task.taskId},input.catalog),/word-history-required/);
  await assert.rejects(edit(blocked,{type:'refresh-source',taskId:task.taskId},input.catalog,{words:input.words}),/not-new-word/);
});
test('raw subject practice actions cannot bypass independent linked units',async()=>{
  const {plan,catalog,subject}=await setup();
  subject.units.slice(0,2).forEach((unit,i)=>Object.assign(unit,{action:{kind:'practice',itemKeys:['practice:'+i]},completionRule:'graded-practice'}));
  const task={...linked(subject),unitIds:[],quantity:2,action:{kind:'practice',itemKeys:['practice:0','practice:1']},sourceHash:await planningHash([['practice:0','b'.repeat(64)],['practice:1','b'.repeat(64)]])};
  await assert.rejects(edit(plan,{type:'upsert',task},catalog),/task-unit-reference-required/);
});
test('review title edits and source adoption cannot clear unresolved evidence',async()=>{
  const input=vocabularyInput(1);input.reviews=[{roundId:'review-r',itemKey:'word:0',subjectId:'vocab',dueAt:'2026-08-30T00:00:00.000Z',completed:false,completionRule:'three-stage',blockedReason:'历史尚未完成对账'}];
  const plan=await generateTaskPlan(input),task=plan.tasks.find(task=>task.category==='review');
  const edited=await edit(plan,{type:'upsert',task:{...task,title:'My review'}},input.catalog);
  assert.equal(edited.tasks.find(t=>t.taskId===task.taskId).blockedReason,task.blockedReason);
  await assert.rejects(edit(plan,{type:'refresh-source',taskId:task.taskId},input.catalog),/review-history-required/);
  const adopted=await edit(plan,{type:'refresh-source',taskId:task.taskId},input.catalog,{words:input.words,reviews:input.reviews});
  assert.equal(adopted.tasks.find(t=>t.taskId===task.taskId).blockedReason,task.blockedReason);
});
test('current review projection clears obsolete evidence blocking but not a source conflict',async()=>{
  const input=vocabularyInput(1);input.reviews=[{roundId:'review-r',itemKey:'word:0',subjectId:'vocab',dueAt:'2026-08-30T00:00:00.000Z',completed:false,completionRule:'three-stage',blockedReason:'历史尚未完成对账'}];
  const plan=await generateTaskPlan(input),task=plan.tasks.find(task=>task.category==='review');
  const locked=await edit(plan,{type:'move',taskId:task.taskId,beforeTaskId:null},input.catalog);
  delete input.reviews[0].blockedReason;
  const generated=await generateTaskPlan({...input,previous:locked});
  const restored=await merge(locked,generated,[],input.catalog);
  assert.equal(restored.tasks.find(t=>t.taskId===task.taskId).blockedReason,undefined);
  input.catalog.subjects[0].words[0].sourceHash='c'.repeat(64);
  const changed=await merge(locked,await generateTaskPlan({...input,previous:locked}),[],input.catalog);
  assert.ok(changed.tasks.find(t=>t.taskId===task.taskId).blockedReason);
});
test('a manually replaced optional unit cannot collide with its old deterministic task id',async()=>{
  const input=vocabularyInput(0),subject=courseSubject(2,{targetCount:1,required:false});input.catalog.subjects.push(subject);
  const plan=await generateTaskPlan(input),task=plan.tasks[0];
  const selected=await edit(plan,{type:'upsert',task:{...task,...linked(subject,1),taskId:task.taskId}},input.catalog);
  Object.assign(subject.goals[0],{required:true,targetCount:2});
  const generated=await generateTaskPlan({...input,previous:selected});
  const result=await merge(selected,generated,[],input.catalog);
  assert.equal(result.tasks.length,2);assert.equal(new Set(result.tasks.map(t=>t.taskId)).size,2);
  assert.ok(result.tasks.every(t=>t.required));
});
test('word splitting carries a moved group position and locks to every successor',async()=>{
  const input=vocabularyInput(30);input.catalog.subjects.push(courseSubject(1,{targetCount:1}));
  const plan=await generateTaskPlan(input),wordTask=plan.tasks.find(t=>t.category==='new-word');
  const moved=await edit(plan,{type:'move',taskId:wordTask.taskId,beforeTaskId:null},input.catalog);
  input.catalog.subjects[0].words[0].sourceHash='c'.repeat(64);
  const generated=await generateTaskPlan({...input,previous:moved});
  const result=await merge(moved,generated,[],input.catalog);
  assert.equal(result.tasks[0].category,'subject');
  assert.ok(result.tasks.filter(t=>t.category==='new-word').every(t=>result.manual.lockedTaskIds.includes(t.taskId)));
});
test('adopting another word group writes its lock even when word-level locks already exist',async()=>{
  const input=vocabularyInput(40),subject=input.catalog.subjects[0];
  input.catalog.subjects.push({...subject,subjectId:'second',words:subject.words.splice(20).map(word=>({...word,subjectId:'second'}))});
  const plan=await generateTaskPlan(input),[first,second]=plan.tasks;
  const started=await edit(plan,{type:'start',taskId:first.taskId},input.catalog);
  const adopted=await edit(started,{type:'refresh-source',taskId:second.taskId},input.catalog,{words:input.words});
  const changed=second.action.itemKeys[0];
  input.catalog.subjects.flatMap(subject=>subject.words).find(word=>word.itemKey===changed).sourceHash='d'.repeat(64);
  const regenerated=await generateTaskPlan({...input,previous:adopted});
  const result=await merge(adopted,regenerated,[],input.catalog);
  assert.ok(result.tasks.find(task=>task.action.itemKeys.includes(changed)).blockedReason);
});
