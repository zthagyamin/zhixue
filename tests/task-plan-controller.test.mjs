import assert from 'node:assert/strict';
import test from 'node:test';
import {generateTaskPlan} from '../app/task-plan-engine.ts';
import {vocabularyInput} from './fixtures/task-plan-input.mjs';
let api;
try {api=await import('../app/task-plan-controller.ts');} catch(error) {if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function fixture(overrides={}) {
  assert.equal(typeof api?.createTaskPlanController,'function');
  const initial={plan:await generateTaskPlan(vocabularyInput(0)),baseRevision:3,dirty:true};
  const snapshots=[],stored=[];
  const controller=api.createTaskPlanController({load:async(_workspace,day)=>({...structuredClone(initial),plan:{...initial.plan,day}}),save:async(workspace,draft)=>stored.push({workspace,draft}),publish:state=>snapshots.push(state),...overrides});
  await controller.open('a','2026-08-31');
  return {controller,initial,snapshots,stored};
}
const response=plan=>({day:plan.day,sourceHash:plan.sourceHash,draftVersion:plan.draftVersion,mode:'fallback',selections:[],message:'fixture'});
const increment=draft=>({...draft,plan:{...draft.plan,draftVersion:draft.plan.draftVersion+1}});
test('draft is shown as recoverable only after persistence completes',async()=>{
  const saving=deferred(),{controller,initial}=await fixture({save:()=>saving.promise});
  const pending=controller.change(increment);
  await Promise.resolve();
  assert.equal(controller.snapshot().draft.plan.draftVersion,initial.plan.draftVersion);
  saving.resolve();assert.equal(await pending,true);
  assert.equal(controller.snapshot().draft.plan.draftVersion,initial.plan.draftVersion+1);
});
test('failed persistence preserves previous recoverable draft and shows an error',async()=>{
  const {controller,initial}=await fixture({save:async()=>{throw new Error('磁盘写入失败');}});
  await assert.rejects(controller.change(increment),/磁盘写入失败/);
  assert.equal(controller.snapshot().draft.plan.draftVersion,initial.plan.draftVersion);
  assert.match(controller.snapshot().error,/磁盘写入失败/);
});
test('a late AI response cannot overwrite a manual edit',async()=>{
  const ai=deferred(),{controller,initial,stored}=await fixture();
  const pending=controller.suggest('standard',()=>ai.promise,increment);
  await controller.change(increment);
  ai.resolve(response(initial.plan));
  assert.equal(await pending,false);assert.equal(stored.length,1);
});
test('new practice evidence invalidates AI without fabricating a plan edit',async()=>{
  const ai=deferred(),{controller,initial,stored}=await fixture();
  assert.equal(typeof controller.invalidateEvidence,'function');
  const pending=controller.suggest('standard',()=>ai.promise,increment);
  controller.invalidateEvidence();ai.resolve(response(initial.plan));
  assert.equal(await pending,false);assert.equal(stored.length,0);
});
test('evidence invalidation also guards asynchronous suggestion application after the response arrived',async()=>{
  const entered=deferred(),resume=deferred(),{controller,initial,stored}=await fixture();
  const pending=controller.suggest('standard',async()=>response(initial.plan),async draft=>{entered.resolve();await resume.promise;return increment(draft);});
  await entered.promise;controller.invalidateEvidence();resume.resolve();
  assert.equal(await pending,false);assert.equal(stored.length,0);
});
test('AI response is rejected after workspace, day or source changes',async()=>{
  for(const transition of ['workspace','day','source']) {
    const ai=deferred(),{controller,initial}=await fixture();
    const pending=controller.suggest('standard',()=>ai.promise,increment);
    if(transition==='source') await controller.change(draft=>({...increment(draft),plan:{...draft.plan,sourceHash:'c'.repeat(64)}}));
    else await controller.open(transition==='workspace'?'b':'a',transition==='day'?'2026-09-01':'2026-08-31');
    ai.resolve(response(initial.plan));assert.equal(await pending,false);
  }
});
test('late draft reads never publish into a switched workspace',async()=>{
  const oldRead=deferred(),{controller}=await fixture({load:async(workspace)=>workspace==='slow'?oldRead.promise:null});
  const pending=controller.open('slow','2026-08-31');await controller.open('b','2026-08-31');
  oldRead.resolve({plan:await generateTaskPlan(vocabularyInput(0)),baseRevision:4,dirty:true});
  await pending;assert.equal(controller.snapshot().workspaceId,'b');assert.equal(controller.snapshot().draft,null);
});
test('late saves remain bound to their originating workspace',async()=>{
  const saving=deferred(),{controller,stored}=await fixture({save:async(workspace,draft)=>{stored.push({workspace,draft});await saving.promise;}});
  const pending=controller.change(increment);
  await new Promise(resolve=>setImmediate(resolve));
  await controller.open('b','2026-08-31');
  saving.resolve();assert.equal(await pending,false);
  assert.equal(stored[0].workspace,'a');assert.equal(controller.snapshot().workspaceId,'b');
  assert.equal(controller.snapshot().draft.plan.draftVersion,1);
});
test('a draft cannot be written while an older load is still pending',async()=>{
  const loading=deferred(),{controller,initial}=await fixture({load:async(workspace)=>workspace==='slow'?loading.promise:null});
  const pending=controller.open('slow','2026-08-31');
  await assert.rejects(controller.change(()=>initial),/loading/);
  loading.resolve(null);await pending;
});
test('current AI response is applied once, with serialized local persistence',async()=>{
  const {controller,stored}=await fixture();
  const initialVersion=controller.snapshot().draft.plan.draftVersion;
  assert.equal(await controller.suggest('standard',async request=>response(request),increment),true);
  assert.equal(stored.length,1);assert.equal(controller.snapshot().draft.plan.draftVersion,initialVersion+1);
});
test('an AI response queued behind an unfinished manual save is ignored without an error',async()=>{
  const saving=deferred(),{controller,initial}=await fixture({save:()=>saving.promise});
  const manual=controller.change(increment);
  await new Promise(resolve=>setImmediate(resolve));
  const pending=controller.suggest('standard',async()=>response(initial.plan),increment);
  await new Promise(resolve=>setImmediate(resolve));
  saving.resolve();await manual;
  assert.equal(await pending,false);
  assert.equal(controller.snapshot().error,null);
  assert.equal(controller.snapshot().draft.plan.draftVersion,initial.plan.draftVersion+1);
});
