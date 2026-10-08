import assert from 'node:assert/strict';
import test from 'node:test';
let model={};
try{model=await import('../app/study-settings-model.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}

test('sign-in cannot turn an unconnected or failed question bank green',()=>{
  assert.equal(typeof model.settingsAccountConnection,'function');
  for(const phase of ['not-connected','local','loading','failed']){
    const row=model.settingsAccountConnection({phase},true);
    assert.notEqual(row.tone,'good');assert.notEqual(row.label,'已连接');
  }
  assert.equal(model.settingsAccountConnection({phase:'ready'},true).tone,'good');
});

test('a saved pairing does not prove the Companion is online',()=>{
  assert.equal(typeof model.settingsCompanionConnection,'function');
  assert.equal(model.settingsCompanionConnection({paired:true,detected:'offline',syncState:'offline'}).label,'离线');
  assert.equal(model.settingsCompanionConnection({paired:false,detected:'online',syncState:'offline'}).label,'在线，待配对');
  assert.equal(model.settingsCompanionConnection({paired:true,detected:'online',syncState:'key_missing'}).label,'已连接');
});

test('AI configuration comes from its own settings instead of account identity',()=>{
  assert.equal(typeof model.settingsAiConnection,'function');
  const base={mode:'account',signedIn:true,accountAi:null,companionOnline:false};
  assert.equal(model.settingsAiConnection(base).label,'待核对');
  assert.equal(model.settingsAiConnection({...base,accountAi:{serverAvailable:false,settings:{enabled:true,configured:true,revision:1}}}).label,'站点未启用');
  assert.equal(model.settingsAiConnection({...base,accountAi:{serverAvailable:true,settings:{enabled:false,configured:true,revision:1}}}).label,'未启用');
  assert.equal(model.settingsAiConnection({...base,accountAi:{serverAvailable:true,settings:{enabled:true,configured:true,revision:1}}}).label,'已启用');
  assert.equal(model.settingsAiConnection({...base,mode:'local',localStatus:'connected'}).label,'本机离线');
});

test('practice record totals exclude baselines and count duplicate event IDs once',()=>{
  assert.equal(typeof model.countSettingsPractice,'function');
  const events=[{eventId:'attempt-a',eventType:'practice-attempt'},{eventId:'attempt-a',eventType:'practice-attempt'},{eventId:'baseline-b',eventType:'review-baseline'}];
  assert.equal(model.countSettingsPractice(events,true),1);
  assert.equal(model.countSettingsPractice(events,false),null);
});

test('pending totals combine durable delivery paths without counting one attempt twice',()=>{
  assert.equal(typeof model.settingsPendingSummary,'function');
  const recovery={complete:true,pending:{coreUploads:['a'],coreWritebacks:['a','c'],recovery:['a','b'],tasks:['task-1'],assistance:['aux-1'],legacyQueues:true},payload:{workspaceRecords:[{kind:'cloud-outbox',value:[{eventId:'a'},{id:'old-1'}]}]}};
  assert.deepEqual(model.settingsPendingSummary(recovery),{total:6,uploads:4,writebacks:2,assistance:1});
  assert.equal(model.settingsPendingSummary({...recovery,complete:false}),null);
  assert.equal(model.settingsPendingSummary({...recovery,payload:{workspaceRecords:[{kind:'pending-activities',value:[{}]}]}}),null);
});
