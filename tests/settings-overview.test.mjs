import assert from 'node:assert/strict';
import test from 'node:test';
import {dashboardFunction,dashboardValue} from './fixtures/dashboard-functions.mjs';
import {countSettingsPractice,settingsPendingSummary} from '../app/study-settings-model.ts';

const recovery={complete:true,finishedAt:'2026-09-07T12:00:00Z',pending:{coreUploads:['attempt-a'],coreWritebacks:['attempt-a'],recovery:[],assistance:[],tasks:[],legacyQueues:false},payload:{workspaceRecords:[]}};
function fixture(){
  const updates=[];
  const env={accountWorkspaceId:'account:a',storageReady:true,sessionResolved:true,deliveryOwnerRef:{current:'account:a'},settingsReadScope:'scope:a',settingsReadEpoch:{current:0},
    settingsUsesAccount:true,setSettingsOverview:value=>updates.push(value),exportStudyRecovery:async()=>recovery,settingsPendingSummary,
    accountClient:{getAiSettings:async()=>({serverAvailable:true,settings:{revision:1,enabled:false,configured:false}})}};
  return{env,updates,read:()=>dashboardFunction('refreshSettingsOverview',env)()};
}

test('overview reads the real durable summary and independent AI configuration',async()=>{
  const f=fixture();await f.read();const result=f.updates.at(-1);
  assert.equal(result.phase,'ready');assert.equal(result.pending.total,1);
  assert.equal(result.accountAi.settings.enabled,false);assert.equal(result.checkedAt,recovery.finishedAt);
});
test('failed queue reads remain unknown while an independent AI result can still be shown',async()=>{
  const f=fixture();f.env.exportStudyRecovery=async()=>{throw new Error('unavailable');};await f.read();
  assert.equal(f.updates.at(-1).pending,null);assert.equal(f.updates.at(-1).phase,'failed');
  assert.equal(f.updates.at(-1).accountAi.settings.configured,false);
});
test('late overview reads cannot update a different account',async()=>{
  const f=fixture();f.env.exportStudyRecovery=async()=>{f.env.deliveryOwnerRef.current='account:b';return recovery;};await f.read();
  assert.deepEqual(f.updates.map(row=>row.phase),['loading']);
  assert.equal(dashboardValue('settingsReadView',{settingsOverview:{scope:'scope:a',pending:{total:3}},settingsReadScope:'scope:b'}),null);
});
test('actual overview counters do not add the projection count to the same event log',()=>{
  const events=[{eventId:'a',eventType:'practice-attempt'},{eventId:'a',eventType:'practice-attempt'},{eventId:'baseline',eventType:'review-baseline'}];
  const env={progressEvents:events,uiProgress:{answered:20},countSettingsPractice,settingsHistoryReady:true};
  assert.equal(dashboardValue('settingsRecordCount',env),1);
  assert.equal(dashboardValue('settingsRecordCount',{...env,settingsHistoryReady:false}),null);
});
test('registered question totals use the complete account snapshot, not task-filtered subjects',()=>{
  assert.equal(dashboardValue('settingsRegisteredCount',{accountLoaded:{bundle:{items:[1,2,3]}},subjects:[{items:[1]}]}),3);
  assert.equal(dashboardValue('settingsRegisteredCount',{accountLoaded:null,accountWanted:true,isDemoMode:false,normalizedSubjects:[{items:[1,2,3]}]}),null);
});
test('a failed native history refresh cannot mark the retained projection as verified',()=>{
  const env={accountLoaded:null,accountWanted:false,isDemoMode:false,nativeView:{ready:true,unresolvedKeys:[]},nativeHistoryError:'History read failed'};
  assert.equal(dashboardValue('settingsHistoryReady',env),false);
  assert.equal(dashboardValue('settingsHistoryReady',{...env,nativeHistoryError:null}),true);
});
