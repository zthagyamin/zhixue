import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';

test('a cold practice entry loads the quiz instead of revealing its answer as a self-rating card',()=>{
  const {PracticeSession}=loadTsx(new URL('../app/practice-session.tsx',import.meta.url));
  let attempts=0;
  const item={itemId:'cold-quiz',fingerprint:'cold-fixture',questionType:'quiz',sourceLabel:'隔离测试',abilityId:'fixture',prompt:'选择 2 + 2 的结果',options:['3','4'],answer:1,explanation:'不应在作答前出现的解析'};
  const html=renderToStaticMarkup(createElement(PracticeSession,{items:[item],onRecordAttempt:()=>attempts++}));
  assert.match(html,/正在加载选择题/);
  assert.doesNotMatch(html,/不应在作答前出现的解析|>不记得<|>记得</);
  assert.equal(attempts,0);
});
