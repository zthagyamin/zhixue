import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {createTaskPlanningSession} from '../app/task-planning-session.ts';
import {loadTaskDraft,saveTaskDraft,archiveTaskDraft} from '../app/local-task-plan.ts';
import {putTaskEvent,listTaskEvents} from '../app/local-task-events.ts';
import {vocabularyInput,courseSubject} from './fixtures/task-plan-input.mjs';
import {attempt,DAY} from './fixtures/task-event-fixtures.mjs';

test('complete learning facts survive regeneration, authority save and a second independent draft store',async()=>{
  globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
  const catalog=vocabularyInput(40).catalog,course=courseSubject(3);catalog.subjects.push(course);
  const events=[],remoteReports=[];let revision=0,candidate=null;
  const make=workspace=>createTaskPlanningSession({loadDraft:loadTaskDraft,saveDraft:saveTaskDraft,archiveDraft:archiveTaskDraft,
    now:()=>new Date('2026-08-31T06:00:00Z'),publish:()=>{},putTaskEvent:async(id,event)=>{await putTaskEvent(id,event);remoteReports.push(event);},
    loadBundle:async()=>({context:{catalog,sourceReviews:[],captureReviews:[],observedAt:'2026-08-31T05:00:00Z',planRevision:revision,capabilities:['task-planning-v1']},
      localEvents:events,companionRecords:[],taskEvents:[...await listTaskEvents(workspace),...remoteReports],legacyItemKeys:[],
      history:{local:'complete',cloud:'not-applicable',companion:'complete',tasks:'complete'},authority:{revision,candidate,history:[]}}),
    client:{suggestPlan:async input=>({...input,mode:'fallback',selections:[],message:'AI 未配置；规则任务保留。'}),
      applyTaskPlan:async(plan,expected)=>{assert.equal(expected,revision);candidate=structuredClone(plan);revision++;return {status:'ok',revision:{revision,after:candidate}};}}});
  const first=make('client-one');await first.open('client-one',DAY);await first.generate();
  const assigned=first.snapshot().draft.plan.vocabulary.assignedLexemeKeys;
  const keys=first.snapshot().draft.plan.tasks.find(task=>task.category==='new-word').action.itemKeys.slice(0,7);
  for(const [index,key] of keys.entries()) for(let stage=0;stage<3;stage++) events.push(await attempt(`loop-${index}-${stage}`,
    new Date(Date.parse('2026-08-31T01:00:00Z')+index*60000+stage*1000).toISOString(),stage,stage+1,true,{item:{kind:'word',key}}));
  await first.refresh();assert.equal(first.snapshot().summary.newDone,7);
  const manual={taskId:'manual:keep',subjectId:'course',title:'My manual notes',category:'subject',origin:'manual',required:false,
    unitIds:[],quantity:2,action:{kind:'manual'},completionRule:'self-report',sourceHash:catalog.sourceHash};
  await first.edit({type:'upsert',task:manual});await first.complete(manual.taskId);await first.generate();
  assert.equal(first.snapshot().summary.newTarget-first.snapshot().summary.newDone,13);
  assert.deepEqual(first.snapshot().draft.plan.vocabulary.assignedLexemeKeys,assigned);
  assert.equal(first.snapshot().draft.plan.tasks.find(task=>task.taskId===manual.taskId).quantity,2);
  assert.ok(first.snapshot().completedTaskIds.includes(manual.taskId));
  await first.save();assert.equal(first.snapshot().draft.dirty,false);
  assert.equal(await loadTaskDraft('client-two',DAY),null);
  const second=make('client-two');await second.open('client-two',DAY);
  assert.deepEqual(second.snapshot().draft.plan,candidate);
  assert.equal(second.snapshot().summary.newDone,7);assert.ok(second.snapshot().completedTaskIds.includes(manual.taskId));
  assert.ok(course.units.every(unit=>unit.formalComplete===false));
  assert.equal((await listTaskEvents('client-one')).length,1);
});
