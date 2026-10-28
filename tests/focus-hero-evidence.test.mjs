import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';

const {DashboardFocusHero}=loadTsx(new URL('../app/dashboard-focus-hero.tsx',import.meta.url));
const props={summary:{groups:1,minutes:null,blocked:0},lead:{taskId:'task',title:'新词学习',kind:'continue'},disabled:false,onStart(){},onAdvanced(){}};
test('continuing a verified task shows its real subject and confirmed progress',()=>{
  const html=renderToStaticMarkup(createElement(DashboardFocusHero,{...props,subjectName:'学术英语',progress:{completed:3,total:20}}));
  assert.match(html,/学术英语/);assert.match(html,/3\s*\/\s*20/);assert.match(html,/继续今日任务/);
});
test('unverified progress is omitted rather than fabricated as zero',()=>{
  const unknown=renderToStaticMarkup(createElement(DashboardFocusHero,{...props,subjectName:'学术英语'}));
  assert.match(unknown,/学术英语/);assert.doesNotMatch(unknown,/0\s*\/\s*20/);
  for(const progress of [{completed:0,total:0},{completed:-1,total:20},{completed:21,total:20},{completed:NaN,total:20}]){
    const html=renderToStaticMarkup(createElement(DashboardFocusHero,{...props,progress}));assert.doesNotMatch(html,/本项进度/);
  }
});
