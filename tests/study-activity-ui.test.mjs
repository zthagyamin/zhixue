import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
const samples=[
  ['spelling','plugins/plugin-spelling.tsx','SpellingPlugin',{word:'cat',meaning:'猫'},'拼写输入'],
  ['flashcard','plugins/plugin-flashcard.tsx','FlashcardPlugin',{front:'什么是检索练习？',back:'从记忆中提取知识。'},'显示答案'],
  ['quiz','plugins/plugin-quiz.tsx','QuizPlugin',{topic:'阅读',prompt:'选择正确项',options:['甲','乙'],answer:'乙',explanation:'解释'},'选择正确项'],
  ['recall','plugin-recall.tsx','RecallPlugin',{prompt:'闭卷回忆结论',explanation:'要点'},'写下你回忆到的内容'],
  ['calculation','plugin-calculation.tsx','CalculationPlugin',{prompt:'1 + 2 = ?',answer:3},'你的答案'],
  ['code','plugins/plugin-code.tsx','CodePlugin',{topic:'Python',prompt:'实现加法',initialCode:'def add(a, b):\n    pass',testCode:'assert add(1,2)==3',solutionCode:'',explanation:''},'Python 代码编辑器'],
];
for(const [kind,file,name,data,action]of samples)test(`${kind} uses the shared activity surface and retains its learning controls`,()=>{
  const plugin=loadTsx(new URL(`../app/${file}`,import.meta.url))[name];
  const html=renderToStaticMarkup(createElement(plugin.renderUI,{data,onGrade(){}}));
  assert.match(html,new RegExp(`data-study-activity="${kind}"`));assert.ok(html.includes(action));
});

test('long quiz material is readable body text with original paragraphs, not one oversized heading',()=>{
  const {QuizPlugin}=loadTsx(new URL('../app/plugins/plugin-quiz.tsx',import.meta.url));
  const prompt=('Read this complete synthetic paragraph carefully. '.repeat(8))+'\n\nSecond paragraph.\n\nWhat follows?';
  let grades=0;
  const render=text=>renderToStaticMarkup(createElement(QuizPlugin.renderUI,{data:{topic:'Reading',prompt:text,options:['A','B'],answer:'A',explanation:'Reason'},onGrade(){grades++;}}));
  const html=render(prompt);
  assert.match(html,/<p class="study-question study-reading-material">/);
  assert.ok(html.includes(prompt));assert.doesNotMatch(html,/<h2/);assert.equal(grades,0);
  assert.match(render('A short question?'),/<h2 class="study-question">/);
});
