import test from 'node:test';
import assert from 'node:assert/strict';
import {isNonWordOriginal, quizMaterial, evaluateSelection, transitionQuiz} from '../src/domain/content/nonword-learning.ts';

test('original vocabulary remains vocabulary when displayed as quiz or flashcard', () => {
  for (const source of [{word:'retain',meaning:'保留'}, {kind:'word'}, {eventKind:'word'}, {pluginType:'three-stage'}, {type:'spelling'}]) {
    assert.equal(isNonWordOriginal('quiz', source), false);
    assert.equal(isNonWordOriginal('flashcard', source), false);
  }
  assert.equal(isNonWordOriginal('quiz',{prompt:'Explain the condition',answer:'Independent samples'}),true);
  assert.equal(isNonWordOriginal('flashcard',{front:'What is a mutex?',back:'Mutual exclusion'}),true);
  assert.equal(isNonWordOriginal('paper',{}),false);
});

test('old and structured choice materials use one explicit-submit model without changing source', () => {
  const old={prompt:'Which condition?',options:['Independence','Length'],answer:'Independence',explanation:'Samples must be independent.'};
  const before=structuredClone(old), material=quizMaterial(old);
  assert.deepEqual(old,before);
  assert.equal(material.selection,'single');
  assert.deepEqual(material.correctIds,['option-0']);
  assert.throws(()=>quizMaterial({...old,options:['Independence','Independence']}),/ambiguous/);
});

test('incorrect submission reveals precise feedback and can finish without guessing the answer', () => {
  const material=quizMaterial({options:['right','wrong'],answer:'right'});
  let state={selection:[],first:null,phase:'answer',retry:null};
  state=transitionQuiz(state,{type:'choose',id:'option-1'},material);
  assert.equal(state.first,null);
  state=transitionQuiz(state,{type:'submit'},material);
  assert.deepEqual(state.first,{selection:['option-1'],result:{status:'incorrect',matched:[],missing:['option-0'],wrong:['option-1']}});
  assert.equal(state.phase,'feedback');
  assert.strictEqual(transitionQuiz(state,{type:'submit'},material),state);
});

test('partial multiple-choice and successful remediation retain immutable first failure', () => {
  const material={selection:'multiple',options:[{id:'a',text:'A'},{id:'b',text:'B'},{id:'c',text:'C'}],correctIds:['a','b']};
  assert.equal(evaluateSelection(material,['a']).status,'partial');
  let state={selection:['c'],first:null,phase:'answer',retry:null};
  state=transitionQuiz(state,{type:'submit'},material);
  const first=structuredClone(state.first);
  state=transitionQuiz(state,{type:'retry'},material);
  state=transitionQuiz(state,{type:'choose',id:'a'},material);
  state=transitionQuiz(state,{type:'choose',id:'b'},material);
  state=transitionQuiz(state,{type:'submit-retry'},material);
  assert.equal(state.retry.status,'correct');
  assert.deepEqual(state.first,first);
  assert.equal(state.first.result.status,'incorrect');
});
