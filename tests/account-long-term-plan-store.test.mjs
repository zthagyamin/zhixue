import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {openD1} from './helpers/sqlite-d1.mjs';
let Store;
try{({AccountLongTermPlanStore:Store}=await import('../db/account-long-term-plan-store.ts'));}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const fixture=JSON.parse(await readFile(new URL('./fixtures/long-term-plan.json',import.meta.url),'utf8')).snapshot;
const mutation=(overrides={})=>({operationId:'save-1',expectedRevision:0,enabled:true,snapshot:structuredClone(fixture),...overrides});
async function setup(t){
  assert.equal(typeof Store,'function','Account long-term plan store must exist');
  const {sqlite,binding}=await openD1();t.after(()=>sqlite.close());
  for(const user of ['user-a','user-b']){await binding.prepare('INSERT INTO learning_accounts(user_id) VALUES(?)').bind(user).run();
    for(const library of ['library-a','library-b'])await binding.prepare('INSERT INTO account_study_libraries(user_id,library_id) VALUES(?,?)').bind(user,library).run();}
  return{sqlite,binding,store:new Store(binding),scope:{userId:'user-a',libraryId:'library-a'}};
}
test('account long-term goals persist fractional snapshots under owner and library scope',async t=>{
  const {store,scope}=await setup(t);const result=await store.mutate(scope,mutation());
  assert.equal(result.status,'accepted');assert.equal(result.state.revision,1);
  assert.deepEqual((await store.getState(scope)).snapshot,fixture);
  assert.equal((await store.getState({...scope,userId:'user-b'})).revision,0);
  assert.equal((await store.getState({...scope,libraryId:'library-b'})).revision,0);
});
test('only one simultaneous writer wins a long-term revision',async t=>{
  const {store,scope}=await setup(t);
  const results=await Promise.all([store.mutate(scope,mutation()),store.mutate(scope,mutation({operationId:'save-2',enabled:false}))]);
  assert.deepEqual(results.map(row=>row.status).sort(),['accepted','stale']);assert.equal((await store.getState(scope)).revision,1);
});
test('account lost-response retries are idempotent and operation IDs cannot change meaning',async t=>{
  const {store,scope}=await setup(t);await store.mutate(scope,mutation());
  assert.equal((await store.mutate(scope,mutation())).status,'duplicate');
  await assert.rejects(store.mutate(scope,mutation({enabled:false})),/long-term-operation-conflict/);
  assert.equal((await store.getState(scope)).revision,1);
});
test('failed operation append rolls back the state update',async t=>{
  const {store,scope,sqlite}=await setup(t);
  sqlite.exec("CREATE TRIGGER fail_long_term_operation BEFORE INSERT ON account_long_term_plan_operations BEGIN SELECT RAISE(ABORT,'test-write-failed'); END");
  await assert.rejects(store.mutate(scope,mutation()),/test-write-failed/);
  assert.equal((await store.getState(scope)).revision,0);
});
test('older account edits cannot replace an unseen newer goal',async t=>{
  const {store,scope}=await setup(t);await store.mutate(scope,mutation());
  const result=await store.mutate(scope,mutation({operationId:'stale',enabled:false}));
  assert.equal(result.status,'stale');assert.equal(result.state.enabled,true);
});
test('each operation retains before and after snapshots for recovery',async t=>{
  const {store,scope,sqlite}=await setup(t);await store.mutate(scope,mutation());
  const next=structuredClone(fixture);next.spec.planId='new-goal';
  await store.mutate(scope,mutation({operationId:'new-goal',expectedRevision:1,snapshot:next}));
  const row=sqlite.prepare('SELECT before_json,after_json FROM account_long_term_plan_operations WHERE operation_id=?').get('new-goal');
  assert.deepEqual(JSON.parse(row.before_json).snapshot,fixture);assert.deepEqual(JSON.parse(row.after_json).snapshot,next);
});
test('unregistered libraries cannot receive new persistent goals',async t=>{
  const {store,scope}=await setup(t);
  await assert.rejects(store.mutate({...scope,libraryId:'unregistered'},mutation()));
  assert.equal((await store.getState(scope)).revision,0);
});
test('concurrent identical retries report one accepted operation and one duplicate',async t=>{
  const {binding,scope}=await setup(t);let arrivals=0,release;
  const both=new Promise(resolve=>{release=resolve;});
  const store=new Store({prepare:query=>binding.prepare(query),batch:async statements=>{
    if(++arrivals===2)release();await both;return binding.batch(statements);
  }});
  const results=await Promise.all([store.mutate(scope,mutation()),store.mutate(scope,mutation())]);
  assert.deepEqual(results.map(row=>row.status).sort(),['accepted','duplicate']);
  assert.equal((await store.getState(scope)).revision,1);
});
