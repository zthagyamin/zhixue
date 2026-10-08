import test from 'node:test';
import assert from 'node:assert/strict';
import {vocabularyInput} from './fixtures/task-plan-input.mjs';
import {generateTaskPlan} from '../app/task-plan-engine.ts';
import {withMinimumWordTargets} from '../src/domain/planning/minimum-quota-settings.ts';
import * as api from '../src/domain/planning/index.ts';
import {editTaskPlan} from '../app/task-plan-edit.ts';

function fixture(){
 const input=vocabularyInput();
 const plan={spec:{planId:'p',startDate:input.day,targetDeadline:'2026-12-01',timeBudgetMode:'advisory',subjectsConfig:[{subjectId:'vocab',dailyMinimumTarget:20}]}};
 input.longTermAllocation={schemaVersion:1,planId:'p',day:input.day,vocabularyTarget:2,items:input.catalog.subjects[0].words.slice(0,2).map(w=>({itemId:w.itemKey,subjectId:w.subjectId,kind:'vocabulary',itemKeys:[w.itemKey],unitIds:[],sourceHash:w.sourceHash,lexemeKey:`en:${w.word}`}))};
 return {input,plan};
}
test('explicit minimum conversion is immutable and retains legacy caps until selected',()=>{
 const old={timeBudgetMode:'limit',subjectsConfig:[{subjectId:'a',dailyQuotaTarget:20},{subjectId:'b',dailyQuotaTarget:1}]};
 const next=withMinimumWordTargets(old,['a']);assert.equal(next.subjectsConfig[0].dailyMinimumTarget,20);
 assert.equal(old.subjectsConfig[0].dailyMinimumTarget,undefined);assert.equal(next.subjectsConfig[1].dailyMinimumTarget,undefined);
});
test('top up two-word allocation to twenty without changing original input',async()=>{
 const {input,plan}=fixture(),before=JSON.stringify(input);
 assert.equal(typeof api.reconcileDailyMinimums,'function');
 const next=api.reconcileDailyMinimums(input,plan),generated=await generateTaskPlan(next);
 assert.equal(generated.vocabulary.snapshot.length,20);assert.equal(JSON.stringify(input),before);
});
test('eighteen learned today require only two pending words, including learning outside old allocation',async()=>{
 const {input,plan}=fixture();
 input.words.slice(2,20).forEach(w=>{w.status='learned';w.firstLearnedAt=`${input.day}T01:00:00Z`;w.firstLearnedItemKey=w.itemKeys[0];});
 const next=api.reconcileDailyMinimums(input,plan),generated=await generateTaskPlan(next);
 assert.equal(generated.vocabulary.target,20);assert.equal(generated.vocabulary.snapshot.length,20);
 const learned=new Set(input.words.filter(w=>w.status==='learned').flatMap(w=>w.itemKeys));
 assert.equal(generated.vocabulary.snapshot.filter(w=>!learned.has(w.itemKey)).length,2);
});
test('unknown history and excluded words do not count as available supply',()=>{
 const {input,plan}=fixture();input.words.slice(3).forEach(w=>w.status='history-unknown');
 const next=api.reconcileDailyMinimums(input,plan);assert.equal(next.longTermAllocation.vocabularyTarget,3);
});
test('time-limited or inactive-date goals cannot be silently reinterpreted',()=>{
 const {input,plan}=fixture();plan.spec.timeBudgetMode='limit';assert.throws(()=>api.reconcileDailyMinimums(input,plan),/词量优先/);
 plan.spec.timeBudgetMode='advisory';plan.spec.startDate='2026-12-01';assert.throws(()=>api.reconcileDailyMinimums(input,plan),/尚未生效/);
});
test('daily display preserves the requested twenty and exposes a seventeen-word supply gap',async()=>{
 const {input,plan}=fixture();input.words.slice(3).forEach(w=>w.status='history-unknown');
 const next=api.reconcileDailyMinimums(input,plan),generated=await generateTaskPlan(next);
 assert.equal(typeof api.dailyMinimumProgress,'function');
 assert.deepEqual(api.dailyMinimumProgress(plan.spec,generated,input.day),[{subjectId:'vocab',minimum:20,assigned:3,blocked:0,missing:17}]);
});

test('locked duplicate word keeps its original physical source and counts once',async()=>{
 const {input,plan}=fixture();input.catalog.subjects[0].words=input.catalog.subjects[0].words.slice(0,1);input.words=input.words.slice(0,1);
 const copy={...input.catalog.subjects[0].words[0],itemKey:'other:0',subjectId:'other'};
 input.catalog.subjects.push({...input.catalog.subjects[0],subjectId:'other',name:'Other',priority:1,words:[copy]});
 input.longTermAllocation={...input.longTermAllocation,vocabularyTarget:1,items:[{itemId:copy.itemKey,subjectId:'other',kind:'vocabulary',itemKeys:[copy.itemKey],unitIds:[],sourceHash:copy.sourceHash,lexemeKey:'en:term0'}]};
 const old=await generateTaskPlan(input);input.previous=await editTaskPlan(old,{type:'start',taskId:old.tasks[0].taskId},input.catalog);
 for(const configureOther of [false,true]){
   plan.spec.subjectsConfig=[{subjectId:'vocab',dailyMinimumTarget:1},...(configureOther?[{subjectId:'other',dailyMinimumTarget:1}]:[])];
   const next=api.reconcileDailyMinimums(input,plan),fresh=await generateTaskPlan(next);
   assert.equal(next.longTermAllocation.vocabularyTarget,1);assert.deepEqual(fresh.vocabulary.snapshot.map(w=>w.itemKey),['other:0']);
 }
});
test('minimum supply excludes words whose actual prerequisite remains unfinished',()=>{
 const {input,plan}=fixture();plan.spec.subjectsConfig[0].dailyMinimumTarget=2;
 const s=input.catalog.subjects[0];s.units=[{unitId:'prep',subjectId:'vocab',title:'Prep',order:0,sourceHash:'b'.repeat(64),prerequisites:[],action:{kind:'open-note',contentRef:'prep'},completionRule:'self-report',formalComplete:false},
 {unitId:'lesson',subjectId:'vocab',title:'Words',order:1,sourceHash:'b'.repeat(64),prerequisites:['prep'],action:{kind:'practice',itemKeys:['word:0','word:1']},completionRule:'three-stage',formalComplete:false}];
 const next=api.reconcileDailyMinimums(input,plan);
 assert.equal(next.longTermAllocation.items.filter(i=>i.kind==='vocabulary').length,2);
 assert.ok(next.longTermAllocation.items.every(i=>!['word:0','word:1'].includes(i.itemId)));
});
test('real started source wins over an unstarted duplicate retained outside minimum goals',async()=>{
 const {input,plan}=fixture();input.catalog.subjects[0].words=input.catalog.subjects[0].words.slice(0,1);input.words=input.words.slice(0,1);
 const copy={...input.catalog.subjects[0].words[0],itemKey:'other:0',subjectId:'other'};
 input.catalog.subjects.push({...input.catalog.subjects[0],subjectId:'other',priority:1,words:[copy]});
 input.longTermAllocation={...input.longTermAllocation,vocabularyTarget:1,items:[{itemId:copy.itemKey,subjectId:'other',kind:'vocabulary',itemKeys:[copy.itemKey],unitIds:[],sourceHash:copy.sourceHash,lexemeKey:'en:term0'}]};
 input.previous=await generateTaskPlan(input);
 input.words[0]={...input.words[0],status:'initial-in-progress',firstStartedItemKey:'word:0',firstStartedAt:`${input.day}T01:00:00Z`};
 plan.spec.subjectsConfig[0].dailyMinimumTarget=1;
 const next=api.reconcileDailyMinimums(input,plan),fresh=await generateTaskPlan(next);
 assert.deepEqual(fresh.vocabulary.snapshot.map(w=>w.itemKey),['word:0']);assert.equal(next.longTermAllocation.vocabularyTarget,1);
});
