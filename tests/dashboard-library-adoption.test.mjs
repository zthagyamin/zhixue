import assert from 'node:assert/strict';
import test from 'node:test';
import {dashboardDeclaredFunction} from './fixtures/dashboard-functions.mjs';
function fixture(){
  let finish,clears=0,reads=0;const waiting=new Promise(resolve=>{finish=resolve;});
  const env={learningDrafts:{isPending:()=>false,clear:()=>clears++},window:{confirm:()=>true},cancelAccountRead(){},accountModeEpoch:{current:0},taskWorkspaceRef:{current:'account:a'},workspaceId:'account:a',
    accountClient:{prepareLibraryAdoption:()=>waiting},accountLoadedRef:{current:{}},accountPendingLoadedRef:{current:null},pendingLocalSourceRef:{current:null},
    setLocalSourcePending(){},setAccountLoaded(){},setData(){},fallbackData:{},setActiveTaskScope(){},setPracticeItems(){},setPracticeSummary(){},readAccountAgain:async()=>{reads++;}};
  return{env,finish,run:()=>dashboardDeclaredFunction('acceptCurrentAccountLibrary',env)(),counts:()=>({clears,reads})};
}
test('library adoption cannot reverse a newer explicit mode selection',async()=>{
  const f=fixture(),pending=f.run();f.env.accountModeEpoch.current++;f.finish();await pending;assert.deepEqual(f.counts(),{clears:0,reads:0});
});
test('library adoption cannot clear a newly selected owner workspace',async()=>{
  const f=fixture(),pending=f.run();f.env.taskWorkspaceRef.current='account:b';f.finish();await pending;assert.deepEqual(f.counts(),{clears:0,reads:0});
});
test('an unchanged adoption still proceeds to the current library',async()=>{
  const f=fixture(),pending=f.run();f.finish();await pending;assert.deepEqual(f.counts(),{clears:1,reads:1});
});
