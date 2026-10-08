import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {accountPlanningVectors} from './fixtures/account-planning-vectors.mjs';
import {vocabularyInput} from './fixtures/task-plan-input.mjs';
import {generateTaskPlan} from '../src/domain/planning/index.ts';
const groups=[{id:'g',title:'论文共用',subjectIds:['course','vocab'],minutes:3,defaultItemMinutes:3}];
const task=(id,category='review')=>({taskId:id,subjectId:'course',title:`具体任务${id}`,category,unitIds:[],quantity:1,action:{kind:'practice',itemKeys:[id]}});
const html=element=>renderToStaticMarkup(element).replace(/<!--.*?-->/g,'');
const noop=()=>{};
test('real subject grouping renders budget, shared names, retained overage, default estimate and visible deferred reasons',()=>{
 const {StudySubjectTaskGroups}=loadTsx(new URL('../app/study-subject-task-groups.tsx',import.meta.url));
 const rendered=html(h(StudySubjectTaskGroups,{tasks:[task('done'),task('locked','subject'),task('later')],subjects:[{subjectId:'course',name:'方法课'},{subjectId:'vocab',name:'英文'}],practiceBudgetGroups:groups,ready:true,completedTaskIds:['done'],startedTaskIds:['locked'],renderTask:row=>h('li',{key:row.taskId},row.title)}));
 assert.match(rendered,/预计 6 \/ 3 分钟/);assert.match(rendered,/方法课、英文/);assert.match(rendered,/超出预算 3 分钟/);assert.match(rendered,/当前 2 项使用默认估时/);assert.match(rendered,/还有 1 项未列入今日目标/);assert.match(rendered,/原任务和到期时间保留/);assert.match(rendered,/明确追加/);
});
test('native TodayLearning renders the budget from the issued snapshot',async()=>{
 const input=vocabularyInput(0),plan=await generateTaskPlan(input);plan.tasks=[task('first'),task('later')];plan.longTermAllocation={practiceBudgetGroups:groups};
 const {TodayLearning}=loadTsx(new URL('../app/today-learning.tsx',import.meta.url));
 const rendered=html(h(TodayLearning,{plan,catalog:input.catalog,summary:{newDone:0,newTarget:20,newMissing:20,reviewDone:0,reviewTotal:2},completedTaskIds:[],dirty:false,loading:false,ready:true,message:'',studyFirst:true,onGenerate:noop,onReload:noop,onStart:noop,onEdit:noop,onSuggest:noop,onSave:noop,onComplete:noop,onOptionalMinutes:noop}));
 assert.match(rendered,/论文共用/);assert.match(rendered,/预计 3 \/ 3 分钟/);assert.match(rendered,/还有 1 项未列入今日目标/);
});
test('account AccountStudyPlan renders the identical budget with approved locked tasks',async()=>{
 const f=await accountPlanningVectors(),plan={...f.cloudPlan,tasks:[task('first'),task('later')],longTermAllocation:{practiceBudgetGroups:groups},manual:{lockedTaskIds:['first'],excludedUnitIds:[]}};
 const loaded={catalog:f.catalog,catalogs:[f.catalog],facts:f.facts,bundle:{snapshot:{libraryId:'library-a'},items:[]},bundles:[],records:[],eventThrough:0};
 const {AccountStudyPlan}=loadTsx(new URL('../app/account-study-controls.tsx',import.meta.url));
 const rendered=html(h(AccountStudyPlan,{client:{},loaded,day:plan.day,workspaceId:'synthetic',state:{revision:1,approvedPlan:plan,currentPlan:plan,approvedOperationId:'approved'},refreshPlanState:async()=>{},studyFirst:true}));
 assert.match(rendered,/论文共用/);assert.match(rendered,/预计 3 \/ 3 分钟/);assert.match(rendered,/还有 1 项未列入今日目标/);
});
test('compact budget controls default off, list actual subjects and expose existing edit callbacks',()=>{
 const {PracticeBudgetControls}=loadTsx(new URL('../src/features/planning/practice-budget-controls.tsx',import.meta.url));
 const base={spec:{subjectsConfig:[]},subjects:[{subjectId:'course',name:'方法课'},{subjectId:'vocab',name:'英文'}],busy:false,onChange:noop};
 assert.doesNotMatch(html(h(PracticeBudgetControls,base)),/type="checkbox"/);
 const rendered=html(h(PracticeBudgetControls,{...base,spec:{...base.spec,practiceBudgetGroups:groups}}));
 assert.match(rendered,/方法课/);assert.match(rendered,/英文/);assert.equal((rendered.match(/type="checkbox"/g)||[]).length,2);assert.match(rendered,/删除此预算组/);assert.match(rendered,/每天共用分钟/);
});
