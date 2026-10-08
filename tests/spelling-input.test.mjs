import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
import * as core from '../app/plugins/spelling-core.ts';
const state={word:'cat',input:'',wrong:'',wrongCount:0};
test('spelling exposes a real touchable input rather than a hidden keyboard trap',()=>{
  const {SpellingPlugin}=loadTsx(new URL('../app/plugins/plugin-spelling.tsx',import.meta.url));
  const html=renderToStaticMarkup(createElement(SpellingPlugin.renderUI,{data:{word:'cat',meaning:'猫'},onGrade(){}}));
  const input=html.match(/<input[^>]*aria-label="拼写输入"[^>]*>/)?.[0];
  assert.ok(input);assert.doesNotMatch(input,/opacity-0|w-px|h-px/);assert.match(input,/inputMode="text"/);
});
test('mobile edits use the same letter-by-letter spelling state and block after an error',()=>{
  assert.equal(typeof core.evaluateSpellingEdit,'function');
  const first=core.evaluateSpellingEdit(state,'c');assert.deepEqual(first,core.evaluateKeypress(state,'c'));
  const wrong=core.evaluateSpellingEdit(first,'cx');assert.equal(wrong.wrong,'x');assert.equal(wrong.wrongCount,1);
  assert.deepEqual(core.evaluateSpellingEdit(wrong,'cxa'),wrong);
  const cleared=core.evaluateSpellingEdit(wrong,'c');assert.equal(cleared.wrong,'');assert.equal(cleared.wrongCount,1);
  const next=core.evaluateSpellingEdit(cleared,'ca');assert.equal(core.evaluateSpellingEdit(next,'cat').input,'cat');
});
test('bulk replacement or paste cannot bypass spelling steps, and deleting retains mistake count',()=>{
  assert.equal(typeof core.evaluateSpellingEdit,'function');
  assert.deepEqual(core.evaluateSpellingEdit(state,'cat'),state);
  const current={...state,input:'ca',wrongCount:3};
  assert.deepEqual(core.evaluateSpellingEdit(current,'ct'),current);
  assert.deepEqual(core.evaluateSpellingEdit(current,''),{...state,wrongCount:3});
});
