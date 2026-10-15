import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createSourceSelfAssessmentRepository} from '../src/infrastructure/source-admission/index.ts';

globalThis.indexedDB=new IDBFactory();
let serial=0;
function original(){return {attemptId:'self-'+serial++,binding:{ownerId:'local-owner',libraryId:'local-library',itemKey:'q',
 contentHash:'a'.repeat(64),snapshotId:'local',groupId:'group',roundId:'round'},submitted:{answer:'',answerRevision:0,
 submittedAt:'2026-10-10T00:00:00.000Z'},checkpoint:{mode:'flashcard',purpose:'first'}};}
const repo=()=>createSourceSelfAssessmentRepository({ownerId:'local-owner',libraryId:'local-library'});

test('first self-assessment remains separate from mutable view, empty oral answer and refreshed repository',async()=>{
 const attempt=original(),saved=await repo().save(attempt,'hard');
 attempt.checkpoint.pluginFields={flashcardRating:'easy'};
 assert.deepEqual(await repo().read(attempt),saved);
 assert.equal((await repo().save(attempt,'good')).rating,'hard');assert.equal(attempt.submitted.answer,'');
});
test('two actual IndexedDB peers retain one first declaration',async()=>{
 const attempt=original(),rows=await Promise.all([repo().save(attempt,'again'),repo().save(attempt,'easy')]);
 assert.equal(rows[0].rating,rows[1].rating);assert.deepEqual(await repo().read(attempt),rows[0]);
});
test('changed original binding, answer revision or immutable time cannot reuse self-assessment',async()=>{
 const attempt=original();await repo().save(attempt,'good');
 for(const change of [row=>{row.binding.contentHash='b'.repeat(64);},row=>{row.submitted.answerRevision=1;},
  row=>{row.submitted.submittedAt='2026-10-10T00:01:00.000Z';},row=>{row.binding.ownerId='other';}]){
  const changed=structuredClone(attempt);change(changed);await assert.rejects(repo().read(changed),/scope|integrity/);
 }
 const other=createSourceSelfAssessmentRepository({ownerId:'other',libraryId:'local-library'});
 assert.equal(await other.read({...attempt,binding:{...attempt.binding,ownerId:'other'}}),null);
});
test('storage unavailable returns no durability and original self-assessment survives restoration',async()=>{
 const attempt=original();await repo().save(attempt,'again');const factory=globalThis.indexedDB;
 try{globalThis.indexedDB=undefined;await assert.rejects(repo().save(attempt,'good'),/storage-unavailable/);}
 finally{globalThis.indexedDB=factory;}
 assert.equal((await repo().read(attempt)).rating,'again');
});
