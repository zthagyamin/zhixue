import test from 'node:test';
import assert from 'node:assert/strict';
import {vocabularyInput,courseSubject} from './fixtures/task-plan-input.mjs';
import {buildLongTermPlanningInput} from '../app/long-term-planning-input.ts';
import {generateLongTermSchedule} from '../app/long-term-pacing.ts';
import {generateTaskPlan} from '../app/task-plan-engine.ts';
import {applyLongTermPlan} from '../app/long-term-daily-plan.ts';
import {applyTaskSuggestions} from '../app/task-plan-runtime.ts';
import {editTaskPlan} from '../app/task-plan-edit.ts';
import {parseLongTermDailyAllocation} from '../app/long-term-daily-allocation.ts';
import {createCompanionPlanClient} from '../app/companion-plan-client.ts';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {readDashboardSourceSync} from './helpers/dashboard-source.mjs';
const overlap=await import('../app/task-plan-overlap.ts').catch(()=>({}));
function forecast(input,review=3){const source=buildLongTermPlanningInput(input);return generateLongTermSchedule(source.inventory,{planId:'long',startDate:input.day,targetDeadline:input.day,dailyMinutesBudget:{workdayMin:0,workdayMax:15,weekendMax:15,minReviewRatio:0},subjectsConfig:input.catalog.subjects.map(s=>({subjectId:s.subjectId,priority:3,completionCriteria:'fixed-rounds'})),bufferRatio:0,dailyReviewTarget:review},{},{asOfDate:input.day,generatedAt:`${input.day}T00:00:00Z`});}
test('today retains its issued long-term quota and review goal when the future plan changes or pauses',async()=>{
 const input=vocabularyInput(),snapshot=forecast(input),first=applyLongTermPlan(input,snapshot),plan=await generateTaskPlan(first);
 assert.equal(first.longTermAllocation.reviewTarget,3);assert.equal(first.longTermAllocation.budgetMinutes,15);
 const today={...input,previous:plan};
 for(const next of [null,forecast(input,30)]){
  const retained=applyLongTermPlan(today,next);assert.deepEqual(retained.longTermAllocation,first.longTermAllocation);
  assert.equal((await generateTaskPlan(retained)).vocabulary.target,5);
 }
 const nextDay={...today,day:'2026-09-01'};assert.equal(applyLongTermPlan(nextDay,null).longTermAllocation,undefined);
});
test('an independent today plan is not silently switched to a new long-term quota',async()=>{
 const input=vocabularyInput(),previous=await generateTaskPlan(input);
 assert.equal(applyLongTermPlan({...input,previous},forecast(input)).longTermAllocation,undefined);
});
test('AI cannot add a second unit for physical work already assigned by long-term planning',async()=>{
 const input=vocabularyInput(0),subject=courseSubject();subject.goals=[];const unit=subject.units[0];unit.action={kind:'practice',itemKeys:['physical']};unit.completionRule='graded-practice';input.catalog.subjects=[subject];input.catalog.practiceSources=[{itemKey:'physical',subjectId:subject.subjectId,title:'Practice',sourceHash:unit.sourceHash,completionRule:unit.completionRule}];
 input.longTermAllocation={schemaVersion:1,planId:'long',day:input.day,vocabularyTarget:0,items:[{itemId:'physical',subjectId:subject.subjectId,kind:'practice',itemKeys:['physical'],unitIds:[unit.unitId],sourceHash:unit.sourceHash}]};
 const plan=await generateTaskPlan(input);
 assert.ok(overlap.coveredPlanningUnitIds(plan,input.catalog).includes(unit.unitId));
 await assert.rejects(applyTaskSuggestions(plan,{day:plan.day,sourceHash:plan.sourceHash,draftVersion:plan.draftVersion,mode:'ai',selections:[{unitIds:[unit.unitId],reason:'extra'}],message:''},input.catalog),/ineligible|duplicate/);
 await assert.rejects(editTaskPlan(plan,{type:'upsert',task:{taskId:'manual-copy',subjectId:unit.subjectId,title:'Again',category:'subject',origin:'manual',required:false,unitIds:[unit.unitId],quantity:1,action:unit.action,completionRule:unit.completionRule,sourceHash:unit.sourceHash}},input.catalog),/重复/);
});
test('unrelated catalog changes preserve issued identities, changed assigned content fails closed',async()=>{
 const input=vocabularyInput(),plan=await generateTaskPlan(applyLongTermPlan(input,forecast(input)));
 const changed=structuredClone(input);changed.catalog.sourceHash='b'.repeat(64);changed.catalog.subjects.push(courseSubject());changed.previous=plan;
 const next=await generateTaskPlan(applyLongTermPlan(changed,null));assert.equal(next.vocabulary.target,5);assert.deepEqual(next.longTermAllocation,plan.longTermAllocation);
 changed.catalog.subjects[0].words[0].sourceHash='c'.repeat(64);await assert.rejects(generateTaskPlan(applyLongTermPlan(changed,null)),/long-term-source/);
});
test('fixed daily policy validates null defaults and numeric boundaries without changing legacy records',()=>{
 const base={schemaVersion:1,planId:'p',day:'2026-09-09',vocabularyTarget:0,items:[]};assert.deepEqual(parseLongTermDailyAllocation(base),base);
 assert.equal(parseLongTermDailyAllocation({...base,reviewTarget:null,budgetMinutes:12}).reviewTarget,null);
 for(const patch of [{reviewTarget:-1},{reviewTarget:1.5},{reviewTarget:10001},{budgetMinutes:-1},{budgetMinutes:1441},{budgetMinutes:12.5},{budgetMinutes:null}])assert.throws(()=>parseLongTermDailyAllocation({...base,...patch}));
});
test('old Companion is detected before sending a new-policy plan and refreshed capabilities allow an upgraded server',async()=>{
 const input=vocabularyInput(),plan=await generateTaskPlan(applyLongTermPlan(input,forecast(input)));let posts=0,upgraded=false;
 const client=createCompanionPlanClient({baseUrl:'http://local',sessionToken:'test',capabilities:['task-planning-v1'],fetcher:async(url,init)=>{if(init?.method==='POST')posts++;return{ok:true,status:200,json:async()=>url.endsWith('/v1/health')?{capabilities:upgraded?['daily-plan-policy-v1']:['task-planning-v1']}:{status:'ok'}};}});
 await assert.rejects(client.applyTaskPlan(plan,0),/更新并重启/);assert.equal(posts,0);upgraded=true;assert.equal((await client.applyTaskPlan(plan,0)).status,'ok');assert.equal(posts,1);
});
test('relationship UI separates frozen today policy from future changes and both modes wire the same editor',()=>{
 const {PlanRelationshipNotice}=loadTsx(new URL('../app/plan-relationship-notice.tsx',import.meta.url));
 const html=renderToStaticMarkup(h(PlanRelationshipNotice,{hasPlan:true,allocation:{vocabularyTarget:5,reviewTarget:3,budgetMinutes:20},onLongTerm(){throw new Error('Render cannot navigate');}}));
 assert.match(html,/今日安排来自长线计划/);assert.match(html,/5 个/);assert.match(html,/今天的配额已固定/);assert.match(html,/额外/);
 const dashboard=readDashboardSourceSync();assert.match(dashboard,/<TodayLearning\b[^>]*studyFirst onLongTerm=/);assert.match(dashboard,/<AccountStudyPlan\b[^>]*studyFirst onLongTerm=/);assert.match(dashboard,/onOpenRequestHandled=\{version=>setLongTermOpenRequest/);
});

test('dedup preserves different completion rules and deliberate manual groups with additional content',()=>{
 const unit={unitId:'u',subjectId:'s',action:{kind:'practice',itemKeys:['a','b']},completionRule:'graded-practice'};const tasks=[{subjectId:'s',unitIds:[],action:{kind:'practice',itemKeys:['a']},completionRule:'graded-practice'}];
 assert.equal(overlap.planningUnitAlreadyScheduled(unit,tasks),true);assert.equal(overlap.planningUnitAlreadyScheduled(unit,tasks,'complete'),false);assert.equal(overlap.planningUnitAlreadyScheduled({...unit,completionRule:'formal-mastered'},tasks),false);
});
