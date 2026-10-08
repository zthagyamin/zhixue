import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
const {StudyTermHelp}=loadTsx(new URL('../app/study-term-help.tsx',import.meta.url));
const {DemoModeBadge}=loadTsx(new URL('../app/demo-mode-badge.tsx',import.meta.url));
test('terminology disclosures have real keyboard controls and unique explanation targets',()=>{
 const html=renderToStaticMarkup(h('div',null,...['review','companion','managed'].map(term=>h(StudyTermHelp,{key:term,term}))));
 assert.equal((html.match(/aria-expanded="false"/g)??[]).length,3);
 assert.equal((html.match(/hidden=""/g)??[]).length,3);
 const targets=[...html.matchAll(/aria-controls="([^"]+)"/g)].map(match=>match[1]);assert.equal(new Set(targets).size,3);
 for(const id of targets)assert.ok(html.includes(`id="${id}"`));
 for(const term of ['FSRS','Companion','受管区域'])assert.ok(html.includes(term));
 assert.match(html,/type="button"/);assert.match(html,/aria-label="复习安排：这是什么？"/);
});
test('the quiet demo badge still explicitly identifies the mode and record boundary',()=>{
 const html=renderToStaticMarkup(h(DemoModeBadge));
 assert.match(html,/示例体验 · 不计入个人记录/);assert.doesNotMatch(html,/alert|amber|warning|达标|已掌握/);
});
test('all completion branches retain mode identification while real migration warnings are unchanged',()=>{
 const read=path=>readFileSync(new URL('../app/'+path,import.meta.url),'utf8');
 assert.match(read('study-dashboard/today-view.tsx'),/isDemoMode\?<DemoModeBadge\/>/);
 assert.equal((read('study-dashboard/subject-view.tsx').match(/isDemoMode&&<DemoModeBadge\/>/g)??[]).length,3);
 assert.match(read('study-dashboard/dashboard-view.tsx'),/showMigrationBanner && <section[^>]*border-amber-200/);
 assert.match(read('study-dashboard/dashboard-view.tsx'),/确认迁移进度/);
});
test('plain-language explanations are attached to actual settings and writeback decisions',()=>{
 const read=path=>readFileSync(new URL('../app/'+path,import.meta.url),'utf8');
 assert.match(read('companion-settings-card.tsx'),/本地资料助手（Companion）/);
 assert.match(read('companion-settings-card.tsx'),/<StudyTermHelp term="companion"\/>/);
 assert.match(read('study-dashboard/sources-view.tsx'),/<StudyTermHelp term="review"\/>/);
 assert.match(read('study-dashboard/today-view.tsx'),/<StudyTermHelp term="managed"\/>/);
 assert.match(read('study-dashboard/today-view.tsx'),/<details className="study-plan-identifier"><summary>计划标识/);
});
