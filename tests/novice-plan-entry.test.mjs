import assert from 'node:assert/strict';import test from 'node:test';
import {confirmStudyNavigation} from '../app/study-navigation-guard.ts';
import {dashboardFunction} from './fixtures/dashboard-functions.mjs';
import {isDemoPlanEntryDone,isPlanEntryDone,selectPlannedPractice} from '../app/plan-runtime.ts';
const question={itemId:'q1',abilityId:'ability-q1',questionType:'code',prompt:'A test question',domain:'python',sourceLabel:'Example',fingerprint:'q1',initialCode:'pass',testCode:'assert True'};
const entry={itemKey:'practice:q1',kind:'review',domain:'python',estimatedMinutes:5,reasons:[]};
function fixture(){const state={};const env={confirmStudyNavigation,companionPlanClient:null,effectivePlan:{items:[entry]},normalizedSubjects:[],data:{practiceItems:[question]},practiceRequest:{current:0},selectPlannedPractice,setPracticeLoading:x=>state.loading=x,setPracticeSummary:x=>state.summary=x,setPracticeSessionKey(){},setPracticeItems:x=>state.items=x,setPlanMessage:x=>state.message=x};return {state,env,start:dashboardFunction('startPlannedQuestionPractice',env)};}
test('planned question opens from current local content without a paired Companion',async()=>{const f=fixture();await f.start(entry.itemKey);assert.deepEqual(f.state.items,[question]);assert.equal(f.state.loading,false);});
test('a missing planned question reports an error instead of opening unrelated content',async()=>{const f=fixture();f.env.data.practiceItems=[];await f.start(entry.itemKey);assert.equal(f.state.items,undefined);assert.match(f.state.message,/找不到|匹配/);});
test('demonstration attempts never enter personal event delivery',async()=>{let progress={itemStages:{},answered:0,correct:0};const grade=dashboardFunction('recordPracticeAttempt',{isDemoMode:true,setDemoProgress:fn=>progress=fn(progress)});await grade({item:question,rating:'good',correct:true});assert.equal(progress.answered,1);assert.equal(progress.itemStages['practice:q1'],3);});
test('demo completion follows a real correct demo attempt but cannot certify personal completion',()=>{
 const progress={itemStages:{'practice:q1':3}};
 assert.equal(isDemoPlanEntryDone(entry,[],progress,[question]),true);
 assert.equal(isDemoPlanEntryDone(entry,[],{itemStages:{}},[question]),false);
 assert.equal(isPlanEntryDone(entry,[],progress,[],'2026-09-09'),false);
});
