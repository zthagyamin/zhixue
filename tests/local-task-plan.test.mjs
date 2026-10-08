import assert from 'node:assert/strict';
import test,{beforeEach} from 'node:test';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {generateTaskPlan} from '../app/task-plan-engine.ts';
import {vocabularyInput} from './fixtures/task-plan-input.mjs';
let api;
try {api=await import('../app/local-task-plan.ts');} catch(error) {if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;}
beforeEach(()=>{globalThis.indexedDB=new IDBFactory();});
async function draft(day='2026-08-31') {return {plan:await generateTaskPlan({...vocabularyInput(0),day}),baseRevision:3,dirty:true};}
async function save(workspace,value) {assert.equal(typeof api?.saveTaskDraft,'function');return api.saveTaskDraft(workspace,value);}
async function load(workspace,day) {assert.equal(typeof api?.loadTaskDraft,'function');return api.loadTaskDraft(workspace,day);}
test('task drafts preserve day and workspace isolation across reload',async()=>{
  const first=await draft(),second=await draft('2026-09-01');
  first.plan.manual.excludedUnitIds=['subject:excluded'];
  await save('a',first);await save('a',second);await save('b',{...first,baseRevision:9,dirty:false});
  assert.equal((await load('a','2026-08-31')).baseRevision,3);
  assert.deepEqual((await load('a','2026-08-31')).plan.manual.excludedUnitIds,['subject:excluded']);
  assert.equal((await load('b','2026-08-31')).dirty,false);
  assert.equal((await load('a','2026-09-01')).plan.day,'2026-09-01');
  assert.equal(await load('b','2026-09-01'),null);
});
test('simultaneous writes to different days cannot lose one day',async()=>{
  const first=await draft(),second=await draft('2026-09-01');
  await Promise.all([save('a',first),save('a',second)]);
  assert.ok(await load('a','2026-08-31'));assert.ok(await load('a','2026-09-01'));
});
test('invalid draft metadata never overwrites a saved draft',async()=>{
  const original=await draft();await save('a',original);
  for(const change of [{baseRevision:-1},{dirty:'yes'},{plan:{...original.plan,tasks:'bad'}}]) {
    await assert.rejects(save('a',{...original,...change}));
  }
  assert.deepEqual(await load('a','2026-08-31'),original);
});
test('unavailable IndexedDB is a real persistence failure',async()=>{
  globalThis.indexedDB=undefined;
  await assert.rejects(save('a',await draft()),/本地|database|indexed/i);
});
test('an aborted transaction is not reported as saved after its put succeeds',async()=>{
  const original=await draft();await save('a',original);
  const put=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args) {
    const request=put.apply(this,args),transaction=this.transaction;
    request.addEventListener('success',()=>transaction.abort(),{once:true});
    return request;
  };
  try {await assert.rejects(save('a',{...original,baseRevision:4}),/取消|abort/i);}
  finally {IDBObjectStore.prototype.put=put;}
  assert.equal((await load('a','2026-08-31')).baseRevision,3);
});
test('stale same-day writes cannot replace a newer saved revision',async()=>{
  const original=await draft();await save('a',original);
  const newer={...original,plan:{...original.plan,draftVersion:5,planHash:'b'.repeat(64)}};
  await save('a',newer);
  await assert.rejects(save('a',original),/stale/);
  await assert.rejects(save('a',{...newer,plan:{...newer.plan,planHash:'c'.repeat(64)}}),/conflict/);
  assert.equal((await load('a','2026-08-31')).plan.draftVersion,5);
});
test('a higher authority revision cannot overwrite an unseen newer local edit',async()=>{
  const original=await draft();await save('a',original);
  const edited={...original,plan:{...original.plan,draftVersion:5,planHash:'b'.repeat(64)}};await save('a',edited);
  await assert.rejects(api.saveTaskDraft('a',{...original,baseRevision:4,dirty:false},original),/stale-task-draft/);
  assert.deepEqual(await load('a',original.plan.day),edited);
});
test('conflict backups remain recoverable and isolated from other workspaces',async()=>{
  assert.equal(typeof api.archiveTaskDraft,'function');const original=await draft();
  await api.archiveTaskDraft('a',original);await api.archiveTaskDraft('a',original);
  assert.deepEqual((await api.loadTaskDraftBackups('a',original.plan.day)).map(entry=>entry.draft),[original]);
  assert.deepEqual(await api.loadTaskDraftBackups('b',original.plan.day),[]);
});
