import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {assistanceView,assistanceBundle} from './fixtures/assistance-read.mjs';
import {createSubmissionJournal} from '../app/study-submission-journal.ts';
import {putLocalStudySnapshot,putLocalStudyRecord} from '../app/local-account-study.ts';
import {putLocalStudyEvent,listWorkspaceStudyEvents} from '../app/local-study-events.ts';
import {withStudyEventCoreHash} from '../app/study-event-v3.ts';
import {readRecoverableStudyEvents} from '../app/study-submission-history.ts';
let api;try{api=await import('../app/native-study-history.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
async function fixture(){assert.equal(typeof api?.readNativeStudyHistory,'function');globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
  const workspaceId='account:a',view=await assistanceView(),record=view.summaries[0].parent,event=record.event,core={workspaceId,eventId:event.eventId,event,cloud:'pending',companion:'not-required',occurredAt:event.occurredAt,updatedAt:event.occurredAt},journal=createSubmissionJournal();
  const payload={schemaVersion:1,workspaceId,eventId:event.eventId,core,route:{kind:'account',record},summary:null};await putLocalStudySnapshot(workspaceId,assistanceBundle(),0);return {workspaceId,record,event,core,journal,payload};
}
for(const channel of ['journal-only','journal-and-v3','old-envelope-only'])test(`native projection excludes known account copies: ${channel}`,async()=>{
  const f=await fixture();if(channel!=='old-envelope-only')await f.journal.put(f.payload);else await putLocalStudyRecord(f.workspaceId,f.record);
  if(channel!=='journal-only')await putLocalStudyEvent(f.core);
  const native=await api.readNativeStudyHistory(f.workspaceId,f.journal,{cachedEvents:[f.event]});assert.deepEqual(native.events,[]);assert.deepEqual(native.excludedKeys,[f.event.item.key]);
  const all=await readRecoverableStudyEvents(f.workspaceId,f.journal);assert.equal(all.length,1);assert.equal((await listWorkspaceStudyEvents(f.workspaceId)).length,channel==='journal-only'?0:1);
});
test('same item key with an independent native attempt is preserved, not deleted by key',async()=>{
  const f=await fixture();await f.journal.put(f.payload);await putLocalStudyEvent(f.core);
  const event=await withStudyEventCoreHash({...f.event,eventId:'native-legitimate'});await putLocalStudyEvent({...f.core,eventId:event.eventId,event,companion:'pending',cloud:'not-required'});
  const result=await api.readNativeStudyHistory(f.workspaceId,f.journal);assert.deepEqual(result.events.map(row=>row.eventId),['native-legitimate']);
});
test('current Companion confirmation may legitimately return the same account-origin core',async()=>{
  const f=await fixture();await f.journal.put(f.payload);await putLocalStudyEvent(f.core);
  const result=await api.readNativeStudyHistory(f.workspaceId,f.journal,{companionEvents:[f.event]});assert.deepEqual(result.events,[f.event]);
});
test('same event ID with different core content is rejected rather than assigned to native history',async()=>{
  const f=await fixture();await putLocalStudyRecord(f.workspaceId,f.record);const event=await withStudyEventCoreHash({...f.event,occurredAt:'2026-09-02T00:00:00.000Z'});
  await putLocalStudyEvent({...f.core,event,occurredAt:event.occurredAt});await assert.rejects(api.readNativeStudyHistory(f.workspaceId,f.journal),/conflict/);
});
