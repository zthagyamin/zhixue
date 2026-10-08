import test from 'node:test';
import assert from 'node:assert/strict';
import {generateLongTermSchedule} from '../app/long-term-pacing.ts';
import {parseLongTermPlanSpec} from '../app/long-term-plan-types.ts';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
const api=await import('../app/study-review-goal.ts').catch(()=>({}));
const spec={planId:'p',startDate:'2026-09-09',targetDeadline:'2026-09-15',dailyMinutesBudget:{workdayMin:0,workdayMax:60,weekendMax:60,minReviewRatio:.3},subjectsConfig:[{subjectId:'vocab',priority:3,dailyQuotaTarget:6,completionCriteria:'fixed-rounds'}],bufferRatio:0,dailyReviewTarget:2};
test('review goal limits forecast rounds and retains unserved due load',()=>{
 const items=Array.from({length:12},(_,i)=>({itemId:`v${i}`,subjectId:'vocab',sourceHash:'h',estimatedMinutes:1,reviewMinutes:1}));
 const p=generateLongTermSchedule(items,spec,{}, {asOfDate:'2026-09-09',generatedAt:'2026-09-09T00:00:00Z'});
 assert.ok(p.schedule.some(s=>s.reviewItemIds.length>0));
 assert.ok(p.schedule.every(s=>s.reviewItemIds.length<=2));
 assert.ok(p.schedule.some(s=>s.unservedReviewMinutes>0));
 for(const value of [-1,1.5,NaN,10001])assert.throws(()=>parseLongTermPlanSpec({...spec,dailyReviewTarget:value}));
});
test('daily review goal keeps every obligation and protects started and completed tasks',()=>{
 assert.equal(typeof api.reviewGoalView,'function');
 const tasks=[{taskId:'new',category:'new-word'},...Array.from({length:8},(_,i)=>({taskId:`r${i}`,category:'review'}))],before=structuredClone(tasks);
 const view=api.reviewGoalView(tasks,3,0,['r0'],['r7']);
 assert.ok(view.visible.some(t=>t.taskId==='new'));assert.ok(view.visible.some(t=>t.taskId==='r7'));
 assert.equal(view.visible.filter(t=>t.category==='review').length,3);
 assert.equal(view.deferred.length,5);assert.equal(view.completed,1);
 assert.deepEqual([...view.visible,...view.deferred].map(t=>t.taskId).sort(),tasks.map(t=>t.taskId).sort());
 assert.equal(api.reviewGoalView(tasks,3,2,[],[]).visible.length,6);
 assert.deepEqual(api.reviewGoalView(tasks,undefined,0,[],[]).visible,tasks);
 assert.deepEqual(tasks,before);
});

test('review goal applies only during the enabled plan horizon',()=>{
 const state={enabled:true,snapshot:{spec}};assert.equal(api.activeDailyReviewTarget(state,'2026-09-10'),2);assert.equal(api.activeDailyReviewTarget(state,'2026-09-08'),undefined);assert.equal(api.activeDailyReviewTarget(state,'2026-09-16'),undefined);assert.equal(api.activeDailyReviewTarget({...state,enabled:false},'2026-09-10'),undefined);
});
test('friendly form retains advanced controls while distinguishing words and reviews',()=>{
 const {LongTermPlanForm}=loadTsx(new URL('../app/long-term-plan-form.tsx',import.meta.url));
 const source={subjects:[{subjectId:'vocab',name:'词汇',priority:3}],bindings:[{subjectId:'vocab',kind:'vocabulary'}],inventory:[],history:[],fsrsMap:{},diagnostics:[],assumptions:[]};
 const html=renderToStaticMarkup(h(LongTermPlanForm,{spec,source,tomorrow:'2026-09-09',startLocked:false,busy:false,active:true,onChange(){throw new Error('Rendering cannot change the plan');},currentSourceStamp:()=> 's'}));
 for(const label of ['每天新学单词','每日复习目标（条）','学科优先级','目标留存率','让 AI 帮我制订计划','至少完成几轮','为复习预留的时间','减少弹性任务的天数占比'])assert.ok(html.includes(label),label);
 assert.match(html,/<details class="long-term-advanced">/);
});
