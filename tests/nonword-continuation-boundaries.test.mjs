import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
import {createNonWordRoundRuntime,createNonWordRuntime} from '../src/infrastructure/nonword-study/index.ts';
import {reopenNonWordPendingRound,continueNonWordRound,createNonWordRoundSession} from '../src/application/nonword-study/index.ts';
import {createLocalAttemptRepository,attemptFingerprint} from '../src/infrastructure/learning-attempt/index.ts';
import {putLocalStudyEvent,getLocalStudyEvent} from '../app/local-study-events.ts';
import {attempt as formalEvent} from './fixtures/task-event-fixtures.mjs';

globalThis.indexedDB=new IDBFactory();
const empty=()=>({correctKeys:[],wrongKeys:[],awaitingReviewKeys:[],skippedKeys:[]});
let serial=0;
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
function deviceRepository(scope){
  const factory=new IDBFactory(),actual=createLocalAttemptRepository({userId:scope.ownerId,libraryId:scope.libraryId}),repository={};
  let queue=Promise.resolve();
  for(const [name,method] of Object.entries(actual)){
    if(typeof method!=='function')continue;
    repository[name]=(...args)=>{
      const operation=queue.then(async()=>{
        const previous=globalThis.indexedDB;globalThis.indexedDB=factory;
        try{return await method.apply(actual,args);}finally{globalThis.indexedDB=previous;}
      });
      queue=operation.catch(()=>{});return operation;
    };
  }
  return repository;
}
function groupOf(cursor){return {anchorAttemptId:cursor.anchorAttemptId,sourceHash:cursor.sourceHash,runId:cursor.runId,roundId:cursor.roundId};}
function note(row){
  const raw=row?.checkpoint.pluginFields?.notes;
  if(typeof raw!=='string')return null;
  try{return JSON.parse(raw);}catch{return null;}
}
async function fixture(patch={}){
  const ownerId=patch.ownerId??`continuation-boundary-${serial++}`,members=['A','B'].map((key,index)=>({itemKey:`practice:${key}`,snapshotId:'local',
    contentHash:index?'b'.repeat(64):patch.firstHash??'a'.repeat(64),kind:'practice',mode:'recall'}));
  const raw={workspaceId:`local:${ownerId}`,ownerId,libraryId:patch.libraryId??`local-vault:${'c'.repeat(64)}`,groupId:'original-course-group',
    roundId:'page-round',day:'2026-10-07',cloud:false,members};
  const repository=createLocalAttemptRepository({userId:raw.ownerId,libraryId:raw.libraryId}),read=repository.read,list=repository.list,mutate=repository.mutate;
  const reads=[],writes=[];
  repository.read=id=>{reads.push(id);return read(id);};
  repository.mutate=mutation=>{writes.push(structuredClone(mutation));return mutate(mutation);};
  const options={scope:{ownerId:raw.ownerId,libraryId:raw.libraryId,groupId:JSON.stringify([raw.groupId,raw.roundId]),day:raw.day,cloud:false},
    members,repository,attemptGroupId:raw.groupId};
  const round=await createNonWordRoundRuntime(options),initial=await round.read();
  async function actor(index=0,actorOptions={}){
    const cursor=await round.read(),member=members[index],scope={...raw,snapshotId:member.snapshotId,itemKey:member.itemKey,contentHash:member.contentHash,roundId:cursor.roundId};
    return createNonWordRuntime(scope,'recall',{navigationGroup:groupOf(cursor),...actorOptions,verifyFormalEvent:async id=>{
      const record=await getLocalStudyEvent(scope.workspaceId,id);if(!record)return null;
      return {eventId:id,coreHash:record.event.coreHash,itemKey:record.event.item.key,contentHash:scope.contentHash,snapshotId:scope.snapshotId,
        reviewedAt:record.event.scheduling.reviewedAt,rating:record.event.attempt.rating};
    }});
  }
  async function rows(){return list();}
  async function saved(){return {rows:await rows(),outbox:await repository.pending(),writes:writes.length};}
  async function pure(work){const before=await saved(),value=await work();assert.deepEqual(await saved(),before,'read must not write original, internal receipts, cursor or outbox');return value;}
  async function continuation(id){return (await rows()).map(row=>({row,value:note(row)})).find(entry=>entry.value?.kind==='nonword-continuation'&&entry.value.firstAttemptId===id);}
  return {raw,members,repository,reads,writes,options,round,initial,actor,rows,saved,pure,continuation};
}
async function submitPending(actor,answer='Immutable original answer.'){
  await actor.session.submit(answer,'unknown');await actor.session.pending('offline','Synthetic offline result; original retained.');
}
async function expectPendingNext(f,round=f.round){
  const state=await f.pure(()=>round.read());assert.equal(state.currentItemKey,f.members[1].itemKey);
  assert.deepEqual(state.traversal,{...empty(),awaitingReviewKeys:[f.members[0].itemKey]});return state;
}
async function failPut(f,predicate,work){
  const put=IDBObjectStore.prototype.put;let hit=0;
  IDBObjectStore.prototype.put=function(value,...args){
    if(this.transaction.db.name==='zhixue-learning-attempts-v1'&&value?.attempt?.binding.ownerId===f.raw.ownerId
        &&value.attempt.binding.libraryId===f.raw.libraryId&&predicate(value.attempt)){
      hit++;throw Error('Injected continuation storage failure');
    }
    return put.call(this,value,...args);
  };
  try{await work();assert.ok(hit,'fault must hit the intended real storage write');}finally{IDBObjectStore.prototype.put=put;}
}
async function linkAgainAfterCorrect(actor,{mark=true}={}){
  if(!actor.session.snapshot().submitted)await actor.session.submit('Correct after level-three reference.','observed',{maxPreHintLevel:3,answerRevealed:true});
  await actor.session.assess({status:'correct',source:'self-assess',rating:'good',explanation:'Synthetic correct diagnosis with observed help.'});
  const identity=await actor.session.reserve('again'),first=actor.session.snapshot();
  const event=await formalEvent(identity.eventId,identity.reviewedAt,0,0,false,{domain:'differential-review',item:{kind:'due',key:first.binding.itemKey},
    attempt:{rating:'again',correct:false,stageBefore:0,stageAfter:0}});
  await putLocalStudyEvent({workspaceId:actor.scope.workspaceId,eventId:event.eventId,event,cloud:'not-required',companion:'not-required',
    occurredAt:event.occurredAt,updatedAt:event.occurredAt});
  await actor.session.link(event.coreHash);if(mark)await actor.session.markTraversed();return event;
}

test('explicit pending continue, reopen and cold recovery keep the same first answer; only a fresh operation may continue again',async()=>{
  const f=await fixture(),old=await f.actor();await submitPending(old);await old.session.traversePending();
  const first=old.session.snapshot(),receipt=await f.continuation(first.attemptId);assert.equal(receipt.value.sequence,1);
  await expectPendingNext(f);
  await old.session.traversePending();assert.equal((await f.continuation(first.attemptId)).value.sequence,1,'same-boundary retry retains the accepted sequence');
  const reopened=await reopenNonWordPendingRound(f.round);assert.equal(reopened.currentItemKey,f.members[0].itemKey);assert.deepEqual(reopened.traversal,empty());
  const cold=await f.pure(()=>createNonWordRoundRuntime(f.options));
  assert.equal((await f.pure(()=>cold.read())).currentItemKey,f.members[0].itemKey,'cold read cannot consume the acknowledged old continuation');
  await assert.rejects(old.session.traversePending(),/reopen|boundary|stale|切换|重开|位置已变化|重新打开/);
  assert.equal((await f.continuation(first.attemptId)).value.sequence,1);
  assert.equal((await f.pure(()=>cold.read())).currentItemKey,f.members[0].itemKey);
  const fresh=await f.actor();assert.equal(fresh.session.snapshot().attemptId,first.attemptId);assert.deepEqual(fresh.session.snapshot().submitted,first.submitted);
  assert.equal((await f.pure(()=>cold.read())).currentItemKey,f.members[0].itemKey,'runtime open and view autosave are not a new continue action');
  await fresh.session.save('ignored edited answer',{answer:'temporary view buffer'},'submitted');
  assert.deepEqual(fresh.session.snapshot().submitted,first.submitted);
  await fresh.session.traversePending();assert.equal((await f.continuation(first.attemptId)).value.sequence,2);
  await expectPendingNext(f,cold);assert.equal(fresh.session.snapshot().formal,null);
});

test('group reads and cold opens use exact deterministic receipt reads without a repository-wide list or any writes',async()=>{
  const f=await fixture(),a=await f.actor();await submitPending(a);await a.session.traversePending();
  f.repository.list=()=>assert.fail('Round recovery must use exact IDs; a scope-wide list is not its restoration protocol');
  f.reads.length=0;await expectPendingNext(f);assert.ok(f.reads.length>1,'anchor plus exact first/receipt identities are read');
  const cold=await f.pure(()=>createNonWordRoundRuntime(f.options));await expectPendingNext(f,cold);
});

test('formal continuation proves the linked first again rating rather than upgrading its correct diagnostic',async()=>{
  const f=await fixture(),a=await f.actor(),event=await linkAgainAfterCorrect(a),first=a.session.snapshot();
  assert.equal(first.evaluation.rating,'good');assert.equal(first.formal.rating,'again');assert.equal(first.formal.status,'linked');
  const receipt=await f.continuation(first.attemptId);assert.equal(receipt.value.proof.kind,'formal');assert.equal(receipt.value.proof.rating,'again');
  const state=await f.pure(()=>f.round.read());assert.equal(state.currentItemKey,f.members[1].itemKey);
  assert.deepEqual(state.traversal,{...empty(),wrongKeys:[f.members[0].itemKey]});
  assert.equal((await getLocalStudyEvent(f.raw.workspaceId,event.eventId)).event.coreHash,event.coreHash);
  assert.deepEqual(await a.repository.read(first.attemptId),first);
});

test('failed explicit continuation receipt preserves the saved answer but cannot advance from the legacy traversed flag',async()=>{
  const f=await fixture(),a=await f.actor();await submitPending(a,'Answer saved before receipt failure.');
  await failPut(f,row=>note(row)?.kind==='nonword-continuation',async()=>{
    await assert.rejects(a.session.traversePending(),/continuation|storage|receipt|保存/);
  });
  const first=await a.repository.read(a.session.snapshot().attemptId);assert.equal(first.submitted.answer,'Answer saved before receipt failure.');assert.equal(first.formal,null);
  const state=await f.pure(()=>f.round.read());assert.equal(state.currentItemKey,f.members[0].itemKey);assert.deepEqual(state.traversal,empty());
  await a.session.traversePending();await expectPendingNext(f);
});

test('staged reopen ACK cannot hide the old receipt when its associated anchor write fails; retry commits an acknowledged reopen',async()=>{
  const f=await fixture(),a=await f.actor();await submitPending(a);await a.session.traversePending();await expectPendingNext(f);
  await failPut(f,row=>row.attemptId===f.initial.anchorAttemptId,async()=>{
    await assert.rejects(reopenNonWordPendingRound(f.round),/continuation|storage|receipt|保存/);
  });
  await expectPendingNext(f);
  const reopened=await reopenNonWordPendingRound(f.round);assert.equal(reopened.currentItemKey,f.members[0].itemKey);assert.deepEqual(reopened.traversal,empty());
  const cold=await f.pure(()=>createNonWordRoundRuntime(f.options));assert.equal((await f.pure(()=>cold.read())).currentItemKey,f.members[0].itemKey);
});

test('a failed later staged reopen retains the previous active ACK and still consumes the genuinely new continuation',async()=>{
  const f=await fixture(),old=await f.actor();await submitPending(old);await old.session.traversePending();await reopenNonWordPendingRound(f.round);
  const fresh=await f.actor();await fresh.session.traversePending();await expectPendingNext(f);
  await failPut(f,row=>row.attemptId===f.initial.anchorAttemptId,async()=>{
    await assert.rejects(reopenNonWordPendingRound(f.round),/continuation|storage|receipt|保存/);
  });
  await expectPendingNext(f);
  const first=fresh.session.snapshot();assert.equal((await f.continuation(first.attemptId)).value.sequence,2);
  await reopenNonWordPendingRound(f.round);assert.equal((await f.pure(()=>f.round.read())).currentItemKey,f.members[0].itemKey);
});

test('exact receipt read failure cannot silently recreate an empty group or mutate storage',async()=>{
  const f=await fixture(),a=await f.actor();await submitPending(a);await a.session.traversePending();
  const record=await f.continuation(a.session.snapshot().attemptId),read=f.repository.read;
  f.repository.read=id=>id===record.row.attemptId?Promise.reject(Error('Injected exact receipt read unavailable')):read(id);
  try{await f.pure(()=>assert.rejects(f.round.read(),/exact receipt read unavailable/));}finally{f.repository.read=read;}
  await expectPendingNext(f);
});

test('a confirmed reopen anchor without its matching ACK is conservatively unreadable and cannot consume an old continue receipt',async()=>{
  const f=await fixture(),a=await f.actor();await submitPending(a);await a.session.traversePending();await reopenNonWordPendingRound(f.round);
  const ack=(await f.rows()).find(row=>note(row)?.kind==='nonword-reopen');assert.ok(ack);
  const read=f.repository.read;f.repository.read=id=>id===ack.attemptId?Promise.resolve(null):read(id);
  try{
    await f.pure(()=>assert.rejects(f.round.read(),/ack|reopen|重开|回执/));
    await f.pure(()=>assert.rejects(createNonWordRoundRuntime(f.options),/ack|reopen|重开|回执/));
  }finally{f.repository.read=read;}
  const state=await f.pure(()=>f.round.read());assert.equal(state.currentItemKey,f.members[0].itemKey);assert.deepEqual(state.traversal,empty());
});

test('continuation and reopening remain isolated by user, library, source version and explicit run',async()=>{
  const f=await fixture(),a=await f.actor();await submitPending(a);await a.session.traversePending();await expectPendingNext(f);
  const otherOwner=await fixture(),otherLibrary=await fixture({ownerId:f.raw.ownerId,libraryId:`local-vault:${'d'.repeat(64)}`}),
    changedSource=await fixture({ownerId:f.raw.ownerId,libraryId:f.raw.libraryId,firstHash:'e'.repeat(64)});
  for(const isolated of [otherOwner,otherLibrary,changedSource]){
    const state=await isolated.pure(()=>isolated.round.read());assert.equal(state.currentItemKey,isolated.members[0].itemKey);assert.deepEqual(state.traversal,empty());
  }
  const first=a.session.snapshot(),next=await f.round.startNewRound({restartConfirmed:true});assert.notEqual(next.runId,f.initial.runId);
  const state=await f.pure(()=>f.round.read());assert.equal(state.currentItemKey,f.members[0].itemKey);assert.deepEqual(state.traversal,empty());
  const fresh=await f.actor();assert.notEqual(fresh.session.snapshot().attemptId,first.attemptId);assert.equal(fresh.session.snapshot().submitted,null);
  assert.deepEqual((await a.repository.read(first.attemptId)).submitted,first.submitted);
});

test('a pending append prepared before the storage fresh read cannot overwrite a peer formal continuation receipt',async()=>{
  const f=await fixture(),old=await f.actor();await submitPending(old,'Original shared by competing first views.');
  const first=old.session.snapshot(),association=await f.continuation(first.attemptId),read=old.repository.read;
  const entered=deferred(),release=deferred();let count=0;
  old.repository.read=async id=>{
    if(id===association.row.attemptId&&++count===2){entered.resolve();await release.promise;}
    return read(id);
  };
  const rejected=assert.rejects(old.session.traversePending(),/continuation-conflict|receipt|conflict/);
  try{
    await entered.promise;
    const peer=await f.actor();assert.equal(peer.session.snapshot().attemptId,first.attemptId);
    const event=await linkAgainAfterCorrect(peer),accepted=await f.continuation(first.attemptId),saved=await f.saved();
    assert.equal(accepted.value.proof.kind,'formal');assert.equal(accepted.value.proof.rating,'again');
    release.resolve();await rejected;
    assert.deepEqual(await f.saved(),saved,'rejected stale pending append cannot mutate the newer first record or accepted receipt');
    assert.deepEqual(await f.continuation(first.attemptId),accepted);
    const state=await f.pure(()=>f.round.read());assert.deepEqual(state.traversal,{...empty(),wrongKeys:[f.members[0].itemKey]});
    assert.equal((await old.repository.read(first.attemptId)).formal.coreHash,event.coreHash);
    assert.deepEqual((await old.repository.read(first.attemptId)).submitted,first.submitted);
  }finally{release.resolve();old.repository.read=read;await rejected;}
});

test('a frozen old formal append rejects after a concurrent reopen and its token cannot advance the reopened cursor',async()=>{
  const f=await fixture(),old=await f.actor();await submitPending(old);await old.session.traversePending();
  const first=old.session.snapshot(),event=await linkAgainAfterCorrect(old,{mark:false});
  assert.equal(old.continuationBoundary,'initial');
  const entered=deferred(),release=deferred(),mutate=old.repository.mutate;let paused=false;
  old.repository.mutate=async mutation=>{
    const value=mutation.kind==='checkpoint'?JSON.parse(mutation.checkpoint.pluginFields?.notes??'null'):null;
    if(!paused&&value?.kind==='nonword-continuation'&&value.proof?.kind==='formal'){
      paused=true;entered.resolve();await release.promise;
    }
    return mutate(mutation);
  };
  const rejected=assert.rejects(old.session.markTraversed(),/boundary-changed|位置已变化|重新打开|reopen/);
  try{
    await entered.promise;
    const reopened=await reopenNonWordPendingRound(f.round);assert.equal(reopened.currentItemKey,f.members[0].itemKey);
    await f.pure(()=>assert.rejects(continueNonWordRound(f.round,f.members[0].itemKey,'again',f.initial.runId,old.continuationBoundary),/boundary-changed|位置已变化|重新打开/));
    release.resolve();await rejected;
    const state=await f.pure(()=>f.round.read());assert.equal(state.currentItemKey,f.members[0].itemKey);assert.deepEqual(state.traversal,empty());
    assert.equal(old.continuationBoundary,'initial','old view token cannot refresh itself from the newly committed ACK');
    assert.equal((await old.repository.read(first.attemptId)).formal.coreHash,event.coreHash);
    assert.deepEqual((await old.repository.read(first.attemptId)).submitted,first.submitted);
    const fresh=await f.actor();assert.notEqual(fresh.continuationBoundary,old.continuationBoundary);assert.equal(fresh.session.snapshot().attemptId,first.attemptId);
    await fresh.session.markTraversed();
    const advanced=await f.pure(()=>f.round.read());assert.equal(advanced.currentItemKey,f.members[1].itemKey);
    assert.deepEqual(advanced.traversal,{...empty(),wrongKeys:[f.members[0].itemKey]});
    assert.equal((await getLocalStudyEvent(f.raw.workspaceId,event.eventId)).event.attempt.rating,'again');
  }finally{release.resolve();old.repository.mutate=mutate;await rejected;}
});

test('a cursor write paused after its boundary guard loses CAS to the actual reopen anchor and cannot erase the ACK marker',async()=>{
  const f=await fixture(),old=await f.actor();await submitPending(old);await old.session.traversePending();
  const peer=await createNonWordRoundRuntime(f.options),entered=deferred(),release=deferred(),mutate=f.repository.mutate;let paused=false;
  f.repository.mutate=async mutation=>{
    if(!paused&&mutation.attemptId===f.initial.anchorAttemptId&&!mutation.checkpoint.view?.instanceId?.startsWith('nw-reopen:')){
      paused=true;entered.resolve();await release.promise;
    }
    return mutate(mutation);
  };
  const rejected=assert.rejects(continueNonWordRound(f.round,f.members[0].itemKey,'pending',f.initial.runId,old.continuationBoundary),/cursor-conflict|run-conflict|conflict/);
  try{
    await entered.promise;await reopenNonWordPendingRound(peer);
    const anchor=await f.repository.read(f.initial.anchorAttemptId),rows=await f.rows(),outbox=await f.repository.pending();
    assert.ok(anchor.checkpoint.view.instanceId.startsWith('nw-reopen:'));
    release.resolve();await rejected;
    assert.deepEqual(await f.rows(),rows);assert.deepEqual(await f.repository.pending(),outbox);
    assert.deepEqual(await f.repository.read(f.initial.anchorAttemptId),anchor);
    const state=await f.pure(()=>peer.read());assert.equal(state.currentItemKey,f.members[0].itemKey);assert.deepEqual(state.traversal,empty());
  }finally{release.resolve();f.repository.mutate=mutate;await rejected;}
});

for(const latestAck of [false,true])test(`legacy anchor view omission still requires the latest confirmed reopen ACK, latest ACK available=${latestAck}`,async()=>{
  const f=await fixture(),firstView=await f.actor();await submitPending(firstView,'Same first answer across two reopen acknowledgments.');
  await firstView.session.traversePending();await reopenNonWordPendingRound(f.round);
  const ackOne=structuredClone((await f.rows()).find(row=>note(row)?.kind==='nonword-reopen'));
  const secondView=await f.actor();await secondView.session.traversePending();await reopenNonWordPendingRound(f.round);
  const ackTwo=structuredClone((await f.rows()).find(row=>note(row)?.kind==='nonword-reopen'));
  assert.notEqual(note(ackOne).staged.boundary,note(ackTwo).staged.boundary);
  assert.equal(note(ackOne).staged.operationId,note(ackOne).staged.boundary);
  assert.equal(note(ackTwo).staged.operationId,note(ackTwo).staged.boundary);
  const anchorBefore=await f.repository.read(f.initial.anchorAttemptId),checkpoint=structuredClone(anchorBefore.checkpoint);
  delete checkpoint.view;
  const legacyReceipt=await f.repository.mutate({schemaVersion:1,kind:'checkpoint',attemptId:anchorBefore.attemptId,binding:anchorBefore.binding,
    operationId:`legacy-view-drop:${crypto.randomUUID()}`,expectedRevision:anchorBefore.revision,updatedAt:new Date().toISOString(),
    answer:'',parentAttemptId:null,checkpoint});
  assert.equal(legacyReceipt.durable,true,'view omission must be a legal actual V1 checkpoint');
  const anchorTwo=await f.repository.read(anchorBefore.attemptId),first=await f.repository.read(secondView.session.snapshot().attemptId),
    continuationTwo=(await f.continuation(first.attemptId)).row;
  assert.equal(anchorTwo.checkpoint.view,undefined);assert.equal(note(continuationTwo).sequence,2);
  assert.equal(note(continuationTwo).boundary,note(ackOne).staged.boundary);
  assert.ok(anchorTwo.operations.some(operation=>operation.operationId===note(ackOne).staged.operationId));
  assert.ok(anchorTwo.operations.some(operation=>operation.operationId===note(ackTwo).staged.operationId));
  assert.ok(anchorTwo.operations.at(-1).operationId.startsWith('legacy-view-drop:'));
  const sourceState=await f.pure(()=>f.round.read());assert.equal(sourceState.currentItemKey,f.members[0].itemKey);assert.deepEqual(sourceState.traversal,empty());
  const target=deviceRepository(f.raw);
  for(const row of [first,continuationTwo,anchorTwo,latestAck?ackTwo:ackOne])assert.equal(await target.hydrate(structuredClone(row)),true);
  const originalList=target.list.bind(target),mutate=target.mutate;let writes=0;
  target.mutate=(...args)=>{writes++;return mutate(...args);};
  target.list=()=>assert.fail('Half-sync recovery must inspect exact identities rather than scan a device');
  const session=createNonWordRoundSession({scope:f.options.scope,members:f.members,attemptGroupId:f.raw.groupId,repository:target,
    fingerprint:attemptFingerprint,now:()=>new Date().toISOString(),newId:()=>crypto.randomUUID()});
  const before={rows:await originalList(),outbox:await target.pending()};
  if(latestAck){
    const state=await session.read();assert.equal(state.currentItemKey,f.members[0].itemKey);assert.deepEqual(state.traversal,empty());
    const cold=await createNonWordRoundRuntime({...f.options,repository:target});
    assert.deepEqual(await cold.read(),state,'fully delivered latest ACK preserves the requested reopen without view metadata');
  }else{
    await assert.rejects(session.read(),/nonword-continuation-ack-unavailable/);
    await assert.rejects(createNonWordRoundRuntime({...f.options,repository:target}),/nonword-continuation-ack-unavailable/);
  }
  assert.equal(writes,0);assert.deepEqual({rows:await originalList(),outbox:await target.pending()},before);
  const recoveredFirst=await target.read(first.attemptId);assert.deepEqual(recoveredFirst.submitted,first.submitted);
  assert.equal(recoveredFirst.evaluation.status,'pending');assert.equal(recoveredFirst.formal,null);
});
