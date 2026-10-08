import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {openD1} from './helpers/sqlite-d1.mjs';
import {AccountStudyStore} from '../db/account-study-store.ts';
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';
import {quizBody,snapshotBody} from './fixtures/account-study-fixtures.mjs';
import {createAccountStudyHttpHandlers} from '../src/infrastructure/account-study/http.ts';
import {createLocalAttemptRepository,createAccountAttemptClient,D1LearningAttemptStore,attemptFingerprint,evaluationFingerprint} from '../src/infrastructure/learning-attempt/index.ts';
import {createNonWordSession} from '../src/application/nonword-study/index.ts';
import {createContinuationCoordinator} from '../src/application/nonword-study/continuation.ts';
import {createNonWordRoundRuntime} from '../src/infrastructure/nonword-study/index.ts';

let ordinal=0,deviceQueue=Promise.resolve();
const at='2026-10-07T00:00:00.000Z';
// The real local repository reads the browser's IndexedDB global. Serialize
// factory ownership to model isolated devices without copying their state.
function device(scope){
  const factory=new IDBFactory(),actual=createLocalAttemptRepository({userId:scope.ownerId,libraryId:scope.libraryId}),repository={};
  for(const [name,method] of Object.entries(actual))repository[name]=(...args)=>{
    const operation=deviceQueue.then(async()=>{
      const previous=globalThis.indexedDB;globalThis.indexedDB=factory;
      try{return await method.apply(actual,args);}finally{globalThis.indexedDB=previous;}
    });
    deviceQueue=operation.catch(()=>{});return operation;
  };
  return {repository};
}
async function fixture(t){
  const db=await openD1(),ownerId=`continuation-cloud-${ordinal++}`;
  t.after(()=>db.sqlite.close());
  db.sqlite.prepare('INSERT INTO learning_accounts(user_id) VALUES (?)').run(ownerId);
  const study=new AccountStudyStore(db.binding),store=new D1LearningAttemptStore(db.binding),items=[];
  for(const key of ['cloud-a','cloud-b'])items.push(await sealStudyItem(quizBody({itemKey:`practice:${key}`,
    practice:{...quizBody().practice,itemId:key,prompt:`Isolated original ${key}.`}})));
  const snapshot=await sealStudySnapshot(snapshotBody(items));
  await study.putSnapshot({userId:ownerId,libraryId:'library-a'},{snapshot,items},0);
  const scope={ownerId,libraryId:'library-a',groupId:'original-course-group',day:'2026-10-07',cloud:true};
  const members=items.map(item=>({itemKey:item.itemKey,snapshotId:snapshot.snapshotId,contentHash:item.contentHash,kind:'practice',mode:'quiz'}));
  const handlers=createAccountStudyHttpHandlers({enabled:true,getBrowserUser:async()=>({userId:ownerId}),
    getAccessStore:async()=>({profile:async()=>({libraryId:scope.libraryId,revision:1})}),
    getStudyStore:async()=>study,getAttemptStore:async()=>store});
  const fetcher=async(url,init)=>{
    const headers=new Headers(init.headers);headers.set('Origin','https://continuation.invalid');
    return handlers.POST(new Request(new URL(url,'https://continuation.invalid'),{...init,headers}));
  };
  const actualCloud=createAccountAttemptClient({ownerId,libraryId:scope.libraryId,fetcher});
  const reads=[];let online=true,listCalls=0;
  const cloud={...actualCloud,
    read:async id=>{reads.push(id);if(!online)throw Error('isolated offline transport');return actualCloud.read(id);},
    list:async()=>{listCalls++;assert.fail('Continuation recovery must use exact IDs, never the capped global list');}};
  const options={scope,members,attemptGroupId:scope.groupId,cloud};
  const source=device(scope),round=await createNonWordRoundRuntime({...options,repository:source.repository});
  await round.synchronize();
  const initial=await round.read(),member=members[0];
  const binding={ownerId,libraryId:scope.libraryId,snapshotId:member.snapshotId,itemKey:member.itemKey,contentHash:member.contentHash,
    groupId:await attemptFingerprint(scope.groupId),roundId:await attemptFingerprint(initial.roundId)};
  const firstId=`nw:${await attemptFingerprint([binding,'quiz','first',null,null])}`;
  const first=createNonWordSession({repository:source.repository,binding,attemptId:firstId,formalEventId:'unused-formal-event',
    mode:'quiz',purpose:'first',now:()=>at,newId:()=>crypto.randomUUID(),fingerprint:attemptFingerprint,evaluationFingerprint});
  await first.open();
  const coordinator=createContinuationCoordinator({repository:source.repository,fingerprint:attemptFingerprint,
    now:()=>at,newId:()=>crypto.randomUUID()});
  const group={anchorAttemptId:initial.anchorAttemptId,sourceHash:initial.sourceHash,runId:initial.runId,roundId:initial.roundId};
  const frozen=await coordinator.associate(first.snapshot(),group);
  await first.submit('["original-selection"]','unknown');await first.pending('offline','Original answer retained.');
  await first.traversePending();await coordinator.append(first.snapshot(),frozen);
  await round.synchronize();
  const continuationId=await coordinator.storage.idFor('continue',binding),reopenId=await coordinator.storage.idFor('reopen',binding);
  return {...db,scope,members,options,source,round,first,firstId,initial,continuationId,reopenId,reads,cloud,actualCloud,
    listCalls:()=>listCalls,offline:()=>{online=false;}};
}

test('cold device restores an out-of-group pending continuation through real HTTP/D1 exact IDs with list forbidden',async t=>{
  const f=await fixture(t),original=f.first.snapshot(),rawAnchor=await f.actualCloud.read(f.initial.anchorAttemptId);
  assert.equal(JSON.parse(rawAnchor.checkpoint.pluginFields.notes).currentIndex,0,'The queue did not directly write the original cursor');
  assert.ok(await f.actualCloud.read(f.continuationId));f.reads.length=0;
  const target=device(f.scope),restored=await createNonWordRoundRuntime({...f.options,repository:target.repository});
  await restored.synchronize();const state=await restored.read();
  assert.equal(state.currentItemKey,f.members[1].itemKey);
  assert.deepEqual(state.traversal.awaitingReviewKeys,[f.members[0].itemKey]);
  assert.ok(f.reads.includes(f.continuationId));assert.ok(f.reads.includes(f.firstId));assert.equal(f.listCalls(),0);
  assert.deepEqual((await target.repository.read(f.firstId)).submitted,original.submitted);
  assert.equal((await target.repository.read(f.firstId)).formal,null);
  const before={rows:await target.repository.list(),outbox:await target.repository.pending()};
  await restored.read();await restored.read();
  assert.deepEqual({rows:await target.repository.list(),outbox:await target.repository.pending()},before,'Public projection remains read-only');
  assert.equal(f.sqlite.prepare('SELECT count(*) n FROM account_study_records').get().n,0);
});

test('cold device hydrates the acknowledged reopen before projecting its marked anchor',async t=>{
  const f=await fixture(t);await f.round.reopenPendingWithAck();await f.round.synchronize();
  const server=await f.actualCloud.read(f.initial.anchorAttemptId);
  assert.ok(server.checkpoint.view.instanceId.startsWith('nw-reopen:'));
  assert.ok(await f.actualCloud.read(f.reopenId));f.reads.length=0;
  const target=device(f.scope),restored=await createNonWordRoundRuntime({...f.options,repository:target.repository});
  await restored.synchronize();const state=await restored.read();
  assert.equal(state.currentItemKey,f.members[0].itemKey);assert.deepEqual(state.traversal.awaitingReviewKeys,[]);
  assert.ok(f.reads.includes(f.reopenId));assert.ok(f.reads.includes(f.continuationId));assert.ok(f.reads.includes(f.firstId));
  assert.equal(f.listCalls(),0);assert.equal((await target.repository.read(f.firstId)).checkpoint.traversed,true);
  const before=await target.repository.list();await restored.read();assert.deepEqual(await target.repository.list(),before);
});

test('ordinary offline refresh preserves the existing exact-scoped local continuation cache',async t=>{
  const f=await fixture(t),before={rows:await f.source.repository.list(),outbox:await f.source.repository.pending()};
  f.offline();const state=await f.round.refresh();
  assert.equal(state.currentItemKey,f.members[1].itemKey);assert.deepEqual(state.traversal.awaitingReviewKeys,[f.members[0].itemKey]);
  assert.deepEqual({rows:await f.source.repository.list(),outbox:await f.source.repository.pending()},before);
  assert.equal(f.listCalls(),0);assert.equal(f.first.snapshot().formal,null);
});

test('wrong source metadata from an exact response fails closed before entering the fresh device cache',async t=>{
  const f=await fixture(t),target=device(f.scope);
  const cloud={...f.cloud,read:async id=>{
    const value=await f.cloud.read(id);
    return id===f.continuationId?{...value,binding:{...value.binding,contentHash:'f'.repeat(64)}}:value;
  }};
  await assert.rejects(createNonWordRoundRuntime({...f.options,repository:target.repository,cloud}),/continuation-binding/);
  assert.equal(await target.repository.read(f.continuationId),null);
  assert.equal(await target.repository.read(f.firstId),null);
  assert.equal(f.listCalls(),0);
});
