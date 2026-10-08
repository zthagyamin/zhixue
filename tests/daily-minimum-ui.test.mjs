import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseLongTermPlanSnapshot} from '../app/long-term-plan-types.ts';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {vocabularyInput} from './fixtures/task-plan-input.mjs';
import {generateTaskPlan} from '../app/task-plan-engine.ts';
const shared=JSON.parse(readFileSync(new URL('./fixtures/long-term-minimum.json',import.meta.url),'utf8'));
test('shared minimum and advisory snapshots validate and reject semantic drift',()=>{
 for(const snapshot of shared.validSnapshots)assert.deepEqual(parseLongTermPlanSnapshot(snapshot),snapshot);
 for(const c of shared.invalidCases){const value=structuredClone(shared.validSnapshots[c.base]);let parent=value;for(const key of c.path.slice(0,-1))parent=parent[key];parent[c.path.at(-1)]=c.value;assert.throws(()=>parseLongTermPlanSnapshot(value),undefined,c.name);}
});
test('daily UI retains missing minimum after the three available words are assigned',async()=>{
 const input=vocabularyInput(3),plan=await generateTaskPlan(input);
 const {DailyMinimumStatus}=loadTsx(new URL('../src/features/planning/daily-minimum-status.tsx',import.meta.url));
 const spec={startDate:input.day,targetDeadline:input.day,subjectsConfig:[{subjectId:'vocab',dailyMinimumTarget:20}]};
 const html=renderToStaticMarkup(h(DailyMinimumStatus,{spec,plan,day:input.day,names:{vocab:'学术词库'}})).replace(/<!--.*?-->/g,'');
 assert.match(html,/仍缺 17 个新词/);assert.match(html,/最低 20/);assert.match(html,/完成已安排的任务不等于达到最低量/);
});
test('homepage separates total assigned vocabulary from the next group',()=>{
 const {DashboardFocusHero}=loadTsx(new URL('../app/dashboard-focus-hero.tsx',import.meta.url));
 const html=renderToStaticMarkup(h(DashboardFocusHero,{summary:{groups:2,minutes:null,blocked:0,newWords:25},lead:{taskId:'a',title:'学术词库 · 新学单词 · 2 词',kind:'next'},disabled:false,onStart(){},onAdvanced(){}}));
 assert.match(html,/今日已安排新词 25 个/);assert.match(html,/下一组：学术词库 · 新学单词 · 2 词/);
});
