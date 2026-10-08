import test from 'node:test';import assert from 'node:assert/strict';import {IDBFactory} from 'fake-indexeddb';
import {openRecallAttempt,recordRecallHint} from '../app/recall-attempt-state.ts';
test('hint maximum survives reload and concurrent updates; a new durable answer starts a new attempt',async()=>{
 globalThis.indexedDB=new IDBFactory();const scope={workspaceId:'account:recall-qa',libraryId:'lib',itemKey:'one',contentHash:'a'.repeat(64)};
 const first=await openRecallAttempt(scope,async()=>false);assert.equal(first.maxPreHintLevel,0);
 await Promise.all([recordRecallHint(scope,first.attemptId,2),recordRecallHint(scope,first.attemptId,1)]);
 const restored=await openRecallAttempt(scope,async()=>false);assert.equal(restored.attemptId,first.attemptId);assert.equal(restored.maxPreHintLevel,2);
 const next=await openRecallAttempt(scope,async id=>id===first.attemptId);assert.notEqual(next.attemptId,first.attemptId);assert.equal(next.maxPreHintLevel,0);
 await assert.rejects(recordRecallHint(scope,first.attemptId,3),/changed/);
 const other=await openRecallAttempt({...scope,contentHash:'b'.repeat(64)},async id=>id===first.attemptId);assert.notEqual(other.attemptId,next.attemptId);
});
