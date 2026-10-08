import assert from 'node:assert/strict';
import test from 'node:test';
import {createTaskPlanController} from '../src/application/planning/index.ts';
import {generateTaskPlan,editTaskPlan} from '../src/domain/planning/index.ts';
import {vocabularyInput} from './fixtures/task-plan-input.mjs';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture(save){
 const input=vocabularyInput(2),plan=await generateTaskPlan(input),stored=[];
 const controller=createTaskPlanController({load:async()=>({plan,baseRevision:0,dirty:false}),save:async(_scope,draft)=>{await save?.();stored.push(structuredClone(draft));},publish(){}});
 await controller.open('m3-synthetic',input.day);return {controller,stored,input,plan};
}
test('navigation cancelled during source preparation cannot persist a started group',async()=>{
 const f=await fixture(),gate=deferred(),entered=deferred();let current=true;
 const pending=f.controller.change(async draft=>{entered.resolve();await gate.promise;return {...draft,dirty:true,plan:await editTaskPlan(draft.plan,{type:'start-group',taskIds:[draft.plan.tasks[0].taskId]},f.input.catalog,{words:f.input.words,reviews:f.input.reviews})};},()=>current);
 await entered.promise;current=false;gate.resolve();assert.equal(await pending,false);
 assert.equal(f.stored.length,0);assert.deepEqual(f.controller.snapshot().draft.plan.manual.lockedTaskIds,[]);
});
test('a queued start checks navigation again before invoking its update',async()=>{
 const gate=deferred(),entered=deferred(),f=await fixture(async()=>{entered.resolve();await gate.promise;});let current=true,prepared=0;
 const prior=f.controller.change(draft=>draft);await entered.promise;
 const cancelled=f.controller.change(draft=>{prepared++;return draft;},()=>current);current=false;gate.resolve();
 assert.equal(await prior,true);assert.equal(await cancelled,false);assert.equal(prepared,0);assert.equal(f.stored.length,1);
});
