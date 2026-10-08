import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory} from 'fake-indexeddb';
import {applyAttemptMutation,parseAttemptMutation} from '../src/domain/learning-attempt/index.ts';
import {createLocalAttemptRepository,evaluationFingerprint} from '../src/infrastructure/learning-attempt/index.ts';
const binding={ownerId:'hint-owner',libraryId:'hint-library',snapshotId:'source-v1',itemKey:'recall-question',contentHash:'a'.repeat(64),groupId:'group',roundId:'round'};
const base={schemaVersion:1,attemptId:'hint-attempt',operationId:'checkpoint',binding,expectedRevision:0,updatedAt:'2026-10-05T00:00:00Z'};
const checkpoint={...base,kind:'checkpoint',answer:'First answer',parentAttemptId:null,checkpoint:{phase:'answering',position:0,traversed:false,mode:'recall',purpose:'first'}};
const mutate=(state,body)=>applyAttemptMutation(state,parseAttemptMutation({...base,expectedRevision:state?.revision??0,...body})).attempt;
function resolved(extra={},mode='recall') {
  let state=mutate(null,{...checkpoint,checkpoint:{...checkpoint.checkpoint,mode}});
  state=mutate(state,{kind:'submit',operationId:'submit',answerRevision:1,assistance:'unknown',...extra});
  return mutate(state,{kind:'evaluate',operationId:'evaluate',answerRevision:1,evaluation:{status:'resolved',rating:'good',correct:true,outcome:'correct',source:'model',feedback:'Semantically correct.',evaluationHash:'b'.repeat(64),referenceHash:binding.contentHash}});
}
const claim=rating=>({kind:'claim-formal',operationId:'claim',eventId:'official',occurredAt:base.updatedAt,evaluationHash:'b'.repeat(64),rating});
test('hint level and revealed flag are validated additive evidence, absent or zero does not prove independence',()=>{
  const state=resolved();assert.equal(state.submitted.assistance,'unknown');assert.equal('maxPreHintLevel' in state.submitted,false);assert.equal('answerRevealed' in state.submitted,false);
  const zero=resolved({maxPreHintLevel:0,answerRevealed:false});assert.equal(zero.submitted.assistance,'unknown');assert.equal(zero.submitted.maxPreHintLevel,0);
  for(const level of [-1,4,1.5,'2']) assert.throws(()=>parseAttemptMutation({...base,kind:'submit',answerRevision:1,assistance:'unknown',maxPreHintLevel:level}),/hint-level/);
  assert.throws(()=>parseAttemptMutation({...base,kind:'submit',answerRevision:1,assistance:'unknown',answerRevealed:'false'}),/answer-revealed/);
});
test('frozen normalized recall hints enforce existing hard/again caps after first submission',()=>{
  const two=resolved({maxPreHintLevel:2,answerRevealed:false});assert.equal(two.submitted.assistance,'observed');
  assert.throws(()=>mutate(two,claim('good')),/hint-cap/);assert.equal(mutate(two,claim('hard')).formal.rating,'hard');
  const three=resolved({maxPreHintLevel:3,answerRevealed:true});assert.throws(()=>mutate(three,claim('hard')),/hint-cap/);assert.equal(mutate(three,claim('again')).formal.rating,'again');
  const revealed=resolved({maxPreHintLevel:0,answerRevealed:true});assert.throws(()=>mutate(revealed,claim('good')),/hint-cap/);
  assert.throws(()=>mutate(three,{kind:'submit',operationId:'reset',answerRevision:1,assistance:'independent',maxPreHintLevel:0,answerRevealed:false}),/already-submitted/);
  const later=mutate(three,{...checkpoint,operationId:'hide-reference',expectedRevision:three.revision,checkpoint:{...checkpoint.checkpoint,pluginFields:{revealed:'false'}}});
  assert.equal(later.submitted.answerRevealed,true);assert.equal(later.submitted.maxPreHintLevel,3);assert.throws(()=>mutate(later,claim('good')),/hint-cap/);
});
test('guided work is observed and recall-only caps do not change other mode policies',()=>{
  let guided=mutate(null,{...checkpoint,checkpoint:{...checkpoint.checkpoint,purpose:'guided'}});
  guided=mutate(guided,{kind:'submit',operationId:'s',answerRevision:1,assistance:'independent'});assert.equal(guided.submitted.assistance,'observed');
  const quiz=resolved({maxPreHintLevel:3,answerRevealed:true},'quiz');assert.equal(mutate(quiz,claim('good')).formal.rating,'good');
});
test('second device restores frozen recall exposure from real IndexedDB and cannot claim uncapped grade',async()=>{
  const saved=globalThis.indexedDB;
  try {
    globalThis.indexedDB=new IDBFactory();
    const first=createLocalAttemptRepository({userId:binding.ownerId,libraryId:binding.libraryId});
    await first.mutate(checkpoint);
    await first.mutate({...base,kind:'submit',operationId:'submit',expectedRevision:1,answerRevision:1,assistance:'unknown',maxPreHintLevel:3,answerRevealed:true});
    const evaluation={status:'resolved',rating:'good',correct:true,outcome:'correct',source:'model',feedback:'Semantically correct.',referenceHash:binding.contentHash};evaluation.evaluationHash=await evaluationFingerprint(evaluation);
    await first.mutate({...base,kind:'evaluate',operationId:'evaluation',expectedRevision:2,answerRevision:1,evaluation});
    const remote=structuredClone(await first.read(base.attemptId));
    globalThis.indexedDB=new IDBFactory();
    const second=createLocalAttemptRepository({userId:binding.ownerId,libraryId:binding.libraryId});
    assert.equal((await second.refresh({list:async()=>[remote]})).restored,1);
    const restored=await second.read(base.attemptId);assert.equal(restored.submitted.maxPreHintLevel,3);assert.equal(restored.submitted.answerRevealed,true);assert.equal(restored.submitted.assistance,'observed');
    const request={...base,...claim('good'),expectedRevision:3,evaluationHash:evaluation.evaluationHash};
    await assert.rejects(second.mutate(request),/hint-cap/);
    assert.equal((await second.mutate({...request,rating:'again'})).attempt.formal.rating,'again');
  } finally {if(saved===undefined) delete globalThis.indexedDB;else globalThis.indexedDB=saved;}
});
