import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB} from 'fake-indexeddb';
import {createLocalAttemptRepository,attemptFingerprint,evaluationFingerprint} from '../src/infrastructure/learning-attempt/index.ts';
import {createNonWordSession} from '../src/application/nonword-study/session.ts';
globalThis.indexedDB=indexedDB;
const binding={ownerId:'session-user',libraryId:'session-library',snapshotId:'snapshot',itemKey:'question',contentHash:'a'.repeat(64),groupId:'group',roundId:'round'};
function session(id,repository=createLocalAttemptRepository({userId:binding.ownerId,libraryId:binding.libraryId})){
  return createNonWordSession({repository,binding,attemptId:id,formalEventId:`event-${id}`,mode:'recall',newId:()=>crypto.randomUUID(),now:()=>new Date().toISOString(),fingerprint:attemptFingerprint,evaluationFingerprint});
}
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
