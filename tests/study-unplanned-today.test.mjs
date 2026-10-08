import assert from 'node:assert/strict';
import test from 'node:test';
import {tsxFunction} from './fixtures/tsx-functions.mjs';
let model={};try{model=await import('../app/study-unplanned-model.ts');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}

test('unplanned states distinguish loading, failed reads, empty days and real drafts',()=>{
 assert.equal(typeof model.unplannedTodayModel,'function');
 const empty={currentPlan:null,approvedPlan:null};
 assert.equal(model.unplannedTodayModel(null,null).phase,'checking');
 assert.equal(model.unplannedTodayModel(empty,'failed').phase,'failed');
 assert.equal(model.unplannedTodayModel(empty,null).phase,'empty');
 assert.equal(model.unplannedTodayModel(empty,null).newWords,null);
 const draft={...empty,currentPlan:{tasks:[{taskId:'a',category:'new-word',quantity:15,title:'任意词组'},{taskId:'b',category:'review',quantity:1,title:'复习'}]}};
 const view=model.unplannedTodayModel(draft,null);assert.equal(view.phase,'draft');assert.equal(view.newWords,15);assert.equal(view.reviews,1);assert.equal(view.action,'review');
 assert.equal(model.unplannedTodayModel({...empty,approvedPlan:{tasks:[]}},null).phase,'approved-empty');
});
test('generation returns to the draft summary without approving; failures keep the current editor',async()=>{
 const trace=[];let success=true;const action=tsxFunction(new URL('../app/account-study-controls.tsx',import.meta.url),'prepareTodayDraft',{setEditorOpen:v=>trace.push(['editor',v]),generate:async()=>{trace.push(['generate']);return success;},approve:()=>assert.fail('must not approve')});
 assert.equal(typeof action,'function');await action();assert.deepEqual(trace,[['generate'],['editor',false]]);
 trace.length=0;success=false;await action();assert.deepEqual(trace,[['generate']]);
});

test('empty and draft rendering keeps the overview without fabricated completed progress or execution buttons',async()=>{
 const {loadTsx}=await import('./fixtures/tsx-components.mjs'),{createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
 const {StudyUnplannedToday}=loadTsx(new URL('../app/study-unplanned-today.tsx',import.meta.url));
 const props={state:{currentPlan:null,approvedPlan:null},day:'2026-09-08',busy:false,onGenerate(){},onReview(){},onRetry(){}};
 const html=renderToStaticMarkup(createElement(StudyUnplannedToday,props));assert.match(html,/今日概览/);assert.match(html,/生成今日草稿/);assert.match(html,/待核对/);assert.doesNotMatch(html,/<progress|已完成 0/);
 const draft=renderToStaticMarkup(createElement(StudyUnplannedToday,{...props,state:{currentPlan:{tasks:[{taskId:'x',category:'new-word',title:'自定义词组',quantity:15}]},approvedPlan:null}}));
 assert.match(draft,/自定义词组/);assert.match(draft,/待确认/);assert.match(draft,/查看草稿/);assert.doesNotMatch(draft,/<button[^>]*>开始学习/);
 const confirm=renderToStaticMarkup(createElement(StudyUnplannedToday,{...props,onConfirm(){},state:{currentPlan:{tasks:[{taskId:'x',category:'review',title:'待复习题',quantity:1}]},approvedPlan:null}}));
 assert.match(confirm,/确认并开始今日自测/);assert.match(confirm,/查看或调整草稿/);assert.match(confirm,/草稿尚未生效/);
});
