import test from 'node:test';
import assert from 'node:assert/strict';
import {checkContentQuality} from '../src/domain/assessment/index.ts';
import {buildRecallPrompt} from '../app/recall-content.ts';
import {practiceForPlan} from '../app/plan-runtime.ts';
import {studyFocusSummary,selectStudyTask} from '../app/study-view-model.ts';
import {loader} from './helpers/causal-harness.mjs';
const generic='请闭卷回忆「AlexNet P2 · 组件精确命名」的核心要点，并说明相关概念、依据或适用条件。';
const material={itemId:'material',questionType:'recall',prompt:generic,answer:'这是来源中的原始材料。',explanation:'这是来源中的原始材料。',sourceLabel:'AlexNet P2',fingerprint:'original'};
const concrete={itemId:'question',questionType:'recall',prompt:'ReLU 在输入为负数时输出多少？',answer:'0',explanation:'负输入映射为0。',fingerprint:'specific'};

test('generic heading recall is readable but cannot be assessed or self-graded',()=>{
 const before=structuredClone(material),check=checkContentQuality('recall',material);
 assert.equal(check.capabilities.canDisplay,true);assert.equal(check.capabilities.canSelfCheck,false);assert.equal(check.capabilities.canAutoAssess,false);
 assert.ok(check.issues.some(issue=>issue.code==='unfocused-recall-question'));assert.deepEqual(material,before);
});
test('source-only generation does not dress up a label as a question',()=>{
 assert.match(buildRecallPrompt('负值置零，正值保持不变。','ReLU'),/待补具体问题/);
 assert.match(buildRecallPrompt('ReLU 在输入为负数时输出多少？','ReLU'),/待补具体问题/);
});
test('concrete source-backed questions remain available',()=>{
 const check=checkContentQuality('recall',concrete);assert.equal(check.capabilities.canSelfCheck,true);assert.equal(check.capabilities.canAutoAssess,true);
});
test('default legacy queue withholds vague material without deleting its source',()=>{
 const source=[material,concrete],before=structuredClone(source);
 assert.deepEqual(practiceForPlan(null,[],source),[concrete]);assert.deepEqual(source,before);
});
test('withheld items do not become the default task or count as completed work',()=>{
 const tasks=['material','question'].map(taskId=>({taskId,title:taskId,action:{kind:'practice'}}));
 const input={ready:true,tasks,withheldTaskIds:['material'],completedTaskIds:[],startedTaskIds:['material']};
 assert.equal(selectStudyTask(input)?.taskId,'question');assert.equal(studyFocusSummary(input).groups,1);
 assert.deepEqual(input.completedTaskIds,[]);
});
test('grouping uses original recall quality even if a user selected flashcard display',()=>{
 const load=loader({}, {'app/study-submission-history.ts':{},'app/account-study-planning-projection.ts':{}});
 const {resolvePlanningGroups}=load('app/study-dashboard/planning-source-adapter.ts');
 const items=[material,concrete].map(item=>({...item,id:item.itemId,accountItemKey:item.itemId,pluginType:'recall'}));
 const plan={day:'2026-09-20',tasks:items.map(item=>({taskId:item.itemId,subjectId:'paper',category:'review',title:item.itemId,action:{kind:'practice',itemKeys:[item.itemId]}}))};
 const catalog={subjects:[{subjectId:'paper',words:[]}],sourceHash:'source'};
 const groups=resolvePlanningGroups(plan,catalog,[{id:'paper',pluginType:'recall',items}],{itemStages:{}},{subject:{paper:'flashcard'},item:{}});
 assert.deepEqual(groups.flatMap(group=>group.itemKeys),['question']);assert.equal(plan.tasks.length,2);
});

test('mixed task retains concrete items while withholding only unsuitable items',()=>{
 const load=loader({}, {'app/study-submission-history.ts':{},'app/account-study-planning-projection.ts':{}});
 const {resolvePlanningGroups}=load('app/study-dashboard/planning-source-adapter.ts');
 const items=[material,concrete].map(item=>({...item,id:item.itemId,accountItemKey:item.itemId,pluginType:'recall'}));
 const task={taskId:'mixed',subjectId:'paper',category:'review',title:'Mixed',action:{kind:'practice',itemKeys:['material','question']}},before=structuredClone(task);
 const groups=resolvePlanningGroups({day:'2026-09-20',tasks:[task]},{subjects:[{subjectId:'paper',words:[]}]},[{id:'paper',pluginType:'recall',items}],{itemStages:{}},{subject:{},item:{}});
 assert.equal(groups.length,1);assert.deepEqual(groups[0].itemKeys,['question']);assert.deepEqual(groups[0].keysByTask.mixed,['question']);
 assert.deepEqual(groups[0].adapter.items.flatMap(item=>item.practice.itemKeys),['question']);assert.deepEqual(task,before);assert.deepEqual(groups[0].tasks,[task]);
});

test('malformed imported prompt cannot crash quality checking or grouping',()=>{
 for(const prompt of [42,{},null])assert.doesNotThrow(()=>checkContentQuality('recall',{prompt,answer:'valid'}));
});
