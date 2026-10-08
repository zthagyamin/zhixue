import assert from 'node:assert/strict';
import test from 'node:test';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
function fixture(mode='quiz:1'){
  const store=createLearningDraftStore('owner:library'),draft=store.adapter('private question / answer / path',mode),observer=draft.assistance;
  assert.equal(typeof observer?.cover,'function','Page-local assistance observer must exist');return{store,draft,observer};
}
const empty={observationScope:'current-page-attempt',preSubmitAssistance:[],postSubmitFeedback:[]};
test('uncovered plugins remain unknown and coverage does not invent a draft input',()=>{
  const f=fixture();assert.equal(f.observer.snapshot(),null);f.observer.cover();assert.equal(f.store.hasBuffers(),false);
  assert.deepEqual(f.observer.snapshot(),empty);
});
test('first actual submission separates prior help from later feedback without freezing answer input',()=>{
  const f=fixture();f.observer.cover();f.observer.shown('reference-answer','reference-one');f.observer.submit();f.observer.submit();
  assert.equal(f.draft.write('answer','still editing'),true);f.observer.shown('ai-hint','reply-one');f.observer.shown('answer-feedback','result-one');
  assert.deepEqual(f.observer.snapshot(),{...empty,preSubmitAssistance:[{action:'reference-answer',count:1}],postSubmitFeedback:[{action:'ai-hint',count:1},{action:'answer-feedback',count:1}]});
});
test('same rendered aid is counted once across remounts and mode returns',()=>{
  const f=fixture();f.observer.cover();assert.equal(f.observer.shown('ai-hint','reply-one'),true);
  const other=f.store.adapter('private question / answer / path','recall:1').assistance;other.cover();other.submit();
  const restored=f.store.adapter('private question / answer / path','quiz:1').assistance;restored.cover();restored.submit();
  assert.equal(restored.shown('ai-hint','reply-one'),false);restored.shown('ai-hint','reply-two');
  assert.deepEqual(restored.snapshot(),{...empty,preSubmitAssistance:[{action:'ai-hint',count:1}],postSubmitFeedback:[{action:'ai-hint',count:1}]});assert.deepEqual(other.snapshot(),empty);
});
test('snapshot returns only detached behavior counts, never display IDs or draft content',()=>{
  const f=fixture();f.observer.cover();f.draft.write('answer','SECRET answer');f.observer.shown('meaning-check','opaque-display-id');
  const summary=f.observer.snapshot();summary.preSubmitAssistance[0].count=9;
  assert.deepEqual(f.observer.snapshot(),{...empty,preSubmitAssistance:[{action:'meaning-check',count:1}]});assert.doesNotMatch(JSON.stringify(summary),/SECRET|private|opaque-display|path/);
});
test('save failure retains exactly the frozen observation instead of recounting later renders',()=>{
  const f=fixture();f.observer.cover();f.observer.shown('meaning-study','reveal');const ticket=f.draft.begin(),frozen=f.observer.snapshot();f.store.fail(ticket);
  assert.equal(f.observer.shown('ai-tutor','late-reply'),false);assert.deepEqual(f.observer.snapshot(),frozen);assert.ok(f.draft.begin());
});
test('commit clears sibling observations and invalidates old display callbacks',()=>{
  const f=fixture(),sibling=f.store.adapter('private question / answer / path','flashcard:1').assistance;f.observer.cover();sibling.cover();sibling.shown('reference-answer','back');
  const ticket=f.draft.begin();f.observer.snapshot();f.store.commit(ticket);
  assert.equal(sibling.shown('ai-tutor','late'),false);assert.equal(sibling.snapshot(),null);assert.equal(f.observer.snapshot(),null);
  const next=f.store.adapter('private question / answer / path','flashcard:1').assistance;next.cover();assert.deepEqual(next.snapshot(),empty);
});
for(const action of ['clear','dispose'])test(`${action} makes all old assistance observers inert`,()=>{
  const f=fixture();f.observer.cover();f.store[action]();assert.equal(f.observer.cover(),false);assert.equal(f.observer.submit(),false);assert.equal(f.observer.shown('ai-hint','late'),false);assert.equal(f.observer.snapshot(),null);
});
test('post-submit feedback cannot be recorded before an actual submission',()=>{
  const f=fixture();f.observer.cover();assert.equal(f.observer.shown('answer-feedback','result'),false);assert.deepEqual(f.observer.snapshot(),empty);
});
test('invalid observation inputs cannot be presented as a complete empty summary',()=>{
  const f=fixture();f.observer.cover();assert.equal(f.observer.shown('ai-hint','private text / path'),false);assert.equal(f.observer.snapshot(),null);
});
