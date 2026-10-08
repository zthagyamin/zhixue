import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {createSubmissionJournal} from '../app/study-submission-journal.ts';
import {prepareStudySubmission} from '../app/study-submission.ts';
import {putLocalStudyEvent,updateStudyEventDelivery} from '../app/local-study-events.ts';
import {putLocalStudySnapshot} from '../app/local-account-study.ts';
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';
import {wordBody,snapshotBody} from './fixtures/account-study-fixtures.mjs';
import {attempt} from './fixtures/task-event-fixtures.mjs';
import {readFile} from 'node:fs/promises';
import {putLocalStudyRecord} from '../app/local-account-study.ts';
let api;try{api=await import('../app/study-submission-history.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
async function fixture(){assert.equal(typeof api?.readRecoverableStudyEvents,'function');globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
  const workspaceId='account:a',event=await attempt('recovery-one','2026-09-01T00:01:00Z',0,1),core={workspaceId,eventId:event.eventId,event,cloud:'pending',companion:'not-required',occurredAt:event.occurredAt,updatedAt:event.occurredAt};
  const item=await sealStudyItem(wordBody()),bundle={items:[item],snapshot:await sealStudySnapshot(snapshotBody([item]))};await putLocalStudySnapshot(workspaceId,bundle,0);
  const journal=createSubmissionJournal(),payload=await prepareStudySubmission(core,{kind:'account',bundle,originDeviceId:'device-a',practiceMode:'three-stage'},null,journal);return {workspaceId,core,journal,payload};
}
test('journal-only core participates in recovery without inventing a cloud sequence',async()=>{
  const f=await fixture();await f.journal.put(f.payload);const history=await api.readRecoverableStudyEvents(f.workspaceId,f.journal);
  assert.deepEqual(history,[f.core]);assert.deepEqual(await api.readRecoverableStudyEvents('account:b',f.journal),[]);
  const local=await api.readAccountLocalPractice(f.workspaceId,'library-a',f.journal);assert.equal(local.records.length,1);assert.equal(local.records[0].sequence,undefined);assert.equal(local.bundles[0].snapshot.snapshotId,'snapshot-a');
  assert.equal((await api.readAccountLocalPractice(f.workspaceId,'other-library',f.journal)).records.length,0);
});
test('recovered same-event core keeps the original store receipt instead of its initial journal flag',async()=>{
  const f=await fixture();await f.journal.put(f.payload);await putLocalStudyEvent(f.core);await updateStudyEventDelivery(f.workspaceId,f.core.eventId,'cloud','acked');
  const rows=await api.readRecoverableStudyEvents(f.workspaceId,f.journal);assert.equal(rows.length,1);assert.equal(rows[0].cloud,'acked');
});
test('an unreadable journal cannot be presented to planning as complete history',async()=>{
  const f=await fixture();await putLocalStudyEvent(f.core);await assert.rejects(api.readRecoverableStudyEvents(f.workspaceId,{list:async()=>{throw new Error('journal read failed');}}),/journal read failed/);
});
test('same ID with different immutable core is rejected, not deduplicated as if it were equivalent',async()=>{
  const f=await fixture();await f.journal.put(f.payload);const event=await attempt(f.core.eventId,'2026-09-01T00:01:00Z',0,0,false);
  await putLocalStudyEvent({...f.core,event});await assert.rejects(api.readRecoverableStudyEvents(f.workspaceId,f.journal),/conflict/);
});
test('legacy unassociated records remain separate from account-library practice',async()=>{
  const f=await fixture();await putLocalStudyEvent(f.core);assert.equal((await api.readRecoverableStudyEvents(f.workspaceId,f.journal)).length,1);
  assert.equal((await api.readAccountLocalPractice(f.workspaceId,'library-a',f.journal)).records.length,0);
});

test('locally saved self-report tasks remain separate from practice but are available for the Today display',async()=>{
  const f=await fixture(),vector=JSON.parse(await readFile(new URL('./fixtures/account-study-v1.json',import.meta.url),'utf8'));await putLocalStudyRecord(f.workspaceId,vector.task);
  const value=await api.readAccountLocalPractice(f.workspaceId,'library-a',f.journal);assert.equal(value.records.length,0);assert.deepEqual(value.taskRecords,[vector.task]);assert.equal(value.bundles.length,1);
});
