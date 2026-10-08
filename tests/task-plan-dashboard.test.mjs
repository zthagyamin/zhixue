import assert from 'node:assert/strict';
import test from 'node:test';
import {dashboardFunction} from './fixtures/dashboard-functions.mjs';
import {selectEffectivePlan} from '../app/plan-runtime.ts';
import {readDashboardSource} from './helpers/dashboard-source.mjs';
const source=await readDashboardSource();
test('dashboard gates V2 on protocol support and connects TodayLearning to a persisted session',()=>{
  assert.ok(/supportsTaskPlanning/.test(source));assert.ok(/<TodayLearning/.test(source));assert.ok(/useTaskPlanning\(/.test(source));
});
test('dashboard loads complete planning and task channels before building facts',()=>{
  assert.ok(/loadPlanningRecords\(/.test(source));assert.ok(/syncTaskEvents\(/.test(source));assert.ok(/notify:\s*false/.test(source));
});
test('task scopes are separate from the global free-study module catalog',()=>{
  const draft={day:'2026-09-05',items:[]},context={currentDay:draft.day,planCandidate:draft,planCurrent:null,selectEffectivePlan};
  assert.equal(dashboardFunction('effectivePlan',{...context,taskPlanningEnabled:true,accountLoaded:null}),null);
  assert.equal(dashboardFunction('effectivePlan',{...context,taskPlanningEnabled:false,accountLoaded:{}}),null);
  assert.equal(dashboardFunction('effectivePlan',{...context,taskPlanningEnabled:false,accountLoaded:null}),draft);
});
test('module never records the displayed stage as completed evidence',()=>{
  assert.ok(!/stageBefore:\s*currentStage/.test(source));
});
test('older Companions show an explicit upgrade notice and module browsing is not labeled as the daily target',()=>{
  assert.ok(source.includes('尚未支持任务型今日学习'));assert.ok(source.includes('模块浏览进度'));assert.ok(source.includes('自由学习入口'));
});
