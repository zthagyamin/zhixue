import assert from 'node:assert/strict';
import test from 'node:test';
import {generateLongTermSchedule} from '../app/long-term-pacing.ts';
let api;
try{api=await import('../app/long-term-editor-model.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const subjects=[{subjectId:'words',name:'Vocabulary',priority:3}];
const inventory=Array.from({length:10},(_,index)=>({itemId:`word:${index}`,subjectId:'words',sourceHash:'a'.repeat(64),estimatedMinutes:10}));
const source=()=>({subjects:structuredClone(subjects),inventory:structuredClone(inventory),bindings:[],fsrsMap:{},assumptions:[],diagnostics:[],history:[]});
function initial(){assert.equal(typeof api?.defaultLongTermSpec,'function','Long-term editor model must exist');return api.defaultLongTermSpec('2026-09-07',subjects,'goal');}
function preview(spec,previous=null,actualSource=source()){assert.equal(typeof api?.previewLongTermPlan,'function');return api.previewLongTermPlan({spec,previous,source:actualSource,today:'2026-09-07',generatedAt:'2026-09-07T12:00:00.000Z'});}

test('automatic refresh can update an untouched new day but freezes a locked or unknown day',()=>{
 const spec={...initial(),startDate:'2026-09-06',targetDeadline:'2026-09-10',bufferRatio:0,dailyMinutesBudget:{workdayMin:0,workdayMax:20,weekendMax:20,minReviewRatio:0}};
 const old=generateLongTermSchedule(inventory,spec,{}, {asOfDate:'2026-09-06',generatedAt:'2026-09-06T00:00:00.000Z'});
 const changed={...spec,dailyMinutesBudget:{...spec.dailyMinutesBudget,workdayMax:40,weekendMax:40}};
 for(const locked of [true,undefined,false]){
   const next=api.previewLongTermPlan({spec:changed,previous:old,source:{...source(),todayLocked:locked},today:'2026-09-07',generatedAt:'2026-09-07T12:00:00.000Z',preserveToday:false});
   assert.deepEqual(next.schedule[0],old.schedule[0]);
   if(locked===false){assert.equal(next.schedule[1].budgetMinutes,40);assert.equal(next.asOfDate,'2026-09-07');}
   else assert.deepEqual(next.schedule[1],old.schedule[1]);
 }
});
test('new long-term goals visibly start tomorrow and cover sixty inclusive days',()=>{
  const spec=initial();assert.equal(spec.startDate,'2026-09-08');assert.equal(spec.targetDeadline,'2026-11-06');
  assert.equal(spec.subjectsConfig[0].subjectId,'words');
});
test('a new goal cannot replace the current day allocation midway through learning',()=>{
  const spec=initial();spec.startDate='2026-09-07';assert.throws(()=>preview(spec),/long-term-start-tomorrow/);
});
test('editing future capacity preserves today and all earlier slots exactly',()=>{
  const spec={...initial(),startDate:'2026-09-06',targetDeadline:'2026-09-10',bufferRatio:0,dailyMinutesBudget:{workdayMin:0,workdayMax:20,weekendMax:20,minReviewRatio:0}};
  const old=generateLongTermSchedule(inventory,spec,{}, {asOfDate:'2026-09-06',generatedAt:'2026-09-06T00:00:00.000Z',maxProposalExtensionDays:0,maxProposalExtraMinutes:0});
  const before=structuredClone(old),next=preview({...spec,dailyMinutesBudget:{...spec.dailyMinutesBudget,workdayMax:40,weekendMax:40}},old);
  assert.deepEqual(next.schedule.slice(0,2),old.schedule.slice(0,2));assert.deepEqual(old,before);
  assert.equal(next.asOfDate,'2026-09-08');assert.equal(next.schedule[2].budgetMinutes,40);
});
test('an edit cannot silently truncate today or move the original start date',()=>{
  const spec={...initial(),startDate:'2026-09-06',targetDeadline:'2026-09-10'};
  const old=generateLongTermSchedule(inventory,spec,{}, {asOfDate:'2026-09-06',generatedAt:'2026-09-06T00:00:00.000Z',maxProposalExtensionDays:0,maxProposalExtraMinutes:0});
  assert.throws(()=>preview({...spec,targetDeadline:'2026-09-06'},old),/long-term-deadline-future/);
  assert.throws(()=>preview({...spec,startDate:'2026-09-08'},old),/long-term-original-start/);
});
test('new subjects are explicit in an updated preview instead of silently losing their inventory',()=>{
  const actual=source();actual.subjects.push({subjectId:'code',name:'Programming',priority:4});
  actual.inventory.push({itemId:'code:1',subjectId:'code',sourceHash:'b'.repeat(64),estimatedMinutes:20});
  const next=preview(initial(),null,actual);
  assert.ok(next.spec.subjectsConfig.some(subject=>subject.subjectId==='code'));
  assert.ok(next.schedule.some(slot=>slot.newItemIds.includes('code:1'))||next.backlog.some(item=>item.itemId==='code:1'));
  assert.ok(next.warnings.includes('new-subjects-included'));
});
