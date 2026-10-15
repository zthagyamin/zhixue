import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';

const {StudyGuidanceHelp,StudyGuidance,StudyRoundGuidance}=loadTsx(new URL('../app/study-guidance.tsx',import.meta.url));
const render=(Component,props)=>renderToStaticMarkup(React.createElement(Component,props));

test('durable recall help explains pending verification rather than automatic self-assessment',()=>{
  const html=render(StudyGuidanceHelp,{kind:'recall',pendingEvaluation:true});
  assert.match(html,/待核对/);assert.match(html,/保存后可继续/);
  assert.doesNotMatch(html,/AI 无法判定时保留对照自评/);
});
test('inline durable recall help uses its actual learning port',()=>{
  const html=render(StudyGuidance,{topic:'recall',context:{nonWordLearning:{ready:true}}});
  assert.match(html,/待核对/);assert.doesNotMatch(html,/AI 无法判定时保留对照自评/);
});
test('legacy and vocabulary-switch recall help preserves its original explanation',()=>{
  assert.match(render(StudyGuidanceHelp,{kind:'recall'}),/AI 无法判定时保留对照自评/);
  assert.match(render(StudyGuidance,{topic:'recall',context:{}}),/AI 无法判定时保留对照自评/);
});
test('flashcard and word help stay identical regardless of pending-capable parent',()=>{
  for(const kind of ['three-stage','spelling','flashcard'])assert.equal(render(StudyGuidanceHelp,{kind}),render(StudyGuidanceHelp,{kind,pendingEvaluation:true}));
});
test('extracted completed-round help preserves count and mastery boundary',()=>{
  const html=render(StudyRoundGuidance,{resets:7,kind:'recall',pendingEvaluation:true});
  assert.match(html,/本轮记录与操作说明/);assert.match(html,/7 次需重练作答/);
  assert.match(html,/次数不代表掌握度/);assert.match(html,/待核对/);
  assert.match(render(StudyRoundGuidance,{resets:7,kind:'recall'}),/AI 无法判定时保留对照自评/);
});
