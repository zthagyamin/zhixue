import assert from 'node:assert/strict';
import test from 'node:test';
let api;try{api=await import('../app/native-progress-view.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const base=()=>({itemStages:{shared:3,unrelated:2},fsrsData:{shared:{foreign:true}},answered:9,correct:7});
const overlay=(extra={})=>({workspaceId:'account:a',sourceScope:'native-source',events:[],excludedKeys:['shared'],itemStages:{},fsrsData:{},...extra});
test('unproven old values stay in recovery storage but are masked and marked unresolved in the native view',()=>{
  assert.equal(typeof api?.nativeProgressView,'function');const value=base(),before=structuredClone(value),result=api.nativeProgressView(value,overlay(),{workspaceId:'account:a',sourceScope:'native-source'});
  assert.equal(result.ready,true);assert.deepEqual(result.unresolvedKeys,['shared']);assert.equal(result.progress.itemStages.shared,undefined);assert.equal(result.progress.fsrsData.shared,undefined);assert.equal(result.progress.itemStages.unrelated,2);assert.deepEqual(value,before);
});
test('legitimate same-key native stages replace the derived account value without borrowing foreign FSRS',()=>{
  const result=api.nativeProgressView(base(),overlay({itemStages:{shared:1}}),{workspaceId:'account:a',sourceScope:'native-source'});
  assert.equal(result.progress.itemStages.shared,1);assert.equal(result.progress.fsrsData.shared,undefined);assert.deepEqual(result.unresolvedKeys,[]);
});
test('a later old cloud snapshot merge cannot resurrect a masked account-only value',()=>{
  const result=api.nativeProgressView({...base(),itemStages:{shared:3,unrelated:3}},overlay(),{workspaceId:'account:a',sourceScope:'native-source'});
  assert.equal(result.progress.itemStages.shared,undefined);assert.equal(result.progress.itemStages.unrelated,3);
});
test('a projection from a different owner or source cannot be used as a ready native basis',()=>{
  assert.equal(api.nativeProgressView(base(),overlay(),{workspaceId:'account:b',sourceScope:'native-source'}).ready,false);
  assert.equal(api.nativeProgressView(base(),overlay(),{workspaceId:'account:a',sourceScope:'other-source'}).ready,false);
});

test('a durable native grade updates the derived stage immediately without inheriting a foreign curve',()=>{
  assert.equal(typeof api.applySavedNativeAttempt,'function');const p=overlay({itemStages:{shared:1}}),scope={workspaceId:'account:a',sourceScope:'native-source'};
  const event={eventType:'practice-attempt',eventId:'native-new',item:{key:'shared'},attempt:{stageAfter:2}};
  const next=api.applySavedNativeAttempt(p,scope,event,undefined);
  assert.equal(api.nativeProgressView(base(),next,scope).progress.itemStages.shared,2);assert.equal(next.events[0],event);assert.equal(next.fsrsData.shared,undefined);
  assert.equal(api.applySavedNativeAttempt(p,{...scope,sourceScope:'new-source'},event,undefined),p);
});
