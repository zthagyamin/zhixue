import assert from 'node:assert/strict';
import test from 'node:test';
import {dashboardDeclaredFunction} from './fixtures/dashboard-functions.mjs';

test('account AI status opens the dedicated settings panel without entering daily-plan editing',()=>{
  const trace=[];
  dashboardDeclaredFunction('openSettingsAi',{settingsUsesAccount:true,accountLoaded:{},accountWorkspaceId:'account:a',setAiEntryOpen:value=>trace.push(['settings',value]),setAccountAiEntryOwner:()=>assert.fail('must not enter planner'),setTab:()=>assert.fail('must retain current page'),setSourceView:()=>assert.fail('must retain current section')})();
  assert.deepEqual(trace,[['settings',true]]);
});
test('local and not-yet-loaded AI status entries use the same dedicated connection-aware panel',()=>{
  for(const state of [{settingsUsesAccount:false,accountLoaded:null},{settingsUsesAccount:true,accountLoaded:null}]){
    const trace=[];
    dashboardDeclaredFunction('openSettingsAi',{...state,accountWorkspaceId:'account:a',setAiEntryOpen:value=>trace.push(value),setAccountAiEntryOwner:()=>assert.fail('must not open unloaded planner'),setTab:()=>assert.fail('must retain current page'),setSourceView:()=>assert.fail('must not silently remain in connections')})();
    assert.deepEqual(trace,[true]);
  }
});

