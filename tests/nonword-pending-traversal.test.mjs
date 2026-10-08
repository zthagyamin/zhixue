import test from 'node:test';
import assert from 'node:assert/strict';
import {reopenAwaitingSubjectRound} from '../src/domain/planning/index.ts';
import {awaitSubjectReview,isSubjectPassComplete,isSubjectRoundComplete} from '../src/domain/planning/subject-round.ts';
test('saved unknown answer can leave traversal without becoming correct, skipped or official-complete',()=>{
  const keys=['a','b'],initial={correctKeys:[],wrongKeys:[],resets:0};
  const first=awaitSubjectReview(initial,keys,0);
  assert.equal(first.nextIndex,1);assert.equal(first.complete,false);
  assert.deepEqual(first.round.correctKeys,[]);assert.deepEqual(first.round.wrongKeys,[]);assert.deepEqual(first.round.skippedKeys,[]);
  const second=awaitSubjectReview(first.round,keys,1);
  assert.equal(isSubjectPassComplete(second.round,keys),true);
  assert.equal(isSubjectRoundComplete({pluginType:'quiz',items:keys,keyOf:value=>value,itemStages:{},round:second.round}),false);
  assert.deepEqual(second.round.awaitingReviewKeys,keys);
});


test('reopening pending answers preserves known first results and selects the same unresolved item',()=>{
  const original={correctKeys:['A'],wrongKeys:['C'],reviewedKeys:['C'],resets:1,awaitingReviewKeys:['B']};
  const restored=reopenAwaitingSubjectRound(original,['A','B','C']);
  assert.equal(restored.nextIndex,1);assert.deepEqual(restored.round.correctKeys,['A']);assert.deepEqual(restored.round.wrongKeys,['C']);assert.deepEqual(restored.round.reviewedKeys,['C']);assert.deepEqual(restored.round.awaitingReviewKeys,[]);assert.deepEqual(original.awaitingReviewKeys,['B']);assert.equal(restored.complete,false);
});
