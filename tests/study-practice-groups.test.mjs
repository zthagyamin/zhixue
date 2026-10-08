import test from 'node:test';
import assert from 'node:assert/strict';
import {vocabularyInput} from './fixtures/task-plan-input.mjs';
import {generateTaskPlan} from '../app/task-plan-engine.ts';
import {selectStudyTask,studyFocusSummary} from '../app/study-view-model.ts';
import {createSubjectRoundSessions} from '../app/subject-round-resume.ts';
import {advanceSubjectRound,emptySubjectRound} from '../app/subject-round.ts';
import {editTaskPlan} from '../app/task-plan-edit.ts';
import {reviewGoalView} from '../app/study-review-goal.ts';
let api;try{api=await import('../app/study-practice-groups.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
async function fixture(){
  const input=vocabularyInput(4),base=await generateTaskPlan(input),original=base.tasks[0];
  const tasks=original.action.itemKeys.map((key,index)=>({...original,taskId:'review-'+index,title:'复习 '+index,category:'review',reviewRoundId:'round-'+index,
    quantity:1,action:{kind:'practice',itemKeys:[key]},sourceHash:input.catalog.subjects[0].words[index].sourceHash}));
  return {input,plan:{...base,tasks:[...tasks,{...original,taskId:'new-words'}]}};
}
test('one-word review assignments form one continuous word group, separate from new learning',async()=>{
  assert.equal(typeof api?.studyPracticeGroups,'function');const {input,plan}=await fixture(),before=structuredClone(plan);
  const groups=api.studyPracticeGroups(plan,input.catalog,()=> 'three-stage');assert.equal(groups.length,2);
  const group=groups.find(group=>group.tasks[0].category==='review');
  assert.equal(group.tasks.length,4);assert.equal(group.adapter.items.length,1);assert.equal(group.adapter.items[0].practice.count,4);
  assert.deepEqual(group.itemKeys,['word:0','word:1','word:2','word:3']);assert.deepEqual(plan,before);
});
test('different actual modes and blocked tasks do not join a group',async()=>{
  assert.equal(typeof api?.studyPracticeGroups,'function');const {input,plan}=await fixture();plan.tasks[1].blockedReason='source changed';
  const groups=api.studyPracticeGroups(plan,input.catalog,key=>key==='word:2'?'flashcard':'three-stage');
  const group=groups.find(group=>group.tasks.some(task=>task.taskId==='review-0'));
  assert.deepEqual(group.tasks.map(task=>task.taskId),['review-0','review-3']);assert.ok(groups.every(group=>group.tasks.every(task=>!task.blockedReason)));
});
test('same-page recall traversal advances navigation without inventing formal task completion',async()=>{
  const tasks=[{taskId:'a',title:'A',action:{kind:'practice'}},{taskId:'b',title:'B',action:{kind:'practice'}}];
  const state={ready:true,tasks,completedTaskIds:[],startedTaskIds:['a'],finishedPassTaskIds:['a'],practiceGroupByTask:{a:'recall',b:'recall'}};
  assert.equal(selectStudyTask(state)?.taskId,'b');assert.equal(selectStudyTask(state)?.kind,'continue');
  assert.equal(studyFocusSummary(state).groups,1);assert.deepEqual(state.completedTaskIds,[]);
  assert.equal(selectStudyTask({...state,finishedPassTaskIds:['a','b']}),null);
});
test('group scope covers every member source and round, and retains only matching page-local passes',async()=>{
  assert.equal(typeof api?.practiceGroupScope,'function');const {input,plan}=await fixture(),sessions=createSubjectRoundSessions();
  const [group]=api.studyPracticeGroups(plan,input.catalog,()=> 'recall'),scope=api.practiceGroupScope('owner','library',plan.day,group);
  sessions.activate('vocab',scope,emptySubjectRound());
  const round=advanceSubjectRound({round:emptySubjectRound(),itemKeys:group.itemKeys,currentIndex:0,correct:false,completeAfterAttempt:true}).round;
  sessions.set({vocab:round});assert.deepEqual(sessions.get(scope).reviewedKeys,['word:0']);assert.deepEqual(round.correctKeys,[]);
  const nav=api.practiceGroupNavigation([group],key=>sessions.get(key),'owner','library',plan.day);
  assert.deepEqual(nav.finishedPassTaskIds,['review-0']);
  plan.tasks[1].reviewRoundId='new-round';const changed=api.studyPracticeGroups(plan,input.catalog,()=> 'recall')[0];
  assert.notEqual(api.practiceGroupScope('owner','library',plan.day,changed),scope);
  assert.deepEqual(api.practiceGroupNavigation([changed],key=>sessions.get(key),'owner','library',plan.day).finishedPassTaskIds,[]);
});
test('starting a group locks all members atomically without changing learning evidence',async()=>{
  const input=vocabularyInput(4),plan=await generateTaskPlan(input),first=plan.tasks[0];
  const two={...plan,tasks:[{...first,taskId:'first',quantity:2,action:{kind:'practice',itemKeys:first.action.itemKeys.slice(0,2)}},
    {...first,taskId:'second',quantity:2,action:{kind:'practice',itemKeys:first.action.itemKeys.slice(2)}}]};
  const started=await editTaskPlan(two,{type:'start-group',taskIds:['first','second']},input.catalog);
  assert.deepEqual(started.manual.lockedTaskIds,['first','second']);assert.equal(started.draftVersion,two.draftVersion+1);
  assert.deepEqual(started.tasks,two.tasks);assert.deepEqual(two.manual.lockedTaskIds,[]);
});

test('a correct first vocabulary stage cannot mark the item or its group finished',()=>{
  const first=advanceSubjectRound({round:emptySubjectRound(),itemKeys:['a','b'],currentIndex:0,correct:true,completeItem:false});
  assert.deepEqual(first.round.correctKeys,[]);assert.equal(first.round.resets,0);assert.deepEqual(first.round.wrongKeys,[]);
  const last=advanceSubjectRound({round:first.round,itemKeys:['a','b'],currentIndex:0,correct:true,completeItem:true});
  assert.deepEqual(last.round.correctKeys,['a']);assert.equal(last.complete,false);
});

test('explicit review target selection limits the group while retaining its stable scope',async()=>{
  const {input,plan}=await fixture(),all=api.studyPracticeGroups(plan,input.catalog,()=> 'recall')[0];
  const visible=api.studyPracticeGroups(plan,input.catalog,()=> 'recall',['review-0','review-1'])[0];
  assert.deepEqual(visible.itemKeys,['word:0','word:1']);assert.equal(visible.id,all.id);
});

test('an explicitly expanded review window survives returning and continuing across groups',async()=>{
  const {plan}=await fixture(),reviews=plan.tasks.filter(task=>task.category==='review');
  const expanded=reviewGoalView(reviews,1,1,[],[]).visible.map(task=>task.taskId);
  const resumed=reviewGoalView(reviews,1,0,[],['review-0'],expanded);
  assert.deepEqual(resumed.visible.map(task=>task.taskId),['review-0','review-1']);
});

test('legacy displayed progress keys agree with navigation without rewriting the stored round',async()=>{
  const {input,plan}=await fixture(),groups=api.studyPracticeGroups(plan,input.catalog,()=> 'recall',undefined,key=>key==='word:0'?'legacy:first':key);
  const sessions=createSubjectRoundSessions(),scope=api.practiceGroupScope('owner','library',plan.day,groups[0]);
  const round={...emptySubjectRound(),reviewedKeys:['legacy:first']};sessions.activate('vocab',scope,round);
  assert.deepEqual(api.practiceGroupNavigation(groups,key=>sessions.get(key),'owner','library',plan.day).finishedPassTaskIds,['review-0']);
  assert.deepEqual(round.reviewedKeys,['legacy:first']);assert.deepEqual(round.correctKeys,[]);
});

test('separate review rounds for the same item never share a completion seed or pass',async()=>{
  const {input,plan}=await fixture();plan.tasks=[plan.tasks[0],{...plan.tasks[0],taskId:'fresh-round',reviewRoundId:'fresh-anchor'}];
  const groups=api.studyPracticeGroups(plan,input.catalog,()=> 'recall');assert.equal(groups.length,2);
  const sessions=createSubjectRoundSessions();sessions.activate('vocab',api.practiceGroupScope('owner','library',plan.day,groups[0]),{...emptySubjectRound(),correctKeys:['word:0']});
  assert.deepEqual(api.practiceGroupNavigation(groups,key=>sessions.get(key),'owner','library',plan.day).finishedPassTaskIds,['review-0']);
});
