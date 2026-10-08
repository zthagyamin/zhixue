import assert from 'node:assert/strict';
import test from 'node:test';
import {dashboardFunction,dashboardDeclaredFunction,dashboardClick,dashboardJsxProp} from './fixtures/dashboard-functions.mjs';
function fixture(){
  let updates=0,epochs=0;const env={taskWorkspaceRef:{current:'account:a'},accountLoadedRef:{current:null},accountIntentRef:{current:false},accountAttemptActiveRef:{current:true},pendingLocalSourceRef:{current:null},
    taskStudyDataRef:{current:{}},setLocalSourcePending(){},setData(){updates++;},setStudySourceEpoch(){epochs++;},scopeStudyPayload:value=>value};
  return{env,apply:()=>dashboardFunction('applyLocalStudySource',env),updates:()=>updates,epochs:()=>epochs};
}
test('local source refresh defers complete data during an active practice and applies it after exit',()=>{
  const f=fixture(),payload={subjects:[{id:'words',items:[{word:'new source'}]}]},apply=f.apply();
  assert.equal(apply(payload,'account:a'),false);assert.equal(f.updates(),0);assert.deepEqual(f.env.pendingLocalSourceRef.current,{workspaceId:'account:a',payload});
  f.env.accountAttemptActiveRef.current=false;assert.equal(apply(payload,'account:a'),true);assert.equal(f.updates(),1);assert.equal(f.env.pendingLocalSourceRef.current,null);
});
test('late local data cannot replace a different workspace or an active account source',()=>{
  const f=fixture(),apply=f.apply();assert.equal(apply({},'account:b'),false);assert.equal(f.env.pendingLocalSourceRef.current,null);
  f.env.accountLoadedRef.current={bundle:{}};assert.equal(apply({},'account:a'),false);assert.equal(f.updates(),0);
});
test('waiting for an explicitly selected account library does not silently fall back to local data',()=>{
  const f=fixture();f.env.accountIntentRef.current=true;assert.equal(f.apply()({},'account:a'),false);assert.equal(f.env.pendingLocalSourceRef.current,null);
});
test('the actual Companion poll routes its payload through the active-view guard',async()=>{
  const f=fixture(),payload={status:'connected',subjects:[{id:'words',items:[]}]};const env={...f.env,active:true,companionUrl:'http://127.0.0.1:1',companionHeaders:{},workspaceId:'account:a',
    fetch:async()=>Response.json(payload),setCompanionDetected(){},setSyncState(){},setCompanionSession(){},setPairingMessage(){},flushPendingActivities:async()=>{},applyLocalStudySource:f.apply()};
  await dashboardDeclaredFunction('fetchStudyData',env)();assert.equal(f.updates(),0);assert.equal(f.env.pendingLocalSourceRef.current.payload.subjects[0].id,'words');
});
test('applying a planning read does not trigger its own source-epoch reload loop',()=>{
  const f=fixture();f.env.accountAttemptActiveRef.current=false;assert.equal(f.apply()({},'account:a',false),true);assert.equal(f.updates(),1);assert.equal(f.epochs(),0);
});
test('a late dashboard receipt preserves a newer deferred question payload',()=>{
  const f=fixture(),old={subjects:[{id:'old'}]},fresh={subjects:[{id:'new'}]};f.env.taskStudyDataRef={current:old};f.env.pendingLocalSourceRef.current={workspaceId:'account:a',payload:fresh};f.env.applyLocalStudySource=f.apply();
  dashboardFunction('applyLocalDashboard',f.env)({priorities:['updated']},'account:a');
  assert.equal(f.updates(),0);assert.equal(f.env.pendingLocalSourceRef.current.payload.subjects[0].id,'new');assert.deepEqual(f.env.pendingLocalSourceRef.current.payload.dashboard.priorities,['updated']);
});
test('a receipt before React commits preserves the just-accepted source',()=>{
  const f=fixture();f.env.accountAttemptActiveRef.current=false;f.env.taskStudyDataRef.current={subjects:[{id:'old'}]};
  const writes=[];f.env.setData=value=>writes.push(value);f.env.applyLocalStudySource=f.apply();
  f.env.applyLocalStudySource({subjects:[{id:'new'}]},'account:a');
  dashboardFunction('applyLocalDashboard',f.env)({priorities:['receipt']},'account:a');
  assert.equal(writes.at(-1).subjects[0].id,'new');assert.deepEqual(writes.at(-1).dashboard.priorities,['receipt']);
});
test('the learning options Today button uses the source-draining navigation path',()=>{
  const destinations=[];dashboardClick('aria-pressed={Boolean(modulePlan)}',{setTab:()=>assert.fail('must drain sources'),navigateToStudyTab:value=>destinations.push(value)})();
  assert.deepEqual(destinations,['today']);
});
test('finishing the legacy inline practice consumes a deferred local source',()=>{
  let rereads=0;const f=fixture();f.env.pendingLocalSourceRef.current={workspaceId:'account:a',payload:{subjects:[{id:'new'}]}};
  const env={...f.env,workspaceId:'account:a',accountPendingLoadedRef:{current:null},setPracticeItems(){},setPracticeSummary(){},applyLocalStudySource:f.apply(),noteEventsChanged(){rereads++;}};
  dashboardJsxProp('PracticeSession','onFinish',env)({completed:1});assert.equal(f.updates(),1);assert.equal(f.env.pendingLocalSourceRef.current,null);assert.equal(rereads,1);
});
