import assert from 'node:assert/strict';
import test from 'node:test';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange;
import {openD1} from './helpers/sqlite-d1.mjs';
import {AccountStudyStore} from '../db/account-study-store.ts';
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';
import {prepareAccountStudyRecord} from '../app/account-study-record-client.ts';
import {quizBody,snapshotBody} from './fixtures/account-study-fixtures.mjs';
import {attempt} from './fixtures/task-event-fixtures.mjs';
import {D1LearningAttemptStore,evaluationFingerprint} from '../src/infrastructure/learning-attempt/index.ts';
import {createAccountStudyApplication} from '../src/application/account-study/index.ts';
import {createAccountStudyHttpHandlers} from '../src/infrastructure/account-study/http.ts';
const scope={userId:'user-a',libraryId:'library-a'},at='2026-09-01T00:01:00.000Z';
async function setup(t) {
  const db=await openD1();t.after(()=>db.sqlite.close());db.sqlite.exec("INSERT INTO learning_accounts(user_id) VALUES ('user-a'),('user-b')");
  const source=new AccountStudyStore(db.binding),store=new D1LearningAttemptStore(db.binding),item=await sealStudyItem(quizBody()),snapshot=await sealStudySnapshot(snapshotBody([item]));
  await source.putSnapshot(scope,{snapshot,items:[item]},0);
  const binding={ownerId:scope.userId,libraryId:scope.libraryId,snapshotId:snapshot.snapshotId,itemKey:item.itemKey,contentHash:item.contentHash,groupId:'group-a',roundId:'round-one'};
  const base={schemaVersion:1,attemptId:'attempt-one',operationId:'checkpoint',binding,expectedRevision:0,updatedAt:at};
  const checkpoint={...base,kind:'checkpoint',answer:'First',parentAttemptId:null,checkpoint:{phase:'answering',position:0,traversed:false,mode:'quiz'}};
  const deps={getAttemptStore:async()=>store,getStudyStore:async()=>source,getAccessStore:async()=>({profile:async()=>({libraryId:'library-a',revision:1})}),now:()=>new Date(at)};
  return {...db,store,source,item,snapshot,base,checkpoint,deps};
}
async function graded(f,attemptId='attempt-one') {
  let row=(await f.store.mutate(scope,{...f.checkpoint,attemptId})).attempt;
  row=(await f.store.mutate(scope,{...f.base,attemptId,operationId:'submit',kind:'submit',expectedRevision:row.revision,answerRevision:row.answerRevision,assistance:'unknown'})).attempt;
  const evaluation={status:'resolved',rating:'good',correct:true,outcome:'correct',source:'deterministic',feedback:'First matches source.',referenceHash:f.item.contentHash};
  evaluation.evaluationHash=await evaluationFingerprint(evaluation);
  return (await f.store.mutate(scope,{...f.base,attemptId,operationId:'evaluate',kind:'evaluate',expectedRevision:row.revision,answerRevision:row.answerRevision,evaluation})).attempt;
}
test('two devices have CAS conflict, receipt recovery, owner isolation and exact source registration',async t=>{
  const f=await setup(t),two=new D1LearningAttemptStore(f.binding);
  const [a,b]=await Promise.all([f.store.mutate(scope,f.checkpoint),two.mutate(scope,{...f.checkpoint,operationId:'device-two',answer:'Other'})]);
  assert.deepEqual([a.status,b.status].sort(),['accepted','conflict']);const winning=a.status==='accepted'?f.checkpoint:{...f.checkpoint,operationId:'device-two',answer:'Other'};assert.equal([a,b].find(receipt=>receipt.status==='accepted').durable,true);assert.equal([a,b].find(receipt=>receipt.status==='conflict').durable,false);
  const repeat=await two.mutate(scope,winning);assert.equal(repeat.status,'duplicate');assert.equal(repeat.durable,true);
  assert.equal(await two.read({userId:'user-b',libraryId:'library-a'},'attempt-one'),null);
  assert.deepEqual(await two.list({userId:'user-a',libraryId:'other'}),[]);
  await assert.rejects(two.mutate(scope,{...f.checkpoint,attemptId:'forged',binding:{...f.base.binding,contentHash:'b'.repeat(64)}}),/source-not-registered/);
  await assert.rejects(two.mutate(scope,{...f.checkpoint,binding:{...f.base.binding,ownerId:'user-b'}}),/scope-mismatch/);
});
test('formal claims freeze time and grade; duplicate logical attempts and premature links cannot overwrite',async t=>{
  const f=await setup(t),row=await graded(f),claim={...f.base,operationId:'claim',kind:'claim-formal',expectedRevision:row.revision,eventId:'event-one',occurredAt:at,evaluationHash:row.evaluation.evaluationHash,rating:'good'};
  assert.equal((await f.store.mutate(scope,claim)).durable,true);
  assert.equal((await f.store.mutate(scope,claim)).status,'duplicate');
  assert.equal((await f.store.mutate(scope,{...claim,occurredAt:'2026-09-01T00:02:00Z'})).status,'conflict');
  await assert.rejects(f.store.mutate(scope,{...f.base,operationId:'link',kind:'link-formal',expectedRevision:4,eventId:'event-one',coreHash:'a'.repeat(64)}),/not-durable/);
  const other=await graded(f,'another-attempt');
  await assert.rejects(f.store.mutate(scope,{...claim,attemptId:'another-attempt',expectedRevision:other.revision,eventId:'other-event'}),/event-conflict/);
  const event=await attempt('event-one',at,0,3,true,{domain:'differential-review',item:{kind:'due',key:f.item.itemKey}});
  const record=await prepareAccountStudyRecord({workspaceId:'account:nonword-production-link',bundle:{snapshot:f.snapshot,items:[f.item]},event,originDeviceId:'device-a',practiceMode:'quiz'});
  assert.notEqual(record.attemptId,event.eventId);assert.notEqual(record.roundId,f.base.binding.roundId);
  assert.equal((await f.source.appendRecord(scope,record)).durable,true);
  const linked=await f.store.mutate(scope,{...f.base,operationId:'link',kind:'link-formal',expectedRevision:4,eventId:'event-one',coreHash:event.coreHash});
  assert.equal(linked.attempt.formal.status,'linked');assert.deepEqual(linked.attempt.formal.authoritativeRecord,{attemptId:record.attemptId,roundId:record.roundId});assert.equal(f.sqlite.prepare('SELECT count(*) n FROM account_study_records').get().n,1);
});
test('original reference survives a new source head, evaluation fingerprint and snapshot membership reject substitution',async t=>{
  const f=await setup(t);await f.store.mutate(scope,f.checkpoint);
  const newer=await sealStudyItem(quizBody({practice:{...quizBody().practice,prompt:'Changed question.',answer:1}}));
  await f.source.putSnapshot(scope,{snapshot:await sealStudySnapshot(snapshotBody([newer],{snapshotId:'snapshot-new',revision:2})),items:[newer]},1);
  const app=createAccountStudyApplication(f.deps),result=await app.post({action:'attempt-reference',attemptId:'attempt-one'}, {principal:{kind:'browser',userId:'user-a'}},new AbortController().signal);
  assert.equal(result.value.item.contentHash,f.item.contentHash);assert.notEqual(result.value.item.contentHash,newer.contentHash);
});
test('actual HTTP rejects unauthenticated/foreign owner/library, unknown fields, old capability and corrupt evaluation',async t=>{
  const f=await setup(t),handlers=(userId='user-a',deps=f.deps)=>createAccountStudyHttpHandlers({...deps,enabled:true,getBrowserUser:async()=>userId?{userId}:null});
  const req=(action,body={})=>new Request('https://test.invalid/api/account-study',{method:'POST',headers:{Origin:'https://test.invalid','Content-Type':'application/json'},body:JSON.stringify({action,...body})});
  assert.equal((await handlers(null).POST(req('attempt-mutate',{mutation:f.checkpoint}))).status,401);
  assert.equal((await handlers().POST(req('attempt-mutate',{mutation:f.checkpoint,expectedUserId:'user-b'}))).status,403);
  assert.equal((await handlers().POST(req('attempt-mutate',{mutation:f.checkpoint,libraryId:'other'}))).status,403);
  assert.equal((await handlers().POST(req('attempt-mutate',{mutation:{...f.checkpoint,rawPath:'C:/secret'}}))).status,400);
  assert.equal((await handlers('user-a',{...f.deps,getAttemptStore:undefined}).POST(req('attempt-read',{attemptId:'a'}))).status,409);
  assert.equal((await handlers().POST(req('attempt-mutate',{mutation:f.checkpoint}))).status,200);
  const row=await f.store.read(scope,'attempt-one');
  await f.store.mutate(scope,{...f.base,kind:'submit',operationId:'s',expectedRevision:row.revision,answerRevision:row.answerRevision,assistance:'unknown'});
  const bad={...f.base,kind:'evaluate',operationId:'bad',expectedRevision:2,answerRevision:1,evaluation:{status:'resolved',rating:'good',correct:true,outcome:'correct',source:'model',feedback:'Synthetic',referenceHash:f.item.contentHash,evaluationHash:'b'.repeat(64)}};
  assert.equal((await handlers().POST(req('attempt-mutate',{mutation:bad}))).status,409);
  assert.equal((await f.store.read(scope,'attempt-one')).evaluation.status,'pending');
});
