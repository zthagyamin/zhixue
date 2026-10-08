import assert from 'node:assert/strict';
import test from 'node:test';
import {loadTsx} from './fixtures/tsx-components.mjs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {vocabularyInput,courseSubject} from './fixtures/task-plan-input.mjs';
import {generateTaskPlan} from '../app/task-plan-engine.ts';
let TodayLearning;
try {
  TodayLearning=loadTsx(new URL('../app/today-learning.tsx',import.meta.url)).TodayLearning;
} catch(error) {if(error.code!=='ENOENT') throw error;}
const noop=()=>{};
function render(props={}) {
  assert.equal(typeof TodayLearning,'function','TodayLearning renders a real React component');
  return renderToStaticMarkup(React.createElement(TodayLearning,{plan:null,catalog:null,summary:{newDone:0,newTarget:20,newMissing:0,reviewDone:0,reviewTotal:0},
    completedTaskIds:[],dirty:false,loading:false,ready:true,message:'',onGenerate:noop,onReload:noop,onStart:noop,onEdit:noop,onSuggest:noop,onSave:noop,onComplete:noop,onOptionalMinutes:noop,...props}));
}
test('no plan explains free study and has a generation action without a time prerequisite',()=>{
  const html=render();assert.match(html,/生成今日安排/);assert.match(html,/自由学习/);assert.match(html,/今天还没生成计划/);
  assert.doesNotMatch(html,/required=""/);
  assert.doesNotMatch(html,/上方模块|下方模块/,'The empty state must not describe the previous dashboard ordering');
});
test('mandatory counters remain distinct from optional subject tasks',async()=>{
  const input=vocabularyInput(20);input.catalog.subjects.push(courseSubject(1));const plan=await generateTaskPlan(input);
  const html=render({plan,catalog:input.catalog,dirty:true,summary:{newDone:7,newTarget:20,newMissing:0,reviewDone:2,reviewTotal:5}});
  assert.match(html,/新学单词/);assert.match(html,/7 \/ 20/);assert.match(html,/到期复习/);assert.match(html,/2 \/ 5/);
  assert.match(html,/学科任务/);assert.match(html,/尚未保存到学习知识库/);assert.match(html,/保存到学习知识库/);
  assert.match(html,/少安排一点/);assert.match(html,/再加一点/);
});

test('unsaved local changes stay visible outside the closed editing panel',async()=>{
  const input=vocabularyInput(1),plan=await generateTaskPlan(input);
  const html=render({studyFirst:true,plan,catalog:input.catalog,dirty:true});
  assert.match(html.slice(0,html.indexOf('<dialog')),/尚未保存到学习知识库/);
});

test('local editor contains action errors and draft recovery without requiring modal dismissal',async()=>{
  const input=vocabularyInput(1),plan=await generateTaskPlan(input);
  const html=render({studyFirst:true,plan,message:'保存失败，请重试',hasBackup:true,onRestoreBackup:noop});
  const panel=html.slice(html.indexOf('<dialog'));
  assert.match(panel,/保存失败，请重试/);
  assert.match(panel,/恢复上一份本机草稿/);
});
test('self-report has an explicit completion action while formal units do not',async()=>{
  const input=vocabularyInput(0),subject=courseSubject(2);input.catalog.subjects.push(subject);
  const plan=await generateTaskPlan(input);plan.tasks[1].completionRule='formal-done';
  const html=render({plan,catalog:input.catalog});
  assert.equal((html.match(/记录本次完成/g)||[]).length,1);assert.match(html,/以学习知识库正式进度为准/);
});
test('completed tasks are marked accessibly and blocked sources retain diagnostics',async()=>{
  const input=vocabularyInput(2),plan=await generateTaskPlan(input);plan.tasks[0].blockedReason='来源已更新，请确认';
  const html=render({plan,catalog:input.catalog,completedTaskIds:[plan.tasks[0].taskId],message:'AI 未配置，规则任务可照常学习。'});
  assert.match(html,/已完成/);assert.match(html,/line-through/);assert.match(html,/来源已更新，请确认/);assert.match(html,/AI 未配置/);
  assert.match(html,/确认资料更新/);assert.match(html,/<details/);
});
test('repeated review rounds show their due times and manual tasks expose their quantity',async()=>{
  const input=vocabularyInput(1);
  input.reviews=[{roundId:'r:one',itemKey:'word:0',subjectId:'vocab',dueAt:'2026-08-31T00:00:00Z',completed:true,completionRule:'three-stage'},
    {roundId:'r:two',itemKey:'word:0',subjectId:'vocab',dueAt:'2026-08-31T01:00:00Z',completed:false,completionRule:'three-stage'}];
  const plan=await generateTaskPlan(input);
  plan.tasks.push({taskId:'manual:quantity',subjectId:'vocab',title:'整理笔记',category:'subject',origin:'manual',required:false,unitIds:[],quantity:2,action:{kind:'manual'},completionRule:'self-report',sourceHash:input.catalog.sourceHash});
  const html=render({plan,catalog:input.catalog,reviewRounds:input.reviews,completedTaskIds:['r:one']});
  assert.match(html,/08:00 到期/);assert.match(html,/09:00 到期/);assert.match(html,/本轮已完成/);assert.match(html,/本次数量：2 项/);
});
test('unverified history shows unknown counters, while a verified offline snapshot is labeled explicitly',async()=>{
  const input=vocabularyInput(1),plan=await generateTaskPlan(input);
  const unknown=render({plan,hasVerifiedHistory:false,ready:false});assert.match(unknown,/待核对/);assert.doesNotMatch(unknown,/0 \/ 20/);
  const offline=render({plan,offline:true,lastSyncedAt:'2026-08-31T01:00:00Z'});assert.match(offline,/离线/);assert.match(offline,/上次完整同步/);
});
test('ordinary sync explains the retained draft without exposing revision arbitration',async()=>{
  const input=vocabularyInput(1),plan=await generateTaskPlan(input);
  const html=render({plan,catalog:input.catalog,ready:true,conflict:{revision:2,sourceHash:plan.sourceHash,local:{plan,baseRevision:1,dirty:true},remote:plan},
    message:'已同步最新安排；未保存的本机调整已保留，可在“调整安排”中恢复。',hasBackup:true,onRestoreBackup:noop});
  assert.match(html,/已同步最新安排/);assert.doesNotMatch(html,/计划版本冲突|保留本机安排，重新核对|采用知识库安排|更新到版本/);assert.match(html,/恢复上一份本机草稿/);
});
test('500 review tasks render in batches without hiding new words or lowering the total',async()=>{
  const input=vocabularyInput(20);
  input.catalog.practiceSources=Array.from({length:500},(_,i)=>({itemKey:`practice:review-${i}`,subjectId:'vocab',title:`Review ${i}`,sourceHash:'a'.repeat(64),completionRule:'graded-practice'}));
  input.reviews=input.catalog.practiceSources.map((source,i)=>({...source,roundId:`r:${i}`,dueAt:'2026-08-31T00:00:00Z',completed:false}));
  const plan=await generateTaskPlan(input),before=structuredClone(plan);
  const html=render({plan,catalog:input.catalog,reviewRounds:input.reviews,summary:{newDone:0,newTarget:20,newMissing:0,reviewDone:0,reviewTotal:500}});
  assert.equal((html.match(/>去复习<\/button>/g)||[]).length,50);
  assert.match(html,/0 \/ 500/);assert.match(html,/展开更多复习/);assert.match(html,/50 \/ 500/);assert.match(html,/去背词/);
  assert.deepEqual(plan,before,'Batch presentation cannot truncate the saved task set');
});
