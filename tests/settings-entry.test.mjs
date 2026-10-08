import assert from 'node:assert/strict';
import test from 'node:test';
import {dashboardDeclaredFunction,dashboardJsxProp,dashboardClick} from './fixtures/dashboard-functions.mjs';

test('account AI overview opens the account editor instead of local Companion settings',()=>{
  const trace=[];
  const env={settingsUsesAccount:true,accountLoaded:{},accountWorkspaceId:'account:a',setAccountAiEntryOwner:v=>trace.push(['owner',v]),setTab:v=>trace.push(['tab',v]),setSourceView:v=>trace.push(['source',v])};
  dashboardClick('智能辅助服务',{...env,openSettingsAi:()=>dashboardDeclaredFunction('openSettingsAi',env)()})();
  assert.deepEqual(trace,[['owner','account:a'],['tab','today']]);
  assert.equal(dashboardJsxProp('AccountStudyPlan','initialSection',{accountAiEntryOwner:'account:a',accountWorkspaceId:'account:a'}),'ai');
  assert.equal(dashboardJsxProp('AccountStudyPlan','initialSection',{accountAiEntryOwner:'account:a',accountWorkspaceId:'account:b'}),undefined);
});
test('local AI and accounts without a loaded library retain the connection setup route',()=>{
  for(const state of [{settingsUsesAccount:false,accountLoaded:null},{settingsUsesAccount:true,accountLoaded:null}]){
    const trace=[];dashboardDeclaredFunction('openSettingsAi',{...state,accountWorkspaceId:'account:a',setAccountAiEntryOwner:()=>assert.fail('must not open unloaded editor'),setTab:()=>assert.fail('must stay in setup'),setSourceView:v=>trace.push(v)})();
    assert.deepEqual(trace,['connections']);
  }
});

