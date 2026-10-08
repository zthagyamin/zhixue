import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {studyHash} from '../src/domain/sync/index.ts';
import {fixture} from './fixtures/native-math-fixtures.mjs';
import {createNonWordPendingRuntime} from '../src/infrastructure/nonword-study/pending-runtime.ts';
import {createLocalPracticeEvidenceRepository} from '../src/infrastructure/practice-evidence/local.ts';
globalThis.indexedDB=new IDBFactory();
test('old native math pending uses associated semantic contentHash after current source changes',async()=>{
 const f=await fixture();await f.cache.save(f.capture);await f.cache.bindAttempt(f.attempt.attemptId,f.binding,f.capture.captureId);
 const changed=structuredClone(f.capture);changed.identity.contentHash=changed.item.contentHash='d'.repeat(64);changed.item.practice.prompt='NEW CURRENT SOURCE';const {captureId,...body}=changed;assert.ok(captureId);changed.captureId=await studyHash(body);await f.cache.save(changed);
 const options={ownerId:f.scope.userId,libraryId:f.scope.libraryId,repository:{list:async()=>[f.attempt],read:async()=>f.attempt},parseItem:async()=>{throw Error('not portable');},parseSnapshot:async()=>{throw Error('not portable');},nativeMathReference:row=>f.cache.read(row.binding,row.attemptId)};
 const p=createNonWordPendingRuntime(options),row=await p.loadOriginal(f.attempt.attemptId);
 assert.deepEqual(row.nativeMathCapture,f.capture);assert.equal(row.resumable,true);assert.equal(row.item,null);
});
test('safe readonly evidence listing retains raw steps without source or model authority',async()=>{
 const f=await fixture(),attempt={...f.attempt,submitted:null,formal:null};
 const repo=createLocalPracticeEvidenceRepository({ownerId:f.scope.userId,libraryId:f.scope.libraryId},{readAttempt:async()=>attempt,resolveSource:async()=>({binding:f.binding,calculation:f.support})});
 await repo.mutate({schemaVersion:1,operationId:'step-save',attemptId:attempt.attemptId,binding:f.binding,expectedRevision:0,updatedAt:attempt.updatedAt,kind:'step-input',text:'RAW TWO'});
 const unavailable=createLocalPracticeEvidenceRepository({ownerId:f.scope.userId,libraryId:f.scope.libraryId},{readAttempt:async()=>attempt});
 await assert.rejects(unavailable.read(attempt.attemptId),/source-(binding|unavailable)/);
 assert.equal((await unavailable.listSavedDrafts())[0].calculation.stepInput.text,'RAW TWO');
 const foreign=createLocalPracticeEvidenceRepository({ownerId:f.scope.userId,libraryId:f.scope.libraryId},{readAttempt:async()=>({...attempt,binding:{...f.binding,groupId:'wrong'}})});
 assert.deepEqual(await foreign.listSavedDrafts(),[]);
});
