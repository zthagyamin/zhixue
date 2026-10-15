import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {loadTsx} from './fixtures/tsx-components.mjs';
const {LearningDraftNotice}=loadTsx(new URL('../app/learning-draft.tsx',import.meta.url));
const notice=store=>renderToStaticMarkup(createElement(LearningDraftNotice,{store}));

test('saved parent feedback cannot claim its dirty page-only child is durably saved',()=>{
  const store=createLearningDraftStore('nonword-recovery-notice'),parent=store.adapter('saved-parent','recall');
  parent.read('answer','');parent.write('answer','first answer');let continued=0;
  store.commit(parent.begin(),()=>{continued++;});
  const child=parent.createTemporary({answer:''});child.write('answer','temporary retry');
  const html=notice(store);
  assert.equal(store.hasUnsavedInput(),true);assert.equal(store.hasUnrecoverableInput(),true);
  assert.equal(store.hasDurableRecovery(),false);
  assert.match(html,/输入仅暂存在当前页面/);assert.doesNotMatch(html,/输入已保存在本机/);
  assert.equal(parent.hasSavedFeedback(),true);assert.equal(continued,0);assert.equal(child.read('answer'),'temporary retry');
});

test('recovery receipt for another original answer cannot cover temporary child input',()=>{
  const store=createLearningDraftStore('nonword-recovery-notice'),parent=store.adapter('original','recall');
  parent.read('answer','');parent.write('answer','draft');assert.equal(parent.markInputRecovered(parent.inputRevision()),true);
  assert.equal(store.hasDurableRecovery(),true);
  const child=parent.createTemporary({answer:''});child.write('answer','unsaved retry');
  assert.equal(store.hasDurableRecovery(),false);assert.equal(store.hasUnrecoverableInput(),true);
  child.dispose();assert.equal(store.hasDurableRecovery(),true);assert.equal(store.hasUnrecoverableInput(),false);
  assert.match(notice(store),/输入已保存在本机/);
});

test('new tutor input after a saved result remains page-only until its own exact revision is recovered',()=>{
  const store=createLearningDraftStore('nonword-recovery-notice'),parent=store.adapter('original','recall');
  parent.read('answer','');parent.write('answer','first answer');store.commit(parent.begin(),()=>{});
  parent.read('tutor.question','');parent.write('tutor.question','unsent followup');
  assert.equal(store.hasDurableRecovery(),false);assert.equal(store.hasUnrecoverableInput(),true);
  assert.match(notice(store),/输入仅暂存在当前页面/);
  assert.equal(parent.markInputRecovered(parent.inputRevision()-1),false);
  assert.equal(parent.markInputRecovered(parent.inputRevision()),true);assert.equal(store.hasDurableRecovery(),true);
});
