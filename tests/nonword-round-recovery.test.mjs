import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {openD1} from './helpers/sqlite-d1.mjs';
import {AccountStudyStore} from '../db/account-study-store.ts';
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';
import {quizBody,snapshotBody} from './fixtures/account-study-fixtures.mjs';
import {createAccountStudyHttpHandlers} from '../src/infrastructure/account-study/http.ts';
import {createLocalAttemptRepository,createAccountAttemptClient,D1LearningAttemptStore,attemptFingerprint,evaluationFingerprint} from '../src/infrastructure/learning-attempt/index.ts';
import {createNonWordRoundSession,createNonWordSession} from '../src/application/nonword-study/index.ts';
import {createNonWordRoundRuntime,createNonWordRuntime} from '../src/infrastructure/nonword-study/index.ts';
globalThis.indexedDB=new IDBFactory();
let serial=0,deviceQueue=Promise.resolve();
function deviceRepository(scope) {
  const factory=new IDBFactory(),actual=createLocalAttemptRepository({userId:scope.ownerId,libraryId:scope.libraryId}),repository={};
  for(const [name,method] of Object.entries(actual))repository[name]=(...args)=>{
    const operation=deviceQueue.then(async()=>{const previous=globalThis.indexedDB;globalThis.indexedDB=factory;try{return await method.apply(actual,args);}finally{globalThis.indexedDB=previous;}});
    deviceQueue=operation.catch(()=>{});return operation;
  };
  return {factory,repository};
}
const traversal=(extra={})=>({correctKeys:[],wrongKeys:[],awaitingReviewKeys:[],skippedKeys:[],...extra});
async function fixture(t) {
  const db=await openD1();t.after(()=>db.sqlite.close());const owner=`round-owner-${serial++}`;
  db.sqlite.prepare('INSERT INTO learning_accounts(user_id) VALUES (?)').run(owner);
  const study=new AccountStudyStore(db.binding),store=new D1LearningAttemptStore(db.binding),items=[];
  for(let i=0;i<3;i++)items.push(await sealStudyItem(quizBody({itemKey:`q-${i}`,practice:{...quizBody().practice,itemId:`q-${i}`,prompt:`Synthetic question ${i}.`}})));
  const snapshot=await sealStudySnapshot(snapshotBody(items));await study.putSnapshot({userId:owner,libraryId:'library-a'},{snapshot,items},0);
  const scope={ownerId:owner,libraryId:'library-a',groupId:'course-group',day:'2026-10-05',cloud:true},members=items.map(item=>({itemKey:item.itemKey,snapshotId:snapshot.snapshotId,contentHash:item.contentHash,kind:'practice',mode:'quiz'}));
  const handlers=createAccountStudyHttpHandlers({enabled:true,getBrowserUser:async()=>({userId:owner}),getAccessStore:async()=>({profile:async()=>({libraryId:'library-a',revision:1})}),getStudyStore:async()=>study,getAttemptStore:async()=>store});
  const fetcher=async(url,init)=>{const headers=new Headers(init.headers);headers.set('Origin','https://round.invalid');return handlers.POST(new Request(new URL(url,'https://round.invalid'),{...init,headers}));};
  const cloud=createAccountAttemptClient({ownerId:owner,libraryId:'library-a',fetcher});
  return {...db,scope,members,items,cloud,store};
}
test('fresh device restores accepted wrong/pending cursor through real HTTP and D1 without creating a grade',async t=>{
  const f=await fixture(t),a=deviceRepository(f.scope),first=await createNonWordRoundRuntime({scope:f.scope,members:f.members,repository:a.repository,cloud:f.cloud});
  await first.synchronize();await first.saveCursor({currentItemKey:'q-2',traversal:traversal({wrongKeys:['q-0'],awaitingReviewKeys:['q-1']})});await first.synchronize();
  const b=deviceRepository(f.scope),restored=await createNonWordRoundRuntime({scope:f.scope,members:f.members,repository:b.repository,cloud:f.cloud});await restored.synchronize();
  const state=await restored.read();assert.equal(state.currentItemKey,'q-2');assert.deepEqual(state.traversal.wrongKeys,['q-0']);assert.deepEqual(state.traversal.awaitingReviewKeys,['q-1']);assert.deepEqual(state.traversal.correctKeys,[]);assert.equal(state.runId,(await first.read()).runId);
  const anchor=await f.store.read({userId:f.scope.ownerId,libraryId:f.scope.libraryId},state.anchorAttemptId);assert.equal(anchor.answer,'');assert.equal(anchor.submitted,null);assert.equal(anchor.formal,null);assert.equal(anchor.evaluation.status,'pending');assert.equal(f.sqlite.prepare('SELECT count(*) n FROM account_study_records').get().n,0);
});
test('initial offline run is deterministic on two devices and every source version participates in its identity',async()=>{
  const scope={ownerId:`initial-${serial++}`,libraryId:'l',groupId:'g',day:'2026-10-05',cloud:false},members=[{itemKey:'a',snapshotId:'s',contentHash:'a'.repeat(64),kind:'practice',mode:'recall'},{itemKey:'b',snapshotId:'s',contentHash:'b'.repeat(64),kind:'practice',mode:'quiz'}];
  const a=await createNonWordRoundRuntime({scope,members,repository:deviceRepository(scope).repository}),b=await createNonWordRoundRuntime({scope,members,repository:deviceRepository(scope).repository});
  assert.equal((await a.read()).runId,(await b.read()).runId);assert.equal((await a.read()).roundId,(await b.read()).roundId);
  const changed=await createNonWordRoundRuntime({scope,members:[members[0],{...members[1],contentHash:'c'.repeat(64)}],repository:a.repository});
  assert.notEqual((await changed.read()).anchorAttemptId,(await a.read()).anchorAttemptId);assert.notEqual((await changed.read()).sourceHash,(await a.read()).sourceHash);
});
test('confirmed normal restart creates new first identity and preserves every prior attempt',async t=>{
  const f=await fixture(t),device=deviceRepository(f.scope),round=await createNonWordRoundRuntime({scope:f.scope,members:f.members,repository:device.repository,cloud:f.cloud});await round.synchronize();
  const before=await round.read();await assert.rejects(round.startNewRound({restartConfirmed:false}),/not-confirmed/);assert.equal((await round.read()).runId,before.runId);
  const previous=globalThis.indexedDB;globalThis.indexedDB=device.factory;
  try {
    const base={workspaceId:`account:${f.scope.ownerId}`,ownerId:f.scope.ownerId,libraryId:f.scope.libraryId,snapshotId:f.members[0].snapshotId,itemKey:'q-0',contentHash:f.members[0].contentHash,groupId:f.scope.groupId,cloud:false};
    const old=await createNonWordRuntime({...base,roundId:before.roundId},'quiz');await old.session.submit('Old first selection.');await old.session.assess({status:'incorrect',source:'deterministic',rating:'again',explanation:'Old wrong result.'});const identity=await old.session.reserve('again');
    const next=await round.startNewRound({restartConfirmed:true});await round.synchronize();
    assert.notEqual(next.runId,before.runId);assert.notEqual(next.roundId,before.roundId);assert.deepEqual(next.traversal,traversal());
    const fresh=await createNonWordRuntime({...base,roundId:next.roundId},'quiz');await fresh.session.submit('New independent selection.');await fresh.session.assess({status:'incorrect',source:'deterministic',rating:'again',explanation:'New wrong result.'});const newIdentity=await fresh.session.reserve('again');
    assert.notEqual(newIdentity.eventId,identity.eventId);assert.equal((await old.repository.read(old.session.snapshot().attemptId)).submitted.answer,'Old first selection.');assert.equal(fresh.session.snapshot().submitted.answer,'New independent selection.');
  } finally {globalThis.indexedDB=previous;}
});
test('group cursor updates leave an exact paused guided child and its raw draft unchanged',async t=>{
  const f=await fixture(t),device=deviceRepository(f.scope),round=await createNonWordRoundRuntime({scope:f.scope,members:f.members,repository:device.repository,cloud:f.cloud});await round.synchronize();
  const binding={ownerId:f.scope.ownerId,libraryId:f.scope.libraryId,snapshotId:f.members[2].snapshotId,itemKey:'q-2',contentHash:f.members[2].contentHash,groupId:await attemptFingerprint(f.scope.groupId),roundId:(await round.read()).roundId};
  const child=createNonWordSession({repository:device.repository,binding,attemptId:'paused-guided',formalEventId:'unused',mode:'recall',purpose:'guided',now:()=>new Date().toISOString(),newId:()=>crypto.randomUUID(),fingerprint:attemptFingerprint,evaluationFingerprint});
  await child.open();await child.save('My paused guided draft.',{answer:'My paused guided draft.'});await child.updateView({view:{purpose:'guided',instanceId:'paused-guided',lessonStep:'guided',paused:true,referenceSeen:true}});
  const before=await device.repository.read('paused-guided');await round.saveCursor({currentItemKey:'q-2',traversal:traversal({wrongKeys:['q-0'],awaitingReviewKeys:['q-1']})});await round.synchronize();
  assert.deepEqual(await device.repository.read('paused-guided'),before);assert.equal((await round.read()).currentItemKey,'q-2');
});
test('two-device cursor CAS preserves the losing branch and blocks further navigation until reconciliation',async t=>{
  const f=await fixture(t),a=await createNonWordRoundRuntime({scope:f.scope,members:f.members,repository:deviceRepository(f.scope).repository,cloud:f.cloud});await a.synchronize();
  const b=await createNonWordRoundRuntime({scope:f.scope,members:f.members,repository:deviceRepository(f.scope).repository,cloud:f.cloud});await b.synchronize();
  await a.saveCursor({currentItemKey:'q-2',traversal:traversal({wrongKeys:['q-0']})});await a.synchronize();
  await b.saveCursor({currentItemKey:'q-1',traversal:traversal({awaitingReviewKeys:['q-0']})});await assert.rejects(b.synchronize(),/round-conflict/);
  assert.equal(await b.status(),'cloud-conflict');assert.equal((await b.read()).currentItemKey,'q-1');assert.equal((await a.read()).currentItemKey,'q-2');assert.ok((await b.repository.pending()).length>0);
  await assert.rejects(b.saveCursor({currentItemKey:'q-2',traversal:traversal()}),/round-conflict/);assert.equal((await b.read()).currentItemKey,'q-1');
});
test('cursor local failure cannot advance and a lost receipt recovers the same accepted operation',async()=>{
  const scope={ownerId:`failure-${serial++}`,libraryId:'l',groupId:'g',day:'2026-10-05',cloud:false},members=[{itemKey:'a',snapshotId:'s',contentHash:'a'.repeat(64),kind:'practice',mode:'quiz'}],repository=createLocalAttemptRepository({userId:scope.ownerId,libraryId:'l'});let fail=false,lost=false;
  const session=createNonWordRoundSession({scope,members,repository:{read:repository.read,status:repository.status,mutate:async mutation=>{if(fail)throw Error('local disk failed');const receipt=await repository.mutate(mutation);if(lost){lost=false;throw Error('local receipt lost');}return receipt;}},now:()=>new Date().toISOString(),newId:()=>crypto.randomUUID(),fingerprint:attemptFingerprint});
  const original=await session.open();fail=true;await assert.rejects(session.saveCursor({currentItemKey:null,traversal:traversal({wrongKeys:['a']})}),/disk failed/);assert.equal((await session.read()).currentItemKey,'a');
  fail=false;lost=true;const completed=await session.saveCursor({currentItemKey:null,traversal:traversal({wrongKeys:['a']})});assert.equal(completed.currentItemKey,null);assert.deepEqual(completed.traversal.wrongKeys,['a']);assert.equal(completed.runId,original.runId);
});
test('ordinary cursor save waits for local durability and not a hanging cloud transport',async()=>{
  const scope={ownerId:`nonblocking-${serial++}`,libraryId:'l',groupId:'g',day:'2026-10-05',cloud:true},members=[{itemKey:'a',snapshotId:'s',contentHash:'a'.repeat(64),kind:'practice',mode:'quiz'}];let release;
  const gate=new Promise(resolve=>{release=resolve;}),cloud={read:async()=>null,mutate:async()=>{await gate;throw Error('offline');}};
  const runtime=await createNonWordRoundRuntime({scope,members,cloud});
  const saved=await runtime.saveCursor({currentItemKey:null,traversal:traversal({awaitingReviewKeys:['a']})});assert.equal(saved.currentItemKey,null);assert.equal(await runtime.status(),'device-only');assert.ok((await runtime.repository.pending()).length>0);release();await runtime.synchronize();
});
test('500 ordered members are preserved, traversal is compact, and unknown versions/overlaps fail explicitly',async()=>{
  const scope={ownerId:`bounds-${serial++}`,libraryId:'l',groupId:'g',day:'2026-10-05',cloud:false},members=Array.from({length:500},(_,i)=>({itemKey:`q-${i}`,snapshotId:'s',contentHash:'a'.repeat(64),kind:'practice',mode:'quiz'}));
  const runtime=await createNonWordRoundRuntime({scope,members});assert.equal((await runtime.read()).members.length,500);
  const result=await runtime.saveCursor({currentItemKey:null,traversal:traversal({wrongKeys:members.map(member=>member.itemKey)})});assert.equal(result.traversal.wrongKeys.length,500);
  const row=await runtime.repository.read(runtime.anchorAttemptId);assert.ok(row.checkpoint.pluginFields.notes.length<5000);assert.equal(row.submitted,null);assert.equal(row.formal,null);
  await assert.rejects(runtime.saveCursor({currentItemKey:'q-0',traversal:traversal({wrongKeys:['q-0'],awaitingReviewKeys:['q-0']})}),/overlapping/);
  await assert.rejects(runtime.saveCursor({currentItemKey:'outside-source',traversal:traversal()}),/unknown-item/);
  await assert.rejects(runtime.session.validateSnapshot({...row,checkpoint:{...row.checkpoint,pluginFields:{notes:JSON.stringify({...JSON.parse(row.checkpoint.pluginFields.notes),schemaVersion:99})}}}),/version/);
  await assert.rejects(createNonWordRoundRuntime({scope,members:[...members,{...members[0],itemKey:'q-501'}]}),/member-limit/);
});
test('word sources, including word display overrides, never receive a round anchor',async()=>{
  const scope={ownerId:`word-${serial++}`,libraryId:'l',groupId:'g',day:'2026-10-05',cloud:false},repository=createLocalAttemptRepository({userId:scope.ownerId,libraryId:'l'});
  const result=await createNonWordRoundRuntime({scope,members:[{itemKey:'word:tree',snapshotId:'s',contentHash:'a'.repeat(64),kind:'word',mode:'quiz'}],repository});assert.equal(result,null);assert.equal(await createNonWordRoundRuntime({scope,members:[],repository}),null);assert.deepEqual(await repository.list(),[]);
});
test('absent anchor accepts a validated existing UI projection seed while every later open keeps the accepted cursor',async t=>{
  const f=await fixture(t),a=deviceRepository(f.scope),seed={currentItemKey:'q-1',traversal:traversal({correctKeys:['q-0']})};
  const current=await createNonWordRoundRuntime({scope:f.scope,members:f.members,initialCursor:seed,repository:a.repository,cloud:f.cloud});await current.synchronize();
  const accepted=await current.read();assert.equal(accepted.currentItemKey,'q-1');assert.deepEqual(accepted.traversal.correctKeys,['q-0']);
  seed.currentItemKey='q-2';seed.traversal.correctKeys.push('q-1');assert.equal((await current.read()).currentItemKey,'q-1');assert.deepEqual((await current.read()).traversal.correctKeys,['q-0']);
  const restored=await createNonWordRoundRuntime({scope:f.scope,members:f.members,initialCursor:{currentItemKey:'q-0',traversal:traversal()},repository:deviceRepository(f.scope).repository,cloud:f.cloud});
  assert.equal((await restored.read()).currentItemKey,'q-1');assert.deepEqual((await restored.read()).traversal.correctKeys,['q-0']);assert.equal((await restored.read()).runId,accepted.runId);
  const anchor=await a.repository.read(accepted.anchorAttemptId);assert.equal(anchor.submitted,null);assert.equal(anchor.formal,null);assert.equal(anchor.answer,'');assert.equal(f.sqlite.prepare('SELECT count(*) n FROM account_study_records').get().n,0);
});
