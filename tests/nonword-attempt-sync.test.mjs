import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory} from 'fake-indexeddb';
import {openD1} from './helpers/sqlite-d1.mjs';
import {AccountStudyStore} from '../db/account-study-store.ts';
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';
import {quizBody,snapshotBody} from './fixtures/account-study-fixtures.mjs';
import {D1LearningAttemptStore,createLocalAttemptRepository,createAccountAttemptClient,evaluationFingerprint} from '../src/infrastructure/learning-attempt/index.ts';
import {createAccountStudyHttpHandlers} from '../src/infrastructure/account-study/http.ts';
globalThis.indexedDB=new IDBFactory();
let serial=0;
async function setup(t) {
  const db=await openD1();t.after(()=>db.sqlite.close());
  const scope={userId:`sync-owner-${serial++}`,libraryId:'library-a'};
  db.sqlite.prepare('INSERT INTO learning_accounts(user_id) VALUES (?)').run(scope.userId);
  const source=new AccountStudyStore(db.binding),store=new D1LearningAttemptStore(db.binding),item=await sealStudyItem(quizBody()),snapshot=await sealStudySnapshot(snapshotBody([item]));
  await source.putSnapshot(scope,{snapshot,items:[item]},0);
  const handlers=createAccountStudyHttpHandlers({enabled:true,getBrowserUser:async()=>({userId:scope.userId}),getAccessStore:async()=>({profile:async()=>({libraryId:scope.libraryId,revision:1})}),getStudyStore:async()=>source,getAttemptStore:async()=>store});
  const calls=[];
  const fetcher=async(url,init)=>{const headers=new Headers(init.headers);headers.set('Origin','https://sync.invalid');calls.push(JSON.parse(init.body).mutation);
    return handlers.POST(new Request(new URL(url,'https://sync.invalid'),{...init,headers}));};
  const cloud=createAccountAttemptClient({ownerId:scope.userId,libraryId:scope.libraryId,fetcher}),repo=createLocalAttemptRepository(scope);
  const binding={ownerId:scope.userId,libraryId:scope.libraryId,snapshotId:snapshot.snapshotId,itemKey:item.itemKey,contentHash:item.contentHash,groupId:'group',roundId:'round'};
  const base={schemaVersion:1,attemptId:'parent',operationId:'draft',binding,expectedRevision:0,updatedAt:'2026-10-05T00:00:00Z'};
  const checkpoint={...base,kind:'checkpoint',answer:'Original first work.',parentAttemptId:null,checkpoint:{phase:'answering',position:0,traversed:false,mode:'quiz',purpose:'first'}};
  return {...db,scope,store,repo,cloud,calls,base,checkpoint,item};
}
async function submit(repo,checkpoint) {
  await repo.mutate(checkpoint);
  const {answer,checkpoint:ignored,parentAttemptId,...base}=checkpoint;void answer;void ignored;void parentAttemptId;
  await repo.mutate({...base,kind:'submit',operationId:'submit',expectedRevision:1,answerRevision:1,assistance:'unknown'});
}
test('real local outbox sends parent submit before lower-revision child checkpoint through production HTTP and D1',async t=>{
  const f=await setup(t),parent={...f.checkpoint,attemptId:'z-parent'};
  await submit(f.repo,parent);
  await submit(f.repo,{...f.checkpoint,attemptId:'a-child',answer:'Separate guided repair.',parentAttemptId:'z-parent',checkpoint:{...f.checkpoint.checkpoint,purpose:'remediation'}});
  const receipt=await f.repo.sync(f.cloud);
  assert.equal(receipt.acked,4);assert.equal(receipt.pending,0);assert.equal(receipt.complete,true);assert.equal(receipt.conflict,false);
  assert.deepEqual(f.calls.map(row=>[row.attemptId,row.kind]),[['z-parent','checkpoint'],['z-parent','submit'],['a-child','checkpoint'],['a-child','submit']]);
  assert.equal((await f.store.read(f.scope,'a-child')).parentAttemptId,'z-parent');assert.equal((await f.store.read(f.scope,'z-parent')).submitted.answer,'Original first work.');
});
test('one actual HTTP409 blocks its descendants and preserves raw work while an independent group fully synchronizes',async t=>{
  const f=await setup(t),unregistered={...f.checkpoint,attemptId:'a-bad-parent',binding:{...f.base.binding,contentHash:'b'.repeat(64)}};
  await submit(f.repo,unregistered);
  await submit(f.repo,{...unregistered,attemptId:'b-bad-child',answer:'Child repair remains local.',parentAttemptId:'a-bad-parent',checkpoint:{...unregistered.checkpoint,purpose:'remediation'}});
  await submit(f.repo,{...f.checkpoint,attemptId:'z-independent',binding:{...f.base.binding,groupId:'independent-group'}});
  const result=await f.repo.sync(f.cloud);
  assert.equal(result.conflict,true);assert.equal(result.acked,2);assert.equal(result.pending,4);assert.equal(result.complete,false);
  assert.deepEqual(f.calls.map(row=>row.attemptId),['a-bad-parent','z-independent','z-independent']);
  assert.equal(await f.repo.status('a-bad-parent'),'cloud-conflict');assert.equal(await f.repo.status('b-bad-child'),'cloud-conflict');assert.equal(await f.repo.status('z-independent'),'cloud-acked');
  assert.equal((await f.repo.read('a-bad-parent')).submitted.answer,'Original first work.');assert.equal((await f.repo.read('b-bad-child')).submitted.answer,'Child repair remains local.');
  assert.equal((await f.store.read(f.scope,'z-independent')).submitted.answer,'Original first work.');assert.equal(await f.store.read(f.scope,'b-bad-child'),null);
});
test('a newly queued formal claim during a running sync is included before the queue-complete receipt',async t=>{
  const f=await setup(t);await submit(f.repo,f.checkpoint);
  const evaluation={status:'resolved',rating:'good',correct:true,outcome:'correct',source:'deterministic',feedback:'First matches.',referenceHash:f.item.contentHash};evaluation.evaluationHash=await evaluationFingerprint(evaluation);
  await f.repo.mutate({...f.base,operationId:'evaluate',kind:'evaluate',expectedRevision:2,answerRevision:1,evaluation});
  let start,release;const started=new Promise(resolve=>{start=resolve;}),gate=new Promise(resolve=>{release=resolve;});let first=true;
  const cloud={...f.cloud,mutate:async mutation=>{if(first){first=false;start();await gate;}return f.cloud.mutate(mutation);}};
  const syncing=f.repo.sync(cloud);await started;
  await f.repo.mutate({...f.base,operationId:'claim',kind:'claim-formal',expectedRevision:3,eventId:'new-official',occurredAt:f.base.updatedAt,evaluationHash:evaluation.evaluationHash,rating:'good'});
  release();const result=await syncing;
  assert.equal(result.acked,4);assert.equal(result.pending,0);assert.equal(result.complete,true);assert.equal(await f.repo.status('parent'),'cloud-acked');
  assert.equal((await f.store.read(f.scope,'parent')).formal.eventId,'new-official');assert.equal(f.calls.at(-1).kind,'claim-formal');
});
