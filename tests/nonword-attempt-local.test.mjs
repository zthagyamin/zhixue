import assert from 'node:assert/strict';
import test from 'node:test';
import {indexedDB} from 'fake-indexeddb';
import {createLocalAttemptRepository,evaluationFingerprint} from '../src/infrastructure/learning-attempt/index.ts';
import {applyAttemptMutation} from '../src/domain/learning-attempt/index.ts';
import {createSubmissionJournal} from '../app/study-submission-journal.ts';
import {persistOriginalSubmission} from '../app/study-submission.ts';
import {getLocalStudyEvent} from '../app/local-study-events.ts';
import {attempt} from './fixtures/task-event-fixtures.mjs';
globalThis.indexedDB=indexedDB;
let counter=0;
function fixture() {
  const scope={userId:`local-user-${counter++}`,libraryId:'library'},binding={ownerId:scope.userId,libraryId:scope.libraryId,snapshotId:'snapshot',itemKey:'question',contentHash:'a'.repeat(64),groupId:'group',roundId:'round'};
  const checkpoint={schemaVersion:1,attemptId:'attempt',operationId:'draft',binding,expectedRevision:0,updatedAt:'2026-10-05T00:00:00Z',kind:'checkpoint',answer:'independent original',parentAttemptId:null,checkpoint:{phase:'answering',position:0,traversed:false,mode:'recall'}};
  return {scope,checkpoint,repo:createLocalAttemptRepository(scope)};
}
test('real IndexedDB atomic writes survive reload, keep a durable outbox and reject stale tab edits',async()=>{
  const {scope,checkpoint,repo}=fixture(); const [one,two]=await Promise.all([repo.mutate(checkpoint),repo.mutate({...checkpoint,operationId:'second-tab',answer:'other'})]);
  assert.deepEqual([one.status,two.status].sort(),['accepted','conflict']);assert.equal(one.durable,true);
  const loaded=createLocalAttemptRepository(scope);assert.equal((await loaded.read('attempt')).answer,'independent original');assert.equal(await loaded.status('attempt'),'device-only');assert.equal((await loaded.pending()).length,1);
  assert.equal((await loaded.mutate(checkpoint)).status,'duplicate');
  assert.equal(await createLocalAttemptRepository({...scope,libraryId:'other'}).read('attempt'),null);
});
test('offline sync does not discard work; lost cloud receipt retries logical operation and clears outbox only after validated receipt',async()=>{
  const {repo,checkpoint}=fixture();await repo.mutate(checkpoint);
  const offline=await repo.sync({mutate:async()=>{throw new Error('offline');}});assert.equal(offline.pending,1);assert.equal(await repo.status('attempt'),'device-only');
  let state=null,calls=0;
  const cloud={mutate:async mutation=>{calls++;const result=applyAttemptMutation(state,mutation);state=result.attempt;const fingerprint=(await repo.pending())[0].fingerprint;state.operations[0].fingerprint=fingerprint;if(calls===1) throw new Error('receipt lost');return {...result,status:'duplicate',durable:true,attempt:state};}};
  assert.equal((await repo.sync(cloud)).pending,1);assert.equal((await repo.sync(cloud)).acked,1);assert.equal((await repo.pending()).length,0);assert.equal(await repo.status('attempt'),'cloud-acked');
});
test('cloud restoration refuses to overwrite a divergent unsynced device; conflicts stay visible and outbox intact',async()=>{
  const {scope,repo,checkpoint}=fixture();await repo.mutate(checkpoint);
  const remote=applyAttemptMutation(null,{...checkpoint,operationId:'remote',answer:'other device'}).attempt;
  assert.equal(await repo.hydrate(remote),false);assert.equal((await repo.read('attempt')).answer,checkpoint.answer);
  const synced=await repo.sync({mutate:async()=>({status:'conflict',durable:false,operationId:'draft',revision:1,attempt:remote})});assert.equal(synced.conflict,true);assert.equal(await repo.status('attempt'),'cloud-conflict');assert.equal((await repo.pending()).length,1);
  const clean=createLocalAttemptRepository({...scope,userId:'clean-owner'});
  await assert.rejects(clean.hydrate(remote),/scope-mismatch/);
  const fresh=createLocalAttemptRepository({userId:scope.userId,libraryId:'fresh-library'});
  const freshRemote={...remote,binding:{...remote.binding,libraryId:'fresh-library'}};
  assert.equal((await fresh.refresh({list:async()=>[freshRemote]})).restored,1);assert.equal((await fresh.read('attempt')).answer,'other device');
});
test('immutable references and formal linkage require actual event readback, pending grade cannot invent a result',async()=>{
  const {scope,repo,checkpoint}=fixture();await repo.mutate(checkpoint);
  const item={itemKey:'question',contentHash:checkpoint.binding.contentHash,prompt:'Original registered prompt.'};
  await repo.rememberReference('attempt',item);assert.deepEqual(await repo.reference('attempt'),item);await assert.rejects(repo.rememberReference('attempt',{...item,prompt:'Changed'}));
  const base={...checkpoint};delete base.answer;delete base.checkpoint;delete base.parentAttemptId;
  await repo.mutate({...base,kind:'submit',operationId:'submit',expectedRevision:1,answerRevision:1,assistance:'observed'});
  const evaluation={status:'resolved',rating:'good',correct:true,outcome:'correct',source:'model',feedback:'Original check.',referenceHash:checkpoint.binding.contentHash};evaluation.evaluationHash=await evaluationFingerprint(evaluation);
  await repo.mutate({...base,kind:'evaluate',operationId:'evaluate',expectedRevision:2,answerRevision:1,evaluation});
  await repo.mutate({...base,kind:'claim-formal',operationId:'claim',expectedRevision:3,eventId:'official',occurredAt:base.updatedAt,evaluationHash:evaluation.evaluationHash,rating:'again'});
  const link={...base,kind:'link-formal',operationId:'link',expectedRevision:4,eventId:'official',coreHash:'c'.repeat(64)};
  await assert.rejects(repo.mutate(link),/not-durable/);
  const verified=createLocalAttemptRepository(scope,{verifyFormalEvent:async()=>({eventId:'official',coreHash:link.coreHash,itemKey:'question',contentHash:checkpoint.binding.contentHash,reviewedAt:base.updatedAt,rating:'again'})});
  assert.equal((await verified.mutate(link)).attempt.formal.status,'linked');assert.equal((await verified.pending()).length,5);
});
test('unavailable IndexedDB fails closed and creates no pretend durable receipt',async()=>{
  const {repo,checkpoint}=fixture(),saved=globalThis.indexedDB;delete globalThis.indexedDB;
  try {await assert.rejects(repo.mutate(checkpoint),/local-unavailable/);} finally {globalThis.indexedDB=saved;}
});
test('production journal plus actual native event store verifies source association before linking',async()=>{
  const f=fixture(),workspaceId=`account:${f.scope.userId}`,journal=createSubmissionJournal(),base={...f.checkpoint};delete base.answer;delete base.checkpoint;delete base.parentAttemptId;
  const repo=createLocalAttemptRepository(f.scope,{verifyFormalEvent:async eventId=>{
    const row=await journal.get(workspaceId,eventId),stored=await getLocalStudyEvent(workspaceId,eventId);
    if (!row?.coreStored || !stored || stored.event.coreHash!==row.payload.core.event.coreHash || row.payload.route.kind!=='local' || !row.payload.route.binding || row.payload.route.binding.contentHash!==base.binding.contentHash || row.payload.route.binding.localBindingHash!=='d'.repeat(64)) return null;
    const event=stored.event;return {eventId:event.eventId,coreHash:event.coreHash,itemKey:event.item.key,contentHash:row.payload.route.binding.contentHash,reviewedAt:event.scheduling.reviewedAt,rating:event.attempt.rating};
  }});
  await repo.mutate(f.checkpoint);await repo.mutate({...base,kind:'submit',operationId:'s',expectedRevision:1,answerRevision:1,assistance:'unknown'});
  const evaluation={status:'resolved',rating:'again',correct:false,outcome:'incorrect',source:'deterministic',feedback:'Original incorrect answer.',referenceHash:base.binding.contentHash};evaluation.evaluationHash=await evaluationFingerprint(evaluation);
  await repo.mutate({...base,kind:'evaluate',operationId:'e',expectedRevision:2,answerRevision:1,evaluation});
  await repo.mutate({...base,kind:'claim-formal',operationId:'c',expectedRevision:3,eventId:'journal-native',occurredAt:'2026-10-05T00:00:00.000Z',evaluationHash:evaluation.evaluationHash,rating:'again'});
  const event=await attempt('journal-native',base.updatedAt,0,0,false,{domain:'differential-review',item:{kind:'due',key:'question'}});
  const payload={schemaVersion:1,workspaceId,eventId:event.eventId,core:{workspaceId,eventId:event.eventId,event,cloud:'pending',companion:'pending',occurredAt:event.occurredAt,updatedAt:event.occurredAt},route:{kind:'local',binding:{schemaVersion:1,eventId:event.eventId,coreHash:event.coreHash,contentHash:base.binding.contentHash,localBindingHash:'d'.repeat(64),practiceMode:'recall'}},summary:null};
  await journal.put(payload);
  const link={...base,kind:'link-formal',operationId:'l',expectedRevision:4,eventId:event.eventId,coreHash:event.coreHash};
  await assert.rejects(repo.mutate(link),/not-durable/);
  await persistOriginalSubmission(payload);await journal.markCoreStored(workspaceId,event.eventId);
  assert.equal((await repo.mutate(link)).attempt.formal.status,'linked');
});
test('equal revision on another device never overwrites local descendants when recovering an older receipt',async()=>{
  const f=fixture(),base={...f.checkpoint};delete base.answer;delete base.checkpoint;delete base.parentAttemptId;
  await f.repo.mutate(f.checkpoint);
  const first=(await f.repo.pending())[0];
  await f.repo.mutate({...base,kind:'submit',operationId:'local-submit',expectedRevision:1,answerRevision:1,assistance:'unknown'});
  const evaluation={status:'resolved',rating:'good',correct:true,outcome:'correct',source:'deterministic',feedback:'A correct.',referenceHash:base.binding.contentHash};evaluation.evaluationHash=await evaluationFingerprint(evaluation);
  await f.repo.mutate({...base,kind:'evaluate',operationId:'local-evaluate',expectedRevision:2,answerRevision:1,evaluation});
  let remote=applyAttemptMutation(null,f.checkpoint,first.fingerprint).attempt;
  remote=applyAttemptMutation(remote,{...f.checkpoint,operationId:'remote-edit',expectedRevision:1,answer:'B other device'}).attempt;
  remote=applyAttemptMutation(remote,{...base,kind:'submit',operationId:'remote-submit',expectedRevision:2,answerRevision:2,assistance:'unknown'}).attempt;
  assert.equal(remote.revision,3);assert.equal((await f.repo.read('attempt')).revision,3);
  await f.repo.ack('draft',{status:'duplicate',durable:true,operationId:'draft',revision:3,attempt:remote});
  const local=await f.repo.read('attempt');assert.equal(local.answer,'independent original');assert.equal(local.submitted.answer,'independent original');assert.equal(local.evaluation.feedback,'A correct.');assert.equal((await f.repo.pending()).length,2);
  const sync=await f.repo.sync({mutate:async mutation=>({status:'conflict',durable:false,operationId:mutation.operationId,revision:3,attempt:remote})});
  assert.equal(sync.conflict,true);assert.equal((await f.repo.read('attempt')).answer,'independent original');assert.equal((await f.repo.pending()).length,2);
});
test('semantic HTTP conflict is visible while unsupported capability and delayed authoritative record remain pending',async()=>{
  const f=fixture();await f.repo.mutate(f.checkpoint);
  const cloud={mutate:async()=>{throw Object.assign(new Error('attempt-formal-event-conflict'),{status:409});}};
  assert.equal((await f.repo.sync(cloud)).conflict,true);assert.equal(await f.repo.status('attempt'),'cloud-conflict');assert.equal((await f.repo.pending()).length,1);
  const offline=fixture();await offline.repo.mutate(offline.checkpoint);
  assert.equal((await offline.repo.sync({mutate:async()=>{throw Object.assign(new Error('learning-attempts-unsupported'),{status:409});}})).unsupported,true);
  assert.equal(await offline.repo.status('attempt'),'device-only');
  assert.equal((await offline.repo.sync({mutate:async()=>{throw Object.assign(new Error('attempt-formal-not-durable'),{status:409});}})).conflict,false);
});
