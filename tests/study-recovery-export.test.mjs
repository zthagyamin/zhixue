import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {assistanceView,assistanceBundle} from './fixtures/assistance-read.mjs';
import {createSubmissionJournal} from '../app/study-submission-journal.ts';
import {putLocalStudySnapshot,putLocalStudyRecord,applyLocalStudyReceipt} from '../app/local-account-study.ts';
import {putLocalStudyEvent} from '../app/local-study-events.ts';
import {createAssistanceReadCache} from '../app/assistance-read-cache.ts';
import {hashLocalJson} from '../app/local-json-integrity.ts';
let api;try{api=await import('../app/study-recovery-export.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
async function fixture(){assert.equal(typeof api?.exportStudyRecovery,'function');globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
  const view=await assistanceView(),parent=view.summaries[0].parent,event=parent.event,workspaceId='account:a';
  await putLocalStudySnapshot(workspaceId,assistanceBundle(),0);
  const core={workspaceId,eventId:event.eventId,event,cloud:'pending',companion:'not-required',occurredAt:event.occurredAt,updatedAt:event.occurredAt},journal=createSubmissionJournal();
  await journal.put({schemaVersion:1,workspaceId,eventId:event.eventId,core,route:{kind:'account',record:parent},summary:view.summaries[0].record.summary});
  return{workspaceId,journal,view,parent,core};
}
test('complete recovery export includes journal-only work and uses original delivery evidence, not initial flags',async()=>{
  const f=await fixture();await putLocalStudyRecord(f.workspaceId,f.parent);await putLocalStudyEvent({...f.core,cloud:'acked'});await f.journal.markCoreStored(f.workspaceId,f.core.eventId);
  await applyLocalStudyReceipt(f.workspaceId,{schemaVersion:1,libraryId:'library-a',eventId:f.core.eventId,envelopeHash:f.parent.envelopeHash,target:'cloud',status:'acked',revision:1});
  const exported=await api.exportStudyRecovery(f.workspaceId);assert.equal(exported.consistency,'stable');assert.equal(exported.complete,true);assert.equal(exported.payload.submissions.length,1);assert.equal(exported.payloadHash,await hashLocalJson(exported.payload));
  assert.deepEqual(exported.pending.coreUploads,[]);assert.deepEqual(exported.pending.coreWritebacks,[f.core.eventId]);assert.equal(exported.pending.assistance.length,1);assert.equal(exported.unassignedLegacyEventIds.length,0);
});
test('a verified applied summary readback can close only auxiliary pending state, not core pending state',async()=>{
  const f=await fixture(),r=f.view.summaries[0].record;f.view.receiptThrough=2;f.view.receipts=[{sequence:2,writerGrantId:'writer',receivedAt:'2026-09-01T00:02:00.000Z',receipt:{schemaVersion:1,receiptId:'applied',summaryId:r.summary.summaryId,summaryHash:r.summary.summaryHash,associationHash:r.associationHash,status:'applied',proof:{attemptCoreHash:r.summary.attemptCoreHash,proofHash:'c'.repeat(64),targetCount:2}}}];
  await createAssistanceReadCache().commit({workspaceId:f.workspaceId,libraryId:'library-a'},f.view,0);const exported=await api.exportStudyRecovery(f.workspaceId);
  assert.deepEqual(exported.pending.assistance,[]);assert.ok(exported.pending.coreUploads.includes(f.core.eventId));assert.ok(exported.pending.recovery.includes(f.core.eventId));
});
test('a continuously changing cross-database read is explicitly partial rather than called an atomic backup',async()=>{
  const f=await fixture(),payload=await api.collectStudyRecovery(f.workspaceId);let changes=0;
  const result=await api.exportStudyRecovery(f.workspaceId,{collect:async()=>({...payload,workspaceRecords:[{workspaceId:f.workspaceId,id:f.workspaceId+':vocab-pacing',kind:'vocab-pacing',value:{quota:++changes},updatedAt:'2026-09-01T00:00:00.000Z'}]})});
  assert.equal(result.consistency,'changed-during-read');assert.equal(result.complete,false);assert.ok(changes>=2);
});
test('unassociated old core stays at account scope and never inherits a library from the open view',async()=>{
  const f=await fixture();const old={...f.core,eventId:'legacy-other',event:{...f.core.event,eventId:'legacy-other'}};
  const {withStudyEventCoreHash}=await import('../app/study-event-v3.ts');old.event=await withStudyEventCoreHash(old.event);await putLocalStudyEvent(old);
  const result=await api.exportStudyRecovery(f.workspaceId);assert.deepEqual(result.unassignedLegacyEventIds,['legacy-other']);assert.equal(result.payload.accountLibraries[0].records.length,0);
});
test('a source dependency with only the same snapshot ID is insufficient for a complete recovery claim',async()=>{
  const f=await fixture(),payload=await api.collectStudyRecovery(f.workspaceId),changed=structuredClone(payload);
  changed.accountLibraries[0].snapshots[0].items=[];
  const result=await api.exportStudyRecovery(f.workspaceId,{collect:async()=>changed});assert.equal(result.complete,false);assert.ok(result.missingDependencies.some(value=>value.startsWith('item-version:')));
});
