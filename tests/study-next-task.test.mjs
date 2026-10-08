import assert from 'node:assert/strict';
import test from 'node:test';
import * as model from '../app/study-view-model.ts';
import * as projection from '../app/account-study-planning-projection.ts';
import {createAccountPreview} from './fixtures/account-preview.mjs';
import {createAccountStudyClient} from '../app/account-study-client.ts';
import {recordBody} from './fixtures/account-study-fixtures.mjs';
import {attempt} from './fixtures/task-event-fixtures.mjs';
import {sealStudyRecord} from '../app/account-study-record.ts';
const tasks=[{taskId:'one',title:'词组一',action:{kind:'practice'}},{taskId:'two',title:'阅读',action:{kind:'practice'}}];
test('next task remains unknown until ready and preserves plan order without fabricated resume',()=>{
  assert.equal(typeof model.selectStudyTask,'function');
  assert.equal(model.selectStudyTask({ready:false,tasks,completedTaskIds:[],startedTaskIds:[]}),null);
  assert.deepEqual(model.selectStudyTask({ready:true,tasks,completedTaskIds:[],startedTaskIds:[]}),{taskId:'one',title:'词组一',kind:'next'});
  assert.equal(model.selectStudyTask({ready:true,tasks,completedTaskIds:['one','two'],startedTaskIds:[]}),null);
});
test('continue requires known activity on an unfinished executable task',()=>{
  assert.equal(typeof model.selectStudyTask,'function');
  assert.deepEqual(model.selectStudyTask({ready:true,tasks,completedTaskIds:[],startedTaskIds:['two']}),{taskId:'two',title:'阅读',kind:'continue'});
  assert.equal(model.selectStudyTask({ready:true,tasks:[{...tasks[0],blockedReason:'资料不符'}],completedTaskIds:[],startedTaskIds:['one']}),null);
});
test('account resume derives from validated attempts and picks an unfinished word rather than completed first word',async t=>{
  assert.equal(typeof projection.accountTaskActivity,'function');
  const origin='http://127.0.0.1:3004',f=await createAccountPreview({origin});t.after(()=>f.close());
  const client=createAccountStudyClient({companionUrl:'http://127.0.0.1:43224',fetcher:(url,init)=>{const headers=new Headers(init?.headers);headers.set('Origin',origin);return f.handle(new Request(new URL(url,origin),{...init,headers}));}});
  let loaded=await client.load();const state=await client.getPlanState(f.day),item=loaded.bundle.items[0];let parent=null;
  for(let stage=0;stage<3;stage++){
    const event=await attempt(`resume-${stage}`,new Date().toISOString(),stage,stage+1,true,{item:{kind:'word',key:item.itemKey}});
    const record=await sealStudyRecord(await recordBody({contentHash:item.contentHash,roundId:'resume-round',attemptId:`resume-attempt-${stage}`,parentEventId:parent,event}));
    const response=await client.appendRecords([record]);assert.equal(response.results[0].durable,true);parent=event.eventId;
  }
  loaded=await client.load();const activity=await projection.accountTaskActivity(state.approvedPlan,loaded.catalog,loaded.bundles,loaded.records),task=state.approvedPlan.tasks.find(task=>task.category==='new-word');
  assert.deepEqual(activity.completedTaskIds,[]);assert.deepEqual(activity.startedTaskIds,[task.taskId]);
  assert.equal(activity.pendingItemByTask[task.taskId],task.action.itemKeys[1]);
});

test('durable local attempts update only the visible next task without inventing a remote sequence',async t=>{
  const origin='http://127.0.0.1:3004',f=await createAccountPreview({origin});t.after(()=>f.close());
  const client=createAccountStudyClient({companionUrl:'http://127.0.0.1:43224',fetcher:(url,init)=>{const headers=new Headers(init?.headers);headers.set('Origin',origin);return f.handle(new Request(new URL(url,origin),{...init,headers}));}});
  const loaded=await client.load(),state=await client.getPlanState(f.day),item=loaded.bundle.items[0],local=[];let parent=null;
  for(let stage=0;stage<3;stage++){
    const event=await attempt(`local-resume-${stage}`,new Date().toISOString(),stage,stage+1,true,{item:{kind:'word',key:item.itemKey}});
    local.push(await sealStudyRecord(await recordBody({contentHash:item.contentHash,roundId:'local-round',attemptId:`local-attempt-${stage}`,parentEventId:parent,event})));parent=event.eventId;
  }
  const before=structuredClone(loaded.records),task=state.approvedPlan.tasks.find(task=>task.category==='new-word');
  const activity=await projection.accountTaskActivity(state.approvedPlan,loaded.catalog,loaded.bundles,loaded.records,local);
  assert.deepEqual(activity.startedTaskIds,[task.taskId]);assert.equal(activity.pendingItemByTask[task.taskId],task.action.itemKeys[1]);assert.deepEqual(loaded.records,before);assert.equal(loaded.eventThrough,0);
  const copies=await projection.accountTaskActivity(state.approvedPlan,loaded.catalog,loaded.bundles,local.map((record,i)=>({sequence:i+1,record})),local);assert.deepEqual(copies,activity);
});
