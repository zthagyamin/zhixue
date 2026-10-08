import assert from 'node:assert/strict';import test from 'node:test';import {indexedDB,IDBKeyRange} from 'fake-indexeddb';globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange;
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';import {wordBody,snapshotBody} from './fixtures/account-study-fixtures.mjs';import {attempt} from './fixtures/task-event-fixtures.mjs';let api;
try{api=await import('../app/account-study-record-client.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
let scopeId=0;async function setup(){const item=await sealStudyItem(wordBody()),snapshot=await sealStudySnapshot(snapshotBody([item])),bundle={snapshot,items:[item]},workspace=`account:user-${++scopeId}`;const local=await import('../app/local-account-study.ts');await local.putLocalStudySnapshot(workspace,bundle,0);return{item,bundle,workspace,local};}
test('account envelope can be prepared for a write-ahead journal before either original store is written',async()=>{
  assert.equal(typeof api.prepareAccountStudyRecord,'function');const {item,bundle,workspace,local}=await setup();
  const event=await attempt('prepared-event','2026-09-01T00:01:00Z',0,1,true,{item:{kind:'word',key:item.itemKey}});
  const prepared=await api.prepareAccountStudyRecord({workspaceId:workspace,bundle,event,originDeviceId:'device-a',practiceMode:'three-stage'});
  assert.equal(prepared.event.eventId,'prepared-event');assert.equal(prepared.parentEventId,null);assert.deepEqual(await local.listLocalStudyRecords(workspace,'library-a'),[]);
});
test('preparation captures the displayed version and mode before asynchronous local reads',async()=>{
  assert.equal(typeof api.prepareAccountStudyRecord,'function');const {item,bundle,workspace}=await setup();
  const event=await attempt('frozen-preparation','2026-09-01T00:01:00Z',0,1,true,{item:{kind:'word',key:item.itemKey}}),input={workspaceId:workspace,bundle,event,originDeviceId:'device-a',practiceMode:'three-stage'};
  const waiting=api.prepareAccountStudyRecord(input);input.practiceMode='spelling';bundle.snapshot.snapshotId='later-snapshot';bundle.items[0].contentHash='b'.repeat(64);
  const record=await waiting;assert.equal(record.snapshotId,'snapshot-a');assert.equal(record.practiceMode,'three-stage');assert.notEqual(record.contentHash,'b'.repeat(64));
});
test('a journal-only parent preserves a verified three-stage round after original-store interruption',async()=>{
  assert.equal(typeof api.prepareAccountStudyRecord,'function');const {item,bundle,workspace,local}=await setup();
  const first=await api.prepareAccountStudyRecord({workspaceId:workspace,bundle,event:await attempt('journal-parent','2026-09-01T00:01:00Z',0,1,true,{item:{kind:'word',key:item.itemKey}}),originDeviceId:'device-a',practiceMode:'three-stage'});
  const second=await api.prepareAccountStudyRecord({workspaceId:workspace,bundle,event:await attempt('journal-child','2026-09-01T00:02:00Z',1,2,true,{item:{kind:'word',key:item.itemKey}}),originDeviceId:'device-a',practiceMode:'three-stage',pendingRecords:[first]});
  assert.equal(second.parentEventId,first.event.eventId);assert.equal(second.roundId,first.roundId);assert.equal(second.provenanceMode,'verified-round');assert.deepEqual(await local.listLocalStudyRecords(workspace,'library-a'),[]);
});
test('offline three-stage records preserve one local round and exact parent ancestry',async()=>{
  assert.equal(typeof api?.ensureAccountStudyRecord,'function','Account record adapter must exist');const {item,bundle,workspace,local}=await setup();
  const records=[];for(const [i,[before,after]] of [[0,1],[1,2],[2,3]].entries()){
    const event=await attempt(`client-event-${i}` ,`2026-09-01T00:0${i}:00Z`,before,after,true,{item:{kind:'word',key:item.itemKey}});
    records.push(await api.ensureAccountStudyRecord({workspaceId:workspace,bundle,event,originDeviceId:'device-a',practiceMode:'three-stage'}));
  }
  assert.equal(records[0].parentEventId,null);assert.equal(records[1].parentEventId,records[0].event.eventId);assert.equal(records[2].parentEventId,records[1].event.eventId);
  assert.equal(new Set(records.map(r=>r.roundId)).size,1);assert.equal((await local.listLocalStudyRecords(workspace,'library-a')).length,3);
});
test('same core event retry returns same envelope and non-three-stage uses one round',async()=>{
  const {item,bundle,workspace}=await setup(),event=await attempt('spelling-client','2026-09-01T01:00:00Z',0,3,true,{item:{kind:'word',key:item.itemKey}});
  const first=await api.ensureAccountStudyRecord({workspaceId:workspace,bundle,event,originDeviceId:'device-a',practiceMode:'spelling'}),second=await api.ensureAccountStudyRecord({workspaceId:workspace,bundle,event,originDeviceId:'device-a',practiceMode:'spelling'});
  assert.deepEqual(first,second);assert.equal(first.parentEventId,null);
});
test('mid-stage event without local account ancestry does not masquerade as verified round',async()=>{
  const {item,bundle,workspace}=await setup(),event=await attempt('orphan-client','2026-09-01T01:00:00Z',1,2,true,{item:{kind:'word',key:item.itemKey}});
  await assert.rejects(api.ensureAccountStudyRecord({workspaceId:workspace,bundle,event,originDeviceId:'device-a',practiceMode:'three-stage'}),/legacy-resume/);
});
test('same device can finish an explicitly marked pre-upgrade stage without fake parents',async()=>{
  const {item,bundle,workspace}=await setup(),firstEvent=await attempt('legacy-client-one','2026-09-01T01:00:00Z',1,2,true,{item:{kind:'word',key:item.itemKey}});
  const first=await api.ensureAccountStudyRecord({workspaceId:workspace,bundle,event:firstEvent,originDeviceId:'device-a',practiceMode:'three-stage',legacyResume:{stage:1,anchorEventId:null,anchorCoreHash:null}});
  assert.equal(first.provenanceMode,'legacy-continuation');assert.equal(first.parentEventId,null);assert.equal(first.legacyStage,1);
  const lastEvent=await attempt('legacy-client-two','2026-09-01T01:01:00Z',2,3,true,{item:{kind:'word',key:item.itemKey}}),last=await api.ensureAccountStudyRecord({workspaceId:workspace,bundle,event:lastEvent,originDeviceId:'device-a',practiceMode:'three-stage'});
  assert.equal(last.parentEventId,first.event.eventId);assert.equal(last.resumeId,first.resumeId);
});
test('cloud flush batches immutable records and applies only cloud durability receipts',async()=>{
  const {item,bundle,workspace,local}=await setup(),event=await attempt('flush-client','2026-09-01T01:00:00Z',0,3,true,{item:{kind:'word',key:item.itemKey}});
  await api.ensureAccountStudyRecord({workspaceId:workspace,bundle,event,originDeviceId:'device-a',practiceMode:'spelling'});
  const sent=[];await api.flushAccountStudyRecords(workspace,'library-a',async records=>{sent.push(...records);return{results:records.map((record,i)=>({eventId:record.event.eventId,durable:true,receipt:{schemaVersion:1,libraryId:'library-a',eventId:record.event.eventId,envelopeHash:record.envelopeHash,target:'cloud',status:'acked',revision:i+1}}))};});
  assert.equal(sent.length,1);const row=(await local.listLocalStudyRecords(workspace,'library-a'))[0];assert.equal(row.cloud,'acked');assert.equal(row.writeback,'pending');
});
test('a durable batch item cannot apply a receipt for a different target or envelope',async()=>{
  const {item,bundle,workspace,local}=await setup(),event=await attempt('wrong-flush','2026-09-01T01:00:00Z',0,3,true,{item:{kind:'word',key:item.itemKey}});
  const record=await api.ensureAccountStudyRecord({workspaceId:workspace,bundle,event,originDeviceId:'device-a',practiceMode:'spelling'});
  await assert.rejects(api.flushAccountStudyRecords(workspace,'library-a',async()=>({results:[{eventId:event.eventId,durable:true,receipt:{schemaVersion:1,libraryId:'library-a',eventId:event.eventId,envelopeHash:record.envelopeHash,target:'companion',status:'received',revision:1}}]})),/receipt-binding/);
  const row=(await local.listLocalStudyRecords(workspace,'library-a'))[0];assert.equal(row.cloud,'pending');assert.equal(row.writeback,'pending');
});
test('an account envelope with a conflicting legacy mirror is not silently uploaded by the fallback queue',async()=>{
  const {item,bundle,workspace}=await setup(),event=await attempt('mirror-conflict','2026-09-01T01:00:00Z',0,3,true,{item:{kind:'word',key:item.itemKey}});
  await api.ensureAccountStudyRecord({workspaceId:workspace,bundle,event,originDeviceId:'device-a',practiceMode:'spelling'});
  const {putLocalStudyEvent}=await import('../app/local-study-events.ts'),other=await attempt(event.eventId,'2026-09-01T01:00:00Z',0,0,false,{item:{kind:'word',key:item.itemKey}});
  await putLocalStudyEvent({workspaceId:workspace,eventId:other.eventId,event:other,cloud:'conflict',companion:'not-required',occurredAt:other.occurredAt,updatedAt:other.occurredAt});
  let sent=0;await assert.rejects(api.flushAccountStudyRecords(workspace,'library-a',async()=>{sent++;return{results:[]};}),/mirror-conflict/);assert.equal(sent,0);
});
