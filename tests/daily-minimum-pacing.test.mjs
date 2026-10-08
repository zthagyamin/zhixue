import test from 'node:test';
import assert from 'node:assert/strict';
import {generateLongTermSchedule} from '../app/long-term-pacing.ts';
import {parseLongTermPlanSnapshot,parseLongTermPlanSpec} from '../app/long-term-plan-types.ts';

const day='2026-09-21';
const options={asOfDate:day,generatedAt:`${day}T00:00:00.000Z`,maxProposalExtensionDays:0,maxProposalExtraMinutes:0};
const spec=(patch={})=>({planId:'minimum',startDate:day,targetDeadline:day,timeBudgetMode:'advisory',
 dailyMinutesBudget:{workdayMin:0,workdayMax:1,weekendMax:1,minReviewRatio:.35},bufferRatio:0,
 subjectsConfig:[{subjectId:'academic',priority:5,dailyMinimumTarget:20,dailyQuotaTarget:20,completionCriteria:'fixed-rounds'},
 {subjectId:'speaking',priority:5,dailyMinimumTarget:5,dailyQuotaTarget:5,completionCriteria:'fixed-rounds'}],...patch});
const items=()=>['academic','speaking'].flatMap(subjectId=>Array.from({length:30},(_,i)=>({itemId:`${subjectId}:${i}`,subjectId,sourceHash:'h',estimatedMinutes:3})));

test('confirmed 20 academic and 5 speaking minima survive uncalibrated one-minute estimate budget',()=>{
 const p=generateLongTermSchedule(items(),spec(),{},options),s=p.schedule[0];
 assert.deepEqual({...s.expectedNewItems},{academic:20,speaking:5});
 assert.ok(s.warnings.includes('estimate-over-budget'));
 assert.deepEqual(parseLongTermPlanSnapshot(p),p);
});
test('buffer day retains minima and does not assign optional extras',()=>{
 const p=generateLongTermSchedule(items(),spec({bufferRatio:1}),{},options);
 assert.equal(p.schedule[0].isBufferDay,true);assert.equal(p.schedule[0].newItemIds.length,25);
});
test('blocked and insufficient content yields visible shortfall without fabricated IDs',()=>{
 const input=items().filter(i=>i.subjectId==='speaking').slice(0,3);input[0].blockedReason='history-unknown';
 const s=generateLongTermSchedule(input,spec(),{},options).schedule[0];
 assert.equal(s.expectedNewItems.speaking,2);assert.ok(!s.newItemIds.includes(input[0].itemId));
 assert.ok(s.warnings.includes('minimum-shortfall:academic'));assert.ok(s.warnings.includes('minimum-shortfall:speaking'));
});
test('legacy absent mode keeps strict budgets; explicit limit reports unmet minima',()=>{
 const legacy=spec();delete legacy.timeBudgetMode;legacy.subjectsConfig.forEach(s=>delete s.dailyMinimumTarget);
 assert.equal(generateLongTermSchedule(items(),legacy,{},options).schedule[0].newItemIds.length,0);
 const s=generateLongTermSchedule(items(),spec({timeBudgetMode:'limit'}),{},options).schedule[0];
 assert.equal(s.newItemIds.length,0);assert.ok(s.warnings.includes('minimum-shortfall:academic'));
});
test('invalid minima, modes and floor above cap are rejected',()=>{
 for(const minimum of [-1,1.5,Infinity,21]){const s=spec();s.subjectsConfig[0].dailyMinimumTarget=minimum;assert.throws(()=>parseLongTermPlanSpec(s));}
 assert.throws(()=>parseLongTermPlanSpec(spec({timeBudgetMode:'ignore-all'})));
});
test('minimum pass resumes after a scheduled prerequisite becomes available',()=>{
 const s=spec({subjectsConfig:[{subjectId:'prep',priority:3,completionCriteria:'fixed-rounds'},
 {subjectId:'words',priority:5,completionCriteria:'fixed-rounds',dailyMinimumTarget:2,dailyQuotaTarget:2}],dailyMinutesBudget:{workdayMin:0,workdayMax:1,weekendMax:1,minReviewRatio:0}});
 const inventory=[{itemId:'prep',subjectId:'prep',sourceHash:'h',estimatedMinutes:1},...Array.from({length:2},(_,i)=>({itemId:`w${i}`,subjectId:'words',sourceHash:'h',estimatedMinutes:3,prerequisiteItemIds:['prep']}))];
 const slot=generateLongTermSchedule(inventory,s,{},options).schedule[0];
 assert.deepEqual(slot.newItemIds,['prep','w0','w1']);assert.equal(slot.expectedNewItems.words,2);
});
