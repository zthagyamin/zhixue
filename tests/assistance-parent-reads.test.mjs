import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import * as local from '../app/local-account-study.ts';
import {createSubmissionJournal} from '../app/study-submission-journal.ts';
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';
import {sealStudyRecord} from '../app/account-study-record.ts';
import {wordBody,snapshotBody,recordBody} from './fixtures/account-study-fixtures.mjs';
import {attempt} from './fixtures/task-event-fixtures.mjs';
async function setup(){globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
  const items=await Promise.all([wordBody(),wordBody({itemKey:'word:other'})].map(sealStudyItem)),bundle={items,snapshot:await sealStudySnapshot(snapshotBody(items))};await local.putLocalStudySnapshot('account:a',bundle,0);
  const records=[];for(const [index,item]of items.entries())records.push(await sealStudyRecord(await recordBody({contentHash:item.contentHash,roundId:'round-'+index,attemptId:'attempt-'+index,event:await attempt('event-'+index,'2026-09-01T00:01:00Z',0,1,true,{item:{kind:'word',key:item.itemKey}})})));
  return{records,journal:createSubmissionJournal()};
}
test('causal preparation reads only matching account item records, not a whole-history projection',async()=>{
  assert.equal(typeof local.listLocalStudyItemRecords,'function');const {records}=await setup();for(const record of records)await local.putLocalStudyRecord('account:a',record);
  assert.deepEqual((await local.listLocalStudyItemRecords('account:a','library-a','word:tree')).map(row=>row.record.event.eventId),['event-0']);
  assert.deepEqual(await local.listLocalStudyItemRecords('account:b','library-a','word:tree'),[]);assert.equal((await local.listLocalStudyRecords('account:a','library-a')).length,2);
});
test('journal-only causal reads retain the original library and item instead of mixing same-owner records',async()=>{
  const {records,journal}=await setup();assert.equal(typeof journal.relatedAccountRecords,'function');
  for(const record of records)await journal.put({schemaVersion:1,workspaceId:'account:a',eventId:record.event.eventId,core:{workspaceId:'account:a',eventId:record.event.eventId,event:record.event,cloud:'pending',companion:'not-required',occurredAt:record.event.occurredAt,updatedAt:record.event.occurredAt},route:{kind:'account',record},summary:null});
  assert.deepEqual((await journal.relatedAccountRecords('account:a','library-a','word:tree')).map(record=>record.event.eventId),['event-0']);
  assert.deepEqual(await journal.relatedAccountRecords('account:a','other-library','word:tree'),[]);assert.deepEqual(await journal.relatedAccountRecords('account:b','library-a','word:tree'),[]);
});
