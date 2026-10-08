import assert from 'node:assert/strict';
import test from 'node:test';
import {applyAttemptMutation, parseAttemptMutation} from '../src/domain/learning-attempt/index.ts';
const binding = {ownerId:'u',libraryId:'l',snapshotId:'s',itemKey:'i',contentHash:'a'.repeat(64),groupId:'g',roundId:'r'};
const base = {schemaVersion:1,attemptId:'a',operationId:'op',binding,expectedRevision:0,updatedAt:'2026-10-05T00:00:00Z'};
const checkpoint = {...base,kind:'checkpoint',answer:'first answer',parentAttemptId:null,checkpoint:{phase:'answering',position:0,traversed:false,mode:'recall',purpose:'first'}};
const advance = (state, body) => applyAttemptMutation(state,parseAttemptMutation({...base,expectedRevision:state?.revision ?? 0,...body})).attempt;
test('submitted first work is immutable, assistance and semantic outcome stay separate from capped rating',()=>{
  let state=advance(null,checkpoint);
  state=advance(state,{kind:'submit',operationId:'submit',answerRevision:1,assistance:'observed'});
  assert.throws(()=>advance(state,{...checkpoint,expectedRevision:state.revision,operationId:'rewrite',answer:'corrected'}),/immutable/);
  state=advance(state,{kind:'evaluate',operationId:'grade',answerRevision:1,evaluation:{status:'resolved',rating:'good',correct:true,outcome:'correct',source:'model',feedback:'Correct under the source.',evaluationHash:'b'.repeat(64),referenceHash:binding.contentHash}});
  state=advance(state,{kind:'claim-formal',operationId:'claim',eventId:'official',occurredAt:base.updatedAt,evaluationHash:'b'.repeat(64),rating:'again'});
  assert.equal(state.submitted.answer,'first answer'); assert.equal(state.evaluation.rating,'good'); assert.equal(state.formal.rating,'again'); assert.equal(state.evaluation.source,'model');
  assert.throws(()=>advance(state,{kind:'evaluate',operationId:'regrade',answerRevision:1,evaluation:{status:'pending',reason:'offline'}}),/finalized/);
});
test('unknown evaluation cannot create a grade; later result binds the original answer and reference',()=>{
  let state=advance(null,checkpoint);state=advance(state,{kind:'submit',operationId:'s',answerRevision:1,assistance:'unknown'});
  state=advance(state,{kind:'evaluate',operationId:'offline',answerRevision:1,evaluation:{status:'pending',reason:'offline'}});
  assert.throws(()=>advance(state,{kind:'claim-formal',operationId:'c',eventId:'e',occurredAt:base.updatedAt,evaluationHash:'b'.repeat(64),rating:'again'}),/pending/);
  const evaluation={status:'resolved',rating:'again',correct:false,outcome:'incorrect',source:'deterministic',feedback:'Wrong.',evaluationHash:'b'.repeat(64),referenceHash:'c'.repeat(64)};
  assert.throws(()=>advance(state,{kind:'evaluate',operationId:'g',answerRevision:1,evaluation}),/reference-conflict/);
  assert.throws(()=>advance(state,{kind:'evaluate',operationId:'g',answerRevision:2,evaluation:{...evaluation,referenceHash:binding.contentHash}}),/submission-binding/);
  state=advance(state,{kind:'evaluate',operationId:'g',answerRevision:1,evaluation:{...evaluation,referenceHash:binding.contentHash}});
  assert.throws(()=>advance(state,{kind:'claim-formal',operationId:'c',eventId:'e',occurredAt:base.updatedAt,evaluationHash:'b'.repeat(64),rating:'good'}),/rating-increase/);
});
test('CAS, repeat operation receipt and changed payload conflict do not replace evidence',()=>{
  const first=applyAttemptMutation(null,checkpoint);assert.equal(first.attempt.revision,1);
  assert.equal(applyAttemptMutation(first.attempt,checkpoint).status,'duplicate');
  assert.equal(applyAttemptMutation(first.attempt,{...checkpoint,answer:'different'}).status,'conflict');
  assert.equal(applyAttemptMutation(first.attempt,{...checkpoint,operationId:'other'}).status,'conflict');
  assert.throws(()=>parseAttemptMutation({...checkpoint,checkpoint:{...checkpoint.checkpoint,pluginFields:{rawSourceNote:'secret original'}}}),/fields/);
});
test('lesson traversal has no formal completion; remediation child remains separate evidence',()=>{
  const state=advance(null,{...checkpoint,checkpoint:{phase:'lesson',position:2,traversed:true,mode:'lesson',intent:'lesson',purpose:'guided',visited:['i'],pending:['j'],skipped:[]}});
  assert.equal(state.formal,null);assert.equal(state.submitted,null);assert.equal(state.evaluation.status,'pending');
  assert.throws(()=>parseAttemptMutation({...checkpoint,checkpoint:{...checkpoint.checkpoint,pluginFields:{answer:'a'.repeat(32001)}}}),/plugin-fields/);
});
test('contradictory model semantic ratings abstain at parsing, before becoming a formal grade',()=>{
  const evaluation={status:'resolved',rating:'easy',correct:true,outcome:'correct',source:'model',feedback:'Synthetic',evaluationHash:'b'.repeat(64),referenceHash:binding.contentHash};
  assert.throws(()=>parseAttemptMutation({...base,kind:'evaluate',answerRevision:1,evaluation}),/model-evaluation/);
  assert.throws(()=>parseAttemptMutation({...base,kind:'evaluate',answerRevision:1,evaluation:{...evaluation,correct:false,outcome:'partial',rating:'good'}}),/inconsistent/);
});

test('guided work without a first submission parent is still auxiliary and cannot claim an official result',()=>{
  let state=advance(null,{...checkpoint,checkpoint:{...checkpoint.checkpoint,purpose:'guided',intent:'lesson'}});
  state=advance(state,{kind:'submit',operationId:'guided-submit',answerRevision:1,assistance:'unknown'});
  state=advance(state,{kind:'evaluate',operationId:'guided-evaluate',answerRevision:1,evaluation:{status:'resolved',rating:'good',correct:true,outcome:'correct',source:'model',feedback:'Guided result.',evaluationHash:'b'.repeat(64),referenceHash:binding.contentHash}});
  assert.equal(state.submitted.assistance,'observed');
  assert.throws(()=>advance(state,{kind:'claim-formal',operationId:'guided-claim',eventId:'guided-official',occurredAt:base.updatedAt,evaluationHash:'b'.repeat(64),rating:'again'}),/not-formal/);
});

test('starting evidence never moves with autosave and older missing evidence is not invented',()=>{
  const first=advance(null,checkpoint);assert.equal(first.startedAt,base.updatedAt);
  const later=advance(first,{...checkpoint,expectedRevision:first.revision,operationId:'later-save',updatedAt:'2026-10-06T00:00:00Z',answer:'saved again'});
  assert.equal(later.startedAt,base.updatedAt);assert.equal(later.updatedAt,'2026-10-06T00:00:00Z');
  const legacy=structuredClone(first);delete legacy.startedAt;
  assert.equal(advance(legacy,{...checkpoint,expectedRevision:legacy.revision,operationId:'legacy-save',updatedAt:'2026-10-06T00:00:00Z'}).startedAt,undefined);
  assert.throws(()=>parseAttemptMutation({...checkpoint,startedAt:'2026-10-06T00:00:00Z'}),/field/);
});
