import assert from 'node:assert/strict';
import test from 'node:test';
import {dashboardFunction} from './fixtures/dashboard-functions.mjs';
function fixture(cloud){
  const event={eventType:'practice-attempt',eventId:'saved-attempt',coreHash:'a'.repeat(64),item:{key:'word:one'},attempt:{stageBefore:0,stageAfter:1,correct:true}},item={itemKey:event.item.key,kind:'word',recommendedPlugin:'three-stage'},bundle={snapshot:{libraryId:'library-a'},items:[item]};let receipt;
  const env={accountLoadedRef:{current:{bundle}},accountWorkspaceId:'account:user',accountDeviceId:'device',accountModeEpoch:{current:2},workspaceId:'account:user',
    deliveryOwnerRef:{current:'account:user'},submissionJournal:{get:async()=>null},readJournalForDelivery:async()=>null,findLocalAccountStudyRecord:async()=>({record:{event,libraryId:'library-a'}}),
    createAccountStudyClient:()=>({appendRecords:async()=>({results:[]})}),companionUrl:'http://127.0.0.1:43225',
    accountAttemptHashes:{current:new Map()},accountAttemptSnapshots:{current:new Map()},accountBundlesRef:{current:new Map()},accountPracticeModes:{current:new Map([[item.itemKey,'three-stage']])},
    resolveAccountStudyItem:()=>({bundle,item}),ensureAccountStudyRecord:async()=>({event}),flushAccountStudyRecords:async()=>{},accountClient:{appendRecords:async()=>({results:[]})},
    getLocalStudyRecord:async()=>({cloud,record:{event}}),setLastStudyReceipts:update=>receipt=update({workspaceId:'account:user',eventId:event.eventId,libraryId:'library-a'}),refreshAccountRead:async()=>{throw new Error('Partial word need not reload');}};
  return{event,run:dashboardFunction('sendV3ToCloud',env),receipt:()=>receipt};
}
test('restart recovery acknowledges the V3 event from its already verified portable receipt',async()=>{
  const f=fixture('acked');assert.deepEqual((await f.run(f.event)).accepted,[f.event.eventId]);assert.equal(f.receipt().cloud,'acked');
});
test('an empty send batch cannot claim account receipt without durable evidence',async()=>{
  const f=fixture('pending');assert.deepEqual((await f.run(f.event)).accepted,[]);assert.equal(f.receipt().cloud,'pending');
});
