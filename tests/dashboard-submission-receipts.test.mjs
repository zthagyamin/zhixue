import assert from 'node:assert/strict';
import test from 'node:test';
import {dashboardFunction} from './fixtures/dashboard-functions.mjs';
import * as status from '../app/study-submission-status.ts';
function fixture(result){let state={workspaceId:'account:a',eventId:'latest',cloud:'pending',companion:'pending'};const env={submissionTransport:()=>({core:async()=>result}),sendSubmittedAuxiliary:async()=>{},deliveryOwnerRef:{current:'account:a'},setLastStudyReceipts:fn=>state=fn(state)};
  return{env,state:()=>state,payload:{workspaceId:'account:a',eventId:'latest',route:{kind:'native'}}};
}
test('latest core receipt shows account reception independently of auxiliary and writeback status',async()=>{
  const f=fixture({accepted:['latest']});await dashboardFunction('sendSubmittedCloud',f.env)(f.payload);assert.equal(f.state().cloud,'acked');assert.equal(f.state().companion,'pending');
});
test('late core replies cannot relabel the newer visible attempt',async()=>{
  const f=fixture({accepted:['older']});await dashboardFunction('sendSubmittedCloud',f.env)({...f.payload,eventId:'older'});assert.equal(f.state().eventId,'latest');assert.equal(f.state().cloud,'pending');
});
test('a native pending projection stays pending even when its core receipt is durable',async()=>{
  const f=fixture({status:'accepted',projectionStatus:'pending',companionReceipt:{durable:true}});await dashboardFunction('sendSubmittedCompanion',f.env)(f.payload);assert.equal(f.state().companion,'pending');
});
test('native acknowledgement is displayed as received, not as verified Obsidian application',async()=>{
  const f=fixture({status:'accepted',companionReceipt:{durable:true,projectionStatus:'applied'}});await dashboardFunction('sendSubmittedCompanion',f.env)(f.payload);assert.equal(f.state().companion,'received');
});
test('validated account writeback notices are library-scoped and cannot regress an applied receipt',()=>{
  assert.equal(typeof status.foldCoreReceiptNotice,'function');const prior={workspaceId:'account:a',libraryId:'library-a',eventId:'latest',cloud:'pending',companion:'pending'};
  const receipt={schemaVersion:1,libraryId:'library-a',eventId:'latest',envelopeHash:'a'.repeat(64),target:'companion',status:'applied',revision:4};
  const applied=status.foldCoreReceiptNotice(prior,'account:a',receipt);assert.equal(applied.companion,'applied');
  assert.deepEqual(status.foldCoreReceiptNotice(applied,'account:a',{...receipt,status:'received',revision:1}),applied);
  assert.deepEqual(status.foldCoreReceiptNotice(prior,'account:a',{...receipt,libraryId:'other'}),prior);
  assert.deepEqual(status.foldCoreReceiptNotice(prior,'account:b',receipt),prior);
});
test('an older cached auxiliary view cannot hide a newer received or applied acknowledgement',()=>{
  assert.equal(typeof status.strongerAuxiliaryDelivery,'function');assert.equal(status.strongerAuxiliaryDelivery('account-received','pending'),'account-received');
  assert.equal(status.strongerAuxiliaryDelivery('pending','applied'),'applied');assert.equal(status.strongerAuxiliaryDelivery('not-saved','unknown'),'not-saved');
});
