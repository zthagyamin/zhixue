import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB} from 'fake-indexeddb';
import {createLocalAttemptRepository,attemptFingerprint,evaluationFingerprint} from '../src/infrastructure/learning-attempt/index.ts';
import {createNonWordSession} from '../src/application/nonword-study/session.ts';
globalThis.indexedDB=indexedDB;
const binding={ownerId:'session-user',libraryId:'session-library',snapshotId:'snapshot',itemKey:'question',contentHash:'a'.repeat(64),groupId:'group',roundId:'round'};
function session(id,repository=createLocalAttemptRepository({userId:binding.ownerId,libraryId:binding.libraryId}),options={}){
  return createNonWordSession({repository,binding:{...binding,roundId:JSON.stringify([binding.roundId,id])},attemptId:id,formalEventId:`event-${id}`,mode:'recall',newId:()=>crypto.randomUUID(),now:()=>new Date().toISOString(),fingerprint:attemptFingerprint,evaluationFingerprint,...options});
}

test('controlled source evaluation uses the saved first answer rather than the plugin verdict',async()=>{
  let inspected;
  const current=session('controlled-source-outcome',undefined,{sourceAdmission:async attempt=>{
    inspected=structuredClone(attempt);
    return {status:'confirmed',outcome:{status:'incorrect',source:'model',rating:'again',explanation:'The saved answer omitted the required condition.'}};
  }});
  await current.open();await current.submit('Original answer.');
  await current.assess({status:'correct',source:'self-assess',rating:'good',explanation:'Caller verdict.'});
  assert.equal(inspected.submitted.answer,'Original answer.');
  assert.equal(current.snapshot().evaluation.correct,false);
  assert.equal(current.snapshot().evaluation.rating,'again');
  assert.match(current.snapshot().evaluation.feedback,/required condition/);
});

test('a changed controlled source outcome cannot claim a previously resolved formal result',async()=>{
  let status='incorrect';
  const current=session('changed-controlled-outcome',undefined,{sourceAdmission:async()=>({status:'confirmed',
    outcome:{status,source:'model',explanation:'Controlled outcome.'}})});
  await current.open();await current.submit('Saved answer.');
  await current.assess({status:'incorrect',source:'model',explanation:'Controlled outcome.'});
  status='correct';
  await assert.rejects(()=>current.reserve('again'),/核对.*变化|冲突/);
  assert.equal(current.snapshot().formal,null);
  assert.equal(current.snapshot().evaluation.outcome,'incorrect');
});
test('AI unavailable retains raw submitted answer across sessions without a formal grade',async()=>{
  const first=session('raw-pending');await first.open();await first.submit('An independent sample is required.');await first.pending('offline');await first.traversePending();
  const restored=session('raw-pending');await restored.open();
  assert.equal(restored.snapshot().submitted.answer,'An independent sample is required.');
  assert.equal(restored.snapshot().evaluation.status,'pending');assert.equal(restored.snapshot().formal,null);
  assert.deepEqual(restored.snapshot().checkpoint.pending,['question']);
  await assert.rejects(()=>restored.reserve('good'),/待核对/);
});
test('stored first answer is immutable while separate recovery state can change',async()=>{
  const current=session('immutable-first');await current.open();await current.submit('original');
  await current.save('edited',{answer:'edited'},'feedback');
  assert.equal(current.snapshot().submitted.answer,'original');
  await assert.rejects(()=>current.submit('edited'),/首轮答案/);
  await current.assess({status:'incorrect',source:'model',explanation:'Missing condition.',rating:'again'});
  await assert.rejects(()=>current.assess({status:'correct',source:'model',explanation:'Overwrite',rating:'good'}),/覆盖/);
});
test('durability failure never creates a submitted or traversable answer',async()=>{
  const real=createLocalAttemptRepository({userId:binding.ownerId,libraryId:binding.libraryId});let fail=false;
  const current=session('failed-local',{read:real.read,mutate:mutation=>fail?Promise.reject(Error('storage unavailable')):real.mutate(mutation)});
  await current.open();fail=true;
  await assert.rejects(()=>current.submit('answer'),/storage/);
  await assert.rejects(()=>current.traversePending(),/可靠保存/);
  assert.equal((await real.read('failed-local')).submitted,null);
});
test('resolved first result reserves exactly one capped formal identity',async()=>{
  const current=session('one-formal');await current.open();await current.submit('full answer','observed');
  await current.assess({status:'correct',source:'model',explanation:'Covered.',rating:'good'});
  const identity=await current.reserve('again');
  assert.deepEqual(await current.reserve('again'),identity);
  await assert.rejects(()=>current.reserve('good'),/固定/);
  assert.equal(current.snapshot().evaluation.outcome,'correct');assert.equal(current.snapshot().formal.rating,'again');
});

test('unverified source retains original answer and remains pending through restore and source confirmation',async()=>{
  let confirmed=false;
  const options={sourceAdmission:async()=>confirmed?{status:'confirmed'}:{status:'pending',reason:'来源尚未确认，临时答案保留。'}};
  const first=session('source-pending',undefined,options);await first.open();await first.submit('Original independently attempted answer.');
  await first.assess({status:'correct',source:'deterministic',explanation:'Candidate reference matched.',rating:'good'});
  assert.equal(first.snapshot().evaluation.status,'pending');assert.equal(first.snapshot().formal,null);
  await first.traversePending();
  const restored=session('source-pending',undefined,options);await restored.open();
  assert.equal(restored.snapshot().submitted.answer,'Original independently attempted answer.');
  assert.equal(restored.snapshot().evaluation.status,'pending');confirmed=true;
  await assert.rejects(()=>restored.reserve('good'),/待核对/);
  await restored.assess({status:'correct',source:'model',explanation:'Fresh evaluation against the confirmed source.',rating:'good'});
  const identity=await restored.reserve('good');assert.deepEqual(await restored.reserve('good'),identity);
  assert.equal(restored.snapshot().submitted.answer,'Original independently attempted answer.');
});

test('source changing after feedback blocks a new formal claim without losing answer or overwriting feedback',async()=>{
  let confirmed=true;
  const current=session('source-changed-before-grade',undefined,{sourceAdmission:async()=>confirmed?{status:'confirmed'}:{status:'pending',reason:'来源版本已经变化。'}});
  await current.open();await current.submit('Saved answer.');
  await current.assess({status:'correct',source:'model',explanation:'Known source.',rating:'good'});
  const before=current.snapshot();confirmed=false;
  await assert.rejects(()=>current.reserve('good'),/来源/);
  assert.deepEqual(current.snapshot(),before);assert.equal(current.snapshot().formal,null);
});

test('explicit recovery reads a newer pending checkpoint without mutating immutable evidence or dropping local edited view',async()=>{
  const repository=createLocalAttemptRepository({userId:binding.ownerId,libraryId:binding.libraryId});
  const old=session('recover-checkpoint',repository);await old.open();await old.submit('Original answer.');await old.pending('offline');
  const fresh=session('recover-checkpoint',repository);await fresh.open();
  const original=fresh.snapshot().submitted;
  await old.save('Original answer.',{answer:'Old page recovery fields.'},'submitted');
  await old.updateView({activeSeconds:4});
  await assert.rejects(fresh.save('Local edited view.',{answer:'Local edited view.'},'submitted'),error=>error.code==='attempt-revision-conflict');
  assert.equal(await fresh.recoverCheckpointConflict(),true);
  await fresh.save('Local edited view.',{answer:'Local edited view.'},'submitted');
  const saved=await repository.read('recover-checkpoint');
  assert.deepEqual(saved.submitted,original);assert.equal(saved.answer,'Original answer.');
  assert.equal(saved.checkpoint.pluginFields.answer,'Local edited view.');assert.equal(saved.formal,null);
});

test('pending checkpoint recovery refuses changed learning evidence, navigation and formal claims',async()=>{
  const changes={
    resolved:peer=>peer.assess({status:'correct',source:'model',explanation:'Saved independently.',rating:'good'}),
    claimed:async peer=>{await peer.assess({status:'correct',source:'model',explanation:'Saved independently.',rating:'good'});await peer.reserve('good');},
    traversed:peer=>peer.traversePending(),
    evaluation:peer=>peer.pending('invalid','New source evidence.')
  };
  for(const [kind,change] of Object.entries(changes)){
    const repository=createLocalAttemptRepository({userId:binding.ownerId,libraryId:binding.libraryId}),id='recover-refuse-'+kind;
    const first=session(id,repository);await first.open();await first.submit('Original answer.');await first.pending('offline');
    const stale=session(id,repository);await stale.open();const original=stale.snapshot();
    await change(first);const accepted=await repository.read(id);
    assert.equal(await stale.recoverCheckpointConflict(),false,kind);
    assert.deepEqual(stale.snapshot(),original,kind);assert.deepEqual(await repository.read(id),accepted,kind);
  }
  const unsubmitted=session('recover-refuse-unsubmitted');await unsubmitted.open();
  assert.equal(await unsubmitted.recoverCheckpointConflict(),false);
});

test('late computed evaluation never retries over a changed pending reason, result, formal claim or traversal',async()=>{
  const changes={
    pending:peer=>peer.pending('invalid','Changed source evidence.'),
    result:peer=>peer.assess({status:'incorrect',source:'model',rating:'again',explanation:'Another saved result.'}),
    formal:async peer=>{await peer.assess({status:'incorrect',source:'model',rating:'again',explanation:'Another saved result.'});await peer.reserve('again');},
    traversal:peer=>peer.traversePending()
  };
  for(const [kind,change] of Object.entries(changes)){
    const repository=createLocalAttemptRepository({userId:binding.ownerId,libraryId:binding.libraryId}),id='late-result-refuse-'+kind;
    let peer,calls=0;
    const current=session(id,repository,{sourceAdmission:async()=>{
      calls++;await change(peer);return {status:'confirmed',outcome:{status:'correct',source:'model',rating:'good',explanation:'Computed reply.'}};
    }});
    await current.open();await current.submit('Original answer.');await current.pending('offline');
    peer=session(id,repository);await peer.open();
    await assert.rejects(current.assess({status:'undetermined',source:'model',explanation:'Restore review.'}),error=>error.code==='attempt-revision-conflict');
    assert.equal(calls,1,kind);
    assert.deepEqual(await repository.read(id),peer.snapshot(),kind);
    assert.equal(current.snapshot().evaluation.status,'pending',kind);assert.equal(current.snapshot().formal,null,kind);
  }
});

test('already linked formal result retains its identity when the original source later disappears',async()=>{
  let proof=null;
  const repository=createLocalAttemptRepository({userId:binding.ownerId,libraryId:binding.libraryId},{verifyFormalEvent:async()=>proof});
  const original=session('linked-source-gone',repository);await original.open();await original.submit('Historical answer.');
  await original.assess({status:'correct',source:'model',explanation:'Confirmed at the time.',rating:'good'});
  const identity=await original.reserve('good');
  proof={eventId:identity.eventId,coreHash:'b'.repeat(64),itemKey:binding.itemKey,contentHash:binding.contentHash,reviewedAt:identity.reviewedAt,rating:'good'};
  await original.link(proof.coreHash);
  const restored=session('linked-source-gone',repository,{sourceAdmission:async()=>({status:'pending',reason:'Source removed.'})});
  await restored.open();assert.deepEqual(await restored.reserve('good'),identity);
  await assert.rejects(()=>restored.reserve('again'),/固定/);
  assert.equal(restored.snapshot().formal.status,'linked');
});
