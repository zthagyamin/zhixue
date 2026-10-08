import assert from 'node:assert/strict';
import test,{beforeEach} from 'node:test';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {readFile} from 'node:fs/promises';
import {loadWorkspaceRecord,exportRecoveryWorkspaceRecords,clearAccountWorkspaceRecords} from '../app/local-study-db.ts';
import {rebalanceScheduleOnDelta} from '../app/long-term-pacing.ts';
let api;
try {api=await import('../app/local-long-term-plan.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const fixture=JSON.parse(await readFile(new URL('./fixtures/long-term-plan.json',import.meta.url),'utf8'));
beforeEach(()=>{globalThis.indexedDB=new IDBFactory();});
function snapshot(){return structuredClone(fixture.snapshot??fixture);}
function request(overrides={}){return{operationId:'save-1',expectedRevision:0,enabled:true,snapshot:snapshot(),...overrides};}
async function save(workspaceId,value,libraryId='library-a'){assert.equal(typeof api?.saveLongTermPlanState,'function','Durable long-term plan store must exist');return api.saveLongTermPlanState({workspaceId,libraryId},value);}
async function load(workspaceId,libraryId='library-a'){assert.equal(typeof api?.loadLongTermPlanState,'function');return api.loadLongTermPlanState({workspaceId,libraryId});}

test('long-term goal survives durable reload and remains isolated by workspace',async()=>{
  const saved=await save('local-library-a',request());
  assert.equal(saved.status,'accepted');assert.equal(saved.state.revision,1);
  assert.deepEqual((await load('local-library-a')).snapshot,snapshot());
  assert.deepEqual(await load('other-library'),{revision:0,enabled:false,snapshot:null,lastOperationId:null});
});
test('two simultaneous edits cannot both replace the same long-term revision',async()=>{
  const results=await Promise.all([save('a',request()),save('a',request({operationId:'save-2',enabled:false}))]);
  assert.deepEqual(results.map(result=>result.status).sort(),['accepted','stale']);
  assert.equal((await load('a')).revision,1);
});
test('lost-response retry is idempotent and reused operation IDs reject different content',async()=>{
  await save('a',request());
  assert.equal((await save('a',request())).status,'duplicate');
  await assert.rejects(save('a',request({enabled:false})),/long-term-operation-conflict/);
  assert.equal((await load('a')).revision,1);
});
test('disabling long-term mode preserves the saved goal and history for later resume',async()=>{
  await save('a',request());
  const result=await save('a',request({operationId:'disable',expectedRevision:1,enabled:false}));
  assert.equal(result.state.enabled,false);assert.deepEqual(result.state.snapshot,snapshot());
  assert.equal((await load('a')).revision,2);
});
test('invalid revision or snapshot never overwrites a saved long-term goal',async()=>{
  await save('a',request());
  await assert.rejects(save('a',request({operationId:'bad',expectedRevision:-1})),/invalid-long-term/);
  await assert.rejects(save('a',request({operationId:'bad',expectedRevision:1,snapshot:{schemaVersion:99}})),/invalid-long-term/);
  assert.equal((await load('a')).revision,1);
});
test('transaction abort is a persistence failure even when the put request succeeds',async()=>{
  const original=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(...args){const result=original.apply(this,args);result.addEventListener('success',()=>this.transaction.abort());return result;};
  try{await assert.rejects(save('a',request()));}finally{IDBObjectStore.prototype.put=original;}
  assert.equal((await load('a')).revision,0);
});
test('missing browser database cannot masquerade as a saved or empty goal',async()=>{
  globalThis.indexedDB=undefined;
  await assert.rejects(save('a',request()),/数据库/);
  await assert.rejects(load('a'),/数据库/);
});
test('starting another goal retains the previous goal snapshot in the recovery record',async()=>{
  await save('a',request());const next=snapshot();next.spec.planId='second-goal';
  await save('a',request({operationId:'next',expectedRevision:1,snapshot:next}));
  const stored=await loadWorkspaceRecord('a','long-term-plan',null);
  assert.deepEqual(stored.libraries['library-a'].archivedPlans[snapshot().spec.planId],snapshot());
});
test('fractional forecast parameters roundtrip and reordered object keys retain retry identity',async()=>{
  const first=request();first.snapshot.spec.dailyMinutesBudget.minReviewRatio=0.35;
  await save('a',first);
  const reordered=structuredClone(first);
  reordered.snapshot.spec=Object.fromEntries(Object.entries(reordered.snapshot.spec).reverse());
  assert.equal((await save('a',reordered)).status,'duplicate');
  assert.equal((await load('a')).snapshot.spec.dailyMinutesBudget.minReviewRatio,0.35);
});
test('elapsed slots remain immutable across later goal saves',async()=>{
  const initial=snapshot();await save('a',request());
  const next=rebalanceScheduleOnDelta(initial,initial.inventory,[],{},
    {asOfDate:'2026-09-08',generatedAt:'2026-09-08T00:00:00.000Z',maxProposalExtensionDays:0,maxProposalExtraMinutes:0});
  await save('a',request({operationId:'later',expectedRevision:1,snapshot:next}));
  const altered=structuredClone(next);altered.schedule[0].warnings.push('rewritten');
  await assert.rejects(save('a',request({operationId:'rewrite',expectedRevision:2,snapshot:altered})),/long-term-frozen-history-changed/);
  assert.deepEqual((await load('a')).snapshot.schedule[0],initial.schedule[0]);
});
test('recovery export includes long-term goals and clearing read caches preserves them',async()=>{
  await save('account:owner:library',request());
  const exported=await exportRecoveryWorkspaceRecords('account:owner:library');
  assert.equal(exported.find(row=>row.kind==='long-term-plan')?.value.libraries['library-a'].state.revision,1);
  await clearAccountWorkspaceRecords('account:owner:library');
  assert.equal((await load('account:owner:library')).revision,1);
});
test('the same account stores each library independently without losing concurrent saves',async()=>{
  await Promise.all([save('account:same',request(),'library-a'),save('account:same',request({enabled:false}),'library-b')]);
  assert.equal((await load('account:same','library-a')).enabled,true);
  assert.equal((await load('account:same','library-b')).enabled,false);
  assert.equal((await load('account:same','library-c')).revision,0);
});

test('optional shared budget persists through existing revision save and reload without changing old schedules',async()=>{
 const first=request(),groups=[{id:'g',title:'Shared',subjectIds:['paper-a','paper-b'],minutes:15,defaultItemMinutes:3}];
 first.snapshot.spec.practiceBudgetGroups=groups;await save('budget-fixture',first);
 const stored=await load('budget-fixture');assert.deepEqual(stored.snapshot.spec.practiceBudgetGroups,groups);
 assert.deepEqual(stored.snapshot.schedule,snapshot().schedule);
 const next=structuredClone(first);next.operationId='budget-edit';next.expectedRevision=1;next.snapshot.spec.practiceBudgetGroups[0].minutes=0;
 assert.equal((await save('budget-fixture',next)).status,'accepted');assert.equal((await load('budget-fixture')).snapshot.spec.practiceBudgetGroups[0].minutes,0);
 assert.equal((await save('budget-fixture',{...first,operationId:'stale-budget'})).status,'stale');
});
