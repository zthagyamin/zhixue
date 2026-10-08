import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createNonWordRoundRuntime,createNonWordRuntime} from '../src/infrastructure/nonword-study/index.ts';
import {createLocalAttemptRepository,attemptFingerprint} from '../src/infrastructure/learning-attempt/index.ts';
import {putLocalStudyEvent,getLocalStudyEvent} from '../app/local-study-events.ts';
import {attempt as formalEvent} from './fixtures/task-event-fixtures.mjs';

globalThis.indexedDB=new IDBFactory();
const empty=()=>({correctKeys:[],wrongKeys:[],awaitingReviewKeys:[],skippedKeys:[]});
let serial=0;
async function fixture({optIn=true}={}){
  const ownerId=`recovered-round-${serial++}`,members=['A','B'].map((itemKey,index)=>({itemKey:`practice:${itemKey}`,snapshotId:'local',
    contentHash:(index?'b':'a').repeat(64),kind:'practice',mode:'recall'}));
  const raw={workspaceId:`local:${ownerId}`,ownerId,libraryId:`local-vault:${'c'.repeat(64)}`,groupId:'original-course-group',roundId:'original-page-scope',
    day:'2026-10-06',cloud:false,members};
  const repository=createLocalAttemptRepository({userId:raw.ownerId,libraryId:raw.libraryId}),mutate=repository.mutate,writes=[];
  repository.mutate=mutation=>{writes.push(structuredClone(mutation));return mutate(mutation);};
  const options={scope:{ownerId:raw.ownerId,libraryId:raw.libraryId,groupId:JSON.stringify([raw.groupId,raw.roundId]),day:raw.day,cloud:false},
    members,repository,...(optIn?{attemptGroupId:raw.groupId}:{})};
  const round=await createNonWordRoundRuntime(options),cursor=await round.read();
  async function actor(index=0,patch={},actorOptions={}){
    const member=members[index],scope={...raw,snapshotId:member.snapshotId,itemKey:member.itemKey,contentHash:member.contentHash,roundId:cursor.roundId,...patch};
    const runtime=await createNonWordRuntime(scope,'recall',{...actorOptions,verifyFormalEvent:async id=>{
      const record=await getLocalStudyEvent(scope.workspaceId,id);if(!record)return null;
      const event=record.event;return {eventId:id,coreHash:event.coreHash,itemKey:event.item.key,contentHash:scope.contentHash,snapshotId:scope.snapshotId,
        reviewedAt:event.scheduling.reviewedAt,rating:event.attempt.rating};
    }});
    assert.equal(runtime.session.snapshot().binding.roundId,await attemptFingerprint(scope.roundId));
    assert.equal(runtime.session.snapshot().binding.groupId,await attemptFingerprint(scope.groupId));
    return runtime;
  }
  return {raw,members,repository,writes,options,round,cursor,actor};
}
async function pending(runtime,answer='Saved original answer.'){
  await runtime.session.submit(answer,'unknown');await runtime.session.pending('offline','AI off; original retained.');
  await runtime.session.traversePending();
  assert.equal(runtime.session.snapshot().checkpoint.traversed,true);assert.equal(runtime.session.snapshot().formal,null);
}
async function link(runtime,rating,evaluationRating=rating){
  const correct=['good','easy'].includes(rating);
  const evaluationCorrect=['good','easy'].includes(evaluationRating);
  await runtime.session.assess({status:evaluationCorrect?'correct':evaluationRating==='hard'?'partial':'incorrect',source:'self-assess',rating:evaluationRating,explanation:'Synthetic explicit first result.'});
  const identity=await runtime.session.reserve(rating),saved=runtime.session.snapshot();
  const event=await formalEvent(identity.eventId,identity.reviewedAt,0,correct?3:0,correct,{domain:'differential-review',item:{kind:'due',key:saved.binding.itemKey},
    attempt:{rating,correct,stageBefore:0,stageAfter:correct?3:0}});
  await putLocalStudyEvent({workspaceId:runtime.scope.workspaceId,eventId:event.eventId,event,cloud:'not-required',companion:'not-required',
    occurredAt:event.occurredAt,updatedAt:event.occurredAt});
  await runtime.session.link(event.coreHash);await runtime.session.markTraversed();return event;
}
async function storage(f){
  return {attempts:await f.repository.list(),outbox:await f.repository.pending(),writes:f.writes.length};
}
async function assertReadOnly(f,work){
  const before=await storage(f),result=await work();assert.deepEqual(await storage(f),before,'projection may not mutate attempts, cursor or queued operations');return result;
}

test('recovered individual pending continuation projects into the original two-item group and advances current source on cold read',async()=>{
  const f=await fixture(),a=await f.actor();await pending(a,'Paused then resumed through pending review.');
  const original=a.session.snapshot();
  const projected=await assertReadOnly(f,()=>f.round.read());
  assert.equal(projected.currentItemKey,f.members[1].itemKey);assert.deepEqual(projected.traversal,{...empty(),awaitingReviewKeys:[f.members[0].itemKey]});
  assert.equal(projected.runId,f.cursor.runId);assert.equal(projected.roundId,f.cursor.roundId);
  const cold=await assertReadOnly(f,()=>createNonWordRoundRuntime(f.options));
  assert.deepEqual(await assertReadOnly(f,()=>cold.read()),projected);
  assert.deepEqual(await a.repository.read(original.attemptId),original);
  assert.equal(original.evaluation.status,'pending');assert.equal(original.formal,null);
});

test('linked original grades project their actual first ratings and an auxiliary correct answer cannot upgrade the original wrong result',async()=>{
  const f=await fixture(),a=await f.actor(),b=await f.actor(1);
  await pending(a,'Wrong first A answer.');const aEvent=await link(a,'again');
  await pending(b,'Correct first B answer.');const bEvent=await link(b,'good');
  const child=await f.actor(0,{}, {purpose:'remediation',parentAttemptId:a.session.snapshot().attemptId,instanceId:'authored-child'});
  await child.session.submit('Correct auxiliary A answer.','observed');
  await child.session.assess({status:'correct',source:'self-assess',rating:'good',explanation:'Auxiliary result only.'});await child.session.markAuxiliaryTraversed();
  const originals=[a.session.snapshot(),b.session.snapshot()],state=await assertReadOnly(f,()=>f.round.read());
  assert.equal(state.currentItemKey,null);assert.deepEqual(state.traversal,{...empty(),wrongKeys:[f.members[0].itemKey],correctKeys:[f.members[1].itemKey]});
  for(const original of originals)assert.deepEqual(await f.repository.read(original.attemptId),original);
  assert.equal((await getLocalStudyEvent(f.raw.workspaceId,aEvent.eventId)).event.attempt.rating,'again');
  assert.equal((await getLocalStudyEvent(f.raw.workspaceId,bEvent.eventId)).event.attempt.rating,'good');assert.equal(child.session.snapshot().formal,null);
});

test('linked formal rating takes precedence over a correct sidecar evaluation after frozen level-three assistance',async()=>{
  const f=await fixture(),a=await f.actor();
  await a.session.submit('Correct after reference assistance.','observed',{maxPreHintLevel:3,answerRevealed:true});
  await link(a,'again','good');const original=a.session.snapshot();
  assert.equal(original.evaluation.rating,'good');assert.equal(original.formal.rating,'again');
  const state=await assertReadOnly(f,()=>f.round.read());assert.equal(state.currentItemKey,f.members[1].itemKey);
  assert.deepEqual(state.traversal,{...empty(),wrongKeys:[f.members[0].itemKey]});
  assert.deepEqual(await f.repository.read(original.attemptId),original);
});

for(const reserve of [false,true])test(`resolved but unlinked first recovery remains awaiting review, formal reserved=${reserve}`,async()=>{
  const f=await fixture(),a=await f.actor();await pending(a);
  await a.session.assess({status:'correct',source:'self-assess',rating:'good',explanation:'Resolved sidecar without a durable formal event.'});
  if(reserve)await a.session.reserve('good');
  const original=a.session.snapshot(),state=await assertReadOnly(f,()=>f.round.read());
  assert.equal(state.currentItemKey,f.members[1].itemKey);assert.deepEqual(state.traversal,{...empty(),awaitingReviewKeys:[f.members[0].itemKey]});
  assert.deepEqual(await f.repository.read(original.attemptId),original);
  assert.equal(original.formal?.status??null,reserve?'claimed':null);assert.equal(state.traversal.correctKeys.length,0);
});

test('unsubmitted, untraversed first and traversed guided or remediation actors do not settle original group members',async()=>{
  const f=await fixture(),unsubmitted=await f.actor();
  await unsubmitted.session.save('Draft remains unsubmitted.',{answer:'Draft remains unsubmitted.'});
  const draft=unsubmitted.session.snapshot();
  await unsubmitted.repository.mutate({schemaVersion:1,kind:'checkpoint',operationId:'synthetic-unsubmitted-view',attemptId:draft.attemptId,
    binding:draft.binding,expectedRevision:draft.revision,updatedAt:new Date().toISOString(),answer:draft.answer,parentAttemptId:null,
    checkpoint:{...draft.checkpoint,traversed:true}});
  const guided=await f.actor(1,{}, {purpose:'guided',instanceId:'guided-only'});await pending(guided,'Guided answer.');
  const firstB=await f.actor(1);await firstB.session.submit('Original B not traversed.','unknown');await firstB.session.pending('offline');
  const child=await f.actor(1,{}, {purpose:'remediation',parentAttemptId:firstB.session.snapshot().attemptId,instanceId:'child-only'});await pending(child,'Child answer.');
  const state=await assertReadOnly(f,()=>f.round.read());
  assert.equal(state.currentItemKey,f.members[0].itemKey);assert.deepEqual(state.traversal,empty());
});

test('recovery projection requires exact owner, library, original item version, snapshot, group and current round binding',async()=>{
  const f=await fixture(),patches=[
    {ownerId:'another-owner',workspaceId:'local:another-owner'},
    {libraryId:`local-vault:${'d'.repeat(64)}`},
    {itemKey:'practice:outside-current-members'},
    {contentHash:'e'.repeat(64)},
    {snapshotId:'other-source-snapshot'},
    {groupId:'other-course-group'},
    {roundId:'other-cursor-round'},
  ];
  for(const [index,patch] of patches.entries()){const actor=await f.actor(0,patch);await pending(actor,`Foreign binding ${index}.`);}
  const state=await assertReadOnly(f,()=>f.round.read());assert.equal(state.currentItemKey,f.members[0].itemKey);assert.deepEqual(state.traversal,empty());
});

test('a new explicit run ignores old traversed first attempts while preserving their raw answers and pending state',async()=>{
  const f=await fixture(),a=await f.actor();await pending(a,'Old run original.');const original=a.session.snapshot();
  const restarted=await f.round.startNewRound({restartConfirmed:true});assert.notEqual(restarted.runId,f.cursor.runId);assert.notEqual(restarted.roundId,f.cursor.roundId);
  const state=await assertReadOnly(f,()=>f.round.read());assert.equal(state.currentItemKey,f.members[0].itemKey);assert.deepEqual(state.traversal,empty());
  assert.deepEqual(await f.repository.read(original.attemptId),original);
});

test('read projection retains explicitly stored skipped membership and only fills missing matching first continuation',async()=>{
  const f=await fixture(),a=await f.actor();await pending(a,'Recovered A pending.');
  await f.round.saveCursor({currentItemKey:f.members[0].itemKey,traversal:{...empty(),skippedKeys:[f.members[1].itemKey]}},f.cursor.runId);
  const state=await assertReadOnly(f,()=>f.round.read());assert.equal(state.currentItemKey,null);
  assert.deepEqual(state.traversal,{...empty(),awaitingReviewKeys:[f.members[0].itemKey],skippedKeys:[f.members[1].itemKey]});
});

test('round callers without the optional original attempt group metadata retain the existing stored-cursor behavior',async()=>{
  const f=await fixture({optIn:false}),a=await f.actor();await pending(a);
  const state=await assertReadOnly(f,()=>f.round.read());assert.equal(state.currentItemKey,f.members[0].itemKey);assert.deepEqual(state.traversal,empty());
});
