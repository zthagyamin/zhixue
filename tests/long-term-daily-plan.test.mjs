import assert from 'node:assert/strict';
import test from 'node:test';
import {generateTaskPlan} from '../app/task-plan-engine.ts';
import {vocabularyInput,courseSubject} from './fixtures/task-plan-input.mjs';
const allocation=(input,n=5)=>({schemaVersion:1,planId:'p',day:input.day,vocabularyTarget:n,items:input.catalog.subjects[0].words.slice(0,n).map(w=>({itemId:w.itemKey,subjectId:w.subjectId,kind:'vocabulary',itemKeys:[w.itemKey],unitIds:[],sourceHash:w.sourceHash,lexemeKey:`en:${w.word}`}))});
test('explicit five physical words replace legacy twenty and subtract first completions',async()=>{
 const input=vocabularyInput();input.longTermAllocation=allocation(input);input.catalog.subjects.push(courseSubject());
 let plan=await generateTaskPlan(input);assert.equal(plan.vocabulary.target,5);assert.equal(plan.vocabulary.snapshot.length,5);assert.equal(plan.tasks.filter(t=>t.category==='subject').length,0);
 input.previous=plan;input.words.slice(0,3).forEach(w=>{w.status='learned';w.firstLearnedAt='2026-08-31T01:00:00Z';w.firstLearnedItemKey=w.itemKeys[0];});
 plan=await generateTaskPlan(input);assert.equal(plan.vocabulary.snapshot.length,5);assert.equal(plan.vocabulary.snapshot.filter(w=>!input.words.slice(0,3).some(s=>s.itemKeys.includes(w.itemKey))).length,2);
});
test('zero quota retains completed snapshot and actual review, invalid source fails explicitly',async()=>{
 const input=vocabularyInput();input.longTermAllocation=allocation(input,0);input.words[0]={...input.words[0],status:'learned',firstLearnedAt:'2026-08-31T01:00:00Z'};
 input.reviews=[{roundId:'due',itemKey:'word:9',subjectId:'vocab',dueAt:'2026-08-31T00:00:00Z',completed:false,completionRule:'three-stage'}];
 const plan=await generateTaskPlan(input);assert.equal(plan.vocabulary.target,0);assert.equal(plan.vocabulary.snapshot.length,1);assert.ok(plan.tasks.some(t=>t.taskId==='due'));
 input.longTermAllocation=allocation(input);input.longTermAllocation.items[0].sourceHash='b'.repeat(64);await assert.rejects(generateTaskPlan(input),/long-term.*source/);
});
import {taskSourceHash,editTaskPlan,mergeTaskPlans} from '../app/task-plan-edit.ts';
import {completedPlanTaskIds,projectUnitCompletions} from '../app/task-planning-input.ts';
import {attempt} from './fixtures/task-event-fixtures.mjs';
test('physical practice completes only after real round, preserves prerequisites and survives start/merge',async()=>{
 const input=vocabularyInput();const subject=courseSubject();input.catalog.subjects.push(subject);
 const source={itemKey:'p1',subjectId:'course',title:'Physical one',sourceHash:'b'.repeat(64),completionRule:'graded-practice'};input.catalog.practiceSources=[source];
 subject.units[1].action={kind:'practice',itemKeys:['p1','p2']};subject.units[1].completionRule='graded-practice';subject.units[1].prerequisites=['course:u0'];
 input.longTermAllocation=allocation(input,0);input.longTermAllocation.items.push({itemId:'p1',kind:'practice',subjectId:'course',sourceHash:source.sourceHash,itemKeys:['p1'],unitIds:['course:u1']});
 let plan=await generateTaskPlan(input);assert.equal(plan.tasks.length,1);assert.ok(plan.tasks[0].blockedReason);assert.deepEqual(plan.tasks[0].unitIds,[]);
 input.completions=[{taskId:'read',unitId:'course:u0',occurredAt:'2026-08-31T01:00:00Z',basis:'self-report'}];plan=await generateTaskPlan(input);assert.equal(plan.tasks[0].blockedReason,undefined);
 const facts={catalog:input.catalog,events:[],completions:input.completions,reviews:[],identities:[],taskEvents:[]};assert.deepEqual(completedPlanTaskIds(plan,facts),[]);
 facts.events=[await attempt('p-complete','2026-08-31T02:00:00Z',2,3,true,{item:{kind:'quiz',key:'p1'}})];assert.deepEqual(completedPlanTaskIds(plan,facts),[plan.tasks[0].taskId]);assert.ok(!projectUnitCompletions(input.catalog,facts.events,[],[]).some(c=>c.unitId==='course:u1'));
 assert.equal(await taskSourceHash(plan.tasks[0],input.catalog),source.sourceHash);
 const started=await editTaskPlan(plan,{type:'start',taskId:plan.tasks[0].taskId},input.catalog);
 input.previous=started;input.longTermAllocation=allocation(input,0);const next=await generateTaskPlan(input);const merged=await mergeTaskPlans(started,next,[],input.catalog);assert.equal(merged.tasks.length,1);assert.equal(merged.tasks[0].blockedReason,undefined);
});
import {buildLongTermPlanningInput} from '../app/long-term-planning-input.ts';
import {generateLongTermSchedule} from '../app/long-term-pacing.ts';
import {applyLongTermPlan} from '../app/long-term-daily-plan.ts';
import {deriveLongTermDailyAllocation,parseLongTermDailyAllocation} from '../app/long-term-daily-allocation.ts';
import {parseTaskPlan} from '../app/task-plan-types.ts';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const snapshotFor=input=>{const source=buildLongTermPlanningInput(input);return generateLongTermSchedule(source.inventory,{planId:'long-plan',startDate:input.day,targetDeadline:input.day,dailyMinutesBudget:{workdayMin:0,workdayMax:15,weekendMax:15,minReviewRatio:0},subjectsConfig:input.catalog.subjects.map(s=>({subjectId:s.subjectId,priority:3,completionCriteria:'fixed-rounds'})),bufferRatio:0},{},{asOfDate:input.day,generatedAt:`${input.day}T00:00:00Z`});};
test('wrapper derives actual physical selection, frozen provenance and stable content across future refresh',async()=>{
 const input=vocabularyInput(),snapshot=snapshotFor(input);const applied=applyLongTermPlan(input,snapshot);assert.equal(applied.longTermAllocation.vocabularyTarget,5);
 const plan=await generateTaskPlan(applied);assert.deepEqual(plan.vocabulary.snapshot.map(w=>w.itemKey).sort(),snapshot.schedule[0].newItemIds.sort());
 const later=structuredClone(snapshot);later.lastRebalancedAt='2026-09-01T00:00:00Z';later.inventory[0].sourceHash='b'.repeat(64);
 assert.deepEqual(applyLongTermPlan(input,later).longTermAllocation,applied.longTermAllocation);
 assert.equal(deriveLongTermDailyAllocation(snapshot,[], '2026-09-01'),null);assert.throws(()=>deriveLongTermDailyAllocation(snapshot,[],input.day),/missing-long-term-identity/);
 assert.deepEqual(applyLongTermPlan(applied,null),input);
});
test('scheduled material only and invalid physical identity cannot bypass real prerequisites',async()=>{
 const input=vocabularyInput();input.catalog.subjects.push(courseSubject());const unit=input.catalog.subjects[1].units[4];input.longTermAllocation=allocation(input,0);
 input.longTermAllocation.items=[{itemId:unit.unitId,kind:'material',subjectId:unit.subjectId,itemKeys:[],unitIds:[unit.unitId],sourceHash:unit.sourceHash}];
 const plan=await generateTaskPlan(input);assert.deepEqual(plan.tasks.map(t=>t.unitIds),[[unit.unitId]]);
 input.longTermAllocation.items[0].subjectId='vocab';await assert.rejects(generateTaskPlan(input),/long-term/);
});
test('locked and started physical words remain visible beyond lower quota, completed count never reopens quota',async()=>{
 const input=vocabularyInput();const original=await generateTaskPlan(input);input.previous=await editTaskPlan(original,{type:'start',taskId:original.tasks[0].taskId},input.catalog);
 input.longTermAllocation=allocation(input,0);let plan=await generateTaskPlan(input);assert.equal(plan.vocabulary.snapshot.length,20);assert.equal(plan.vocabulary.target,0);
 input.previous=null;input.words[9]={...input.words[9],status:'initial-in-progress',firstStartedItemKey:'word:9',firstStartedAt:'2026-08-31T00:00:00Z'};
 plan=await generateTaskPlan(input);assert.deepEqual(plan.vocabulary.snapshot.map(w=>w.itemKey),['word:9']);
 input.longTermAllocation=allocation(input,5);input.words.slice(6,11).forEach(w=>{w.status='learned';w.firstLearnedAt='2026-08-31T01:00:00Z';});
 plan=await generateTaskPlan(input);assert.equal(plan.vocabulary.snapshot.length,5);assert.ok(plan.vocabulary.snapshot.every(w=>Number(w.itemKey.split(':')[1])>=6));
});
test('shared strict signed allocation fixture matches TS and Python hashes and rejects malformed metadata',()=>{
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/task-plan-v2-long-term.json',import.meta.url),'utf8'));
 assert.deepEqual(parseTaskPlan(fixture),fixture);const cases=[fixture];
 for(const change of [p=>{p.vocabulary.target=20;},p=>{p.longTermAllocation.day='2026-09-01';},p=>{p.longTermAllocation.items[0].sourceHash='bad';},p=>{p.longTermAllocation.items.push(p.longTermAllocation.items[0]);},p=>{p.longTermAllocation.items[0].extra=1;},p=>{p.longTermAllocation.items[0].itemKeys=['foreign'];},p=>{p.longTermAllocation.vocabularyTarget=1.5;},p=>{delete p.longTermAllocation;}]){const bad=structuredClone(fixture);change(bad);assert.throws(()=>parseTaskPlan(bad));cases.push(bad);}
 const script=`import json,sys\nsys.path.insert(0,'companion')\nfrom task_plan_schema import validate_task_plan,validate_task_plan_integrity\nvalues=json.load(sys.stdin)\nvalidate_task_plan_integrity(values[0])\nout=[]\nfor value in values:\n try: validate_task_plan(value);out.append(True)\n except (ValueError,TypeError):out.append(False)\nprint(json.dumps(out))`;
 const result=spawnSync(process.env.PYTHON??'C:/Users/30972/Documents/ChatGPT/项目/.codex-staging/zhixue-review-python/Scripts/python.exe',['-c',script],{input:JSON.stringify(cases),encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'}});
 assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),[true,...cases.slice(1).map(()=>false)]);
 assert.throws(()=>parseLongTermDailyAllocation({...fixture.longTermAllocation,items:[{...fixture.longTermAllocation.items[0],lexemeKey:'constructor'}]}));
});
test('manual title/source edits cannot clear allocated prerequisite blocking or replace required physical identity',async()=>{
 const input=vocabularyInput();const subject=courseSubject();input.catalog.subjects.push(subject);const u=subject.units[1];u.prerequisites=[subject.units[0].unitId];
 input.longTermAllocation=allocation(input,0);input.longTermAllocation.items=[{itemId:u.unitId,subjectId:u.subjectId,kind:'material',itemKeys:[],unitIds:[u.unitId],sourceHash:u.sourceHash}];
 const plan=await generateTaskPlan(input),task=plan.tasks[0];assert.ok(task.blockedReason);
 const renamed=await editTaskPlan(plan,{type:'upsert',task:{...task,title:'Personal title'}},input.catalog);assert.equal(renamed.tasks[0].blockedReason,task.blockedReason);
 const refreshed=await editTaskPlan(plan,{type:'refresh-source',taskId:task.taskId},input.catalog);assert.equal(refreshed.tasks[0].blockedReason,task.blockedReason);
 input.previous=renamed;input.completions=[{taskId:'real-read',unitId:subject.units[0].unitId,occurredAt:'2026-08-31T01:00:00Z',basis:'self-report'}];
 const unblocked=await mergeTaskPlans(renamed,await generateTaskPlan(input),[],input.catalog);assert.equal(unblocked.tasks[0].blockedReason,undefined);assert.equal(unblocked.tasks[0].title,'Personal title');
});

test('projected predecessor acquisition cannot unlock allocated vocabulary before canonical completion',async()=>{
 const input=vocabularyInput(1),subject=input.catalog.subjects[0];
 subject.units=[{unitId:'pre',subjectId:'vocab',title:'Prerequisite',order:0,sourceHash:'b'.repeat(64),prerequisites:[],action:{kind:'open-note',contentRef:'[[pre]]'},completionRule:'formal-mastered',formalComplete:false,estimatedMinutes:1},
 {unitId:'word-unit',subjectId:'vocab',title:'Word practice',order:1,sourceHash:'c'.repeat(64),prerequisites:['pre'],action:{kind:'practice',itemKeys:['word:0']},completionRule:'three-stage',formalComplete:false}];
 const source=buildLongTermPlanningInput(input);assert.deepEqual(source.inventory.find(i=>i.itemId==='word:0').prerequisiteItemIds,['pre']);
 const snapshot=snapshotFor(input);assert.deepEqual(snapshot.schedule[0].newItemIds,['pre','word:0']);
 let plan=await generateTaskPlan(applyLongTermPlan(input,snapshot));let wordTask=plan.tasks.find(t=>t.category==='new-word');assert.ok(wordTask.blockedReason);assert.deepEqual(wordTask.unitIds,[]);
 const refreshed=await editTaskPlan(plan,{type:'refresh-source',taskId:wordTask.taskId},input.catalog,{words:input.words,reviews:[]});assert.equal(refreshed.tasks.find(t=>t.taskId===wordTask.taskId).blockedReason,wordTask.blockedReason);
 subject.units[0].formalComplete=true;plan=await generateTaskPlan(applyLongTermPlan(input,snapshot));wordTask=plan.tasks.find(t=>t.category==='new-word');assert.equal(wordTask.blockedReason,undefined);
});

test('frozen material in invalid mapping remains blocked while unaffected review is generated',async()=>{
 const input=vocabularyInput(1),subject=courseSubject(1);input.catalog.subjects.push(subject);input.longTermAllocation=allocation(input,0);
 const unit=subject.units[0];input.longTermAllocation.items=[{itemId:unit.unitId,subjectId:unit.subjectId,kind:'material',itemKeys:[],unitIds:[unit.unitId],sourceHash:unit.sourceHash}];subject.planningStatus='invalid';
 input.reviews=[{roundId:'unaffected-review',itemKey:'word:0',subjectId:'vocab',dueAt:'2026-08-31T00:00:00Z',completed:false,completionRule:'three-stage'}];
 const plan=await generateTaskPlan(input),task=plan.tasks.find(t=>t.category==='subject');assert.ok(task.blockedReason);assert.equal(task.title,unit.title);assert.deepEqual(task.action,unit.action);assert.ok(plan.tasks.some(t=>t.taskId==='unaffected-review'&&!t.blockedReason));
});

test('protected legacy practices cover allocated physical items once and keep grouped extras and completion rules',async()=>{
 for(const keys of [['p1'],['p1','p2']])for(const protection of ['started','completed']){
  const input=vocabularyInput(0),subject=courseSubject(1,{completionBasis:'practice-round',targetCount:1});input.catalog.subjects.push(subject);
  const unit=subject.units[0];unit.action={kind:'practice',itemKeys:keys};unit.completionRule='graded-practice';
  input.catalog.practiceSources=keys.map(itemKey=>({itemKey,subjectId:'course',title:itemKey,sourceHash:'c'.repeat(64),completionRule:'graded-practice'}));
  const legacy=await generateTaskPlan(input),old=legacy.tasks[0];const protectedPlan=protection==='started'?await editTaskPlan(legacy,{type:'start',taskId:old.taskId},input.catalog):legacy;
  input.previous=protectedPlan;input.longTermAllocation=allocation(input,0);input.longTermAllocation.items=[{itemId:'p1',subjectId:'course',kind:'practice',itemKeys:['p1'],unitIds:[unit.unitId],sourceHash:'c'.repeat(64)}];
  const generated=await generateTaskPlan(input);if(protection==='started')assert.equal(generated.tasks.filter(t=>t.category==='subject').length,1);
  const plan=await mergeTaskPlans(protectedPlan,generated,protection==='completed'?[old.taskId]:[],input.catalog),rows=plan.tasks.filter(t=>t.category==='subject');
  assert.equal(rows.length,1,`${protection} ${keys}`);assert.equal(rows[0].taskId,old.taskId);assert.deepEqual(rows[0].action.itemKeys,keys);assert.deepEqual(rows[0].unitIds,old.unitIds);assert.equal(rows[0].completionRule,old.completionRule);assert.equal(rows[0].required,true);
 }
});
