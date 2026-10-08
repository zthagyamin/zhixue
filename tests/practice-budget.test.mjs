import test from 'node:test';
import assert from 'node:assert/strict';
import * as planning from '../src/domain/planning/index.ts';
const groups=[{id:'papers',title:'论文',subjectIds:['a','b'],minutes:10,defaultItemMinutes:3}];
const task=(taskId,subjectId='a',category='review',estimatedMinutes=4)=>({taskId,subjectId,category,title:taskId,estimatedMinutes,quantity:1,action:{kind:'practice',itemKeys:[taskId]}});
const select=(tasks,{budget=groups,target,completed=[],started=[],selected=[]}={})=>planning.practiceBudgetView(tasks,target,0,completed,started,selected,budget);
test('shared budget prioritizes due work, stable order and leaves words/materials/other subjects intact',()=>{
 const tasks=[task('new','a','subject'),task('a'),task('b','b'),task('other','c'),task('words','a','new-word'),{...task('read','a','subject'),action:{kind:'open-note'}},task('overflow','b')],before=structuredClone(tasks);
 assert.deepEqual(select(tasks).visible.map(t=>t.taskId),['a','b','other','words','read']);assert.deepEqual(tasks,before);
 assert.deepEqual(select(tasks).budgetDeferred.map(t=>t.taskId),['new','overflow']);
});
test('budget-deferred review cannot occupy the quantity target ahead of other subjects',()=>{
 const result=select([task('large','a','review',11),task('other','c'),task('new','b','subject',2)],{target:1});
 assert.deepEqual(result.visible.map(t=>t.taskId),['other','new']);
});
test('completed, started and explicitly retained count against capacity on every refresh',()=>{
 const tasks=[task('completed'),task('started','b'),task('locked','a','subject'),task('next','b')];
 const options={target:1,completed:['completed'],started:['started'],selected:['locked']};
 for(let i=0;i<3;i++){const result=select(tasks,options);assert.deepEqual(result.visible.map(t=>t.taskId),['completed','started','locked']);assert.equal(result.budgets[0].overMinutes,2);assert.equal(result.reviewOverTarget,1);}
});
test('zero, invalid estimates and oversized work never become free tasks; smaller later task uses remainder',()=>{
 const tasks=[task('invalid','a','review',NaN),task('big','b','review',20),task('missing','b','subject',undefined)];delete tasks[2].estimatedMinutes;
 assert.deepEqual(select(tasks,{budget:[{...groups[0],minutes:5}]}).visible.map(t=>t.taskId),['invalid']);
 assert.deepEqual(select(tasks,{budget:[{...groups[0],minutes:0}]}).visible,[]);
 assert.deepEqual(select([task('big','a','review',11),task('fits','b','review',2)]).visible.map(t=>t.taskId),['fits']);
});
test('missing and empty budgets preserve legacy review selection exactly',()=>{
 const tasks=[task('a'),task('b'),task('new','a','subject')];
 for(const budget of [undefined,[]]){const result=planning.practiceBudgetView(tasks,1,0,[],[],[],budget);const legacy=planning.reviewGoalView(tasks,1,0,[]);for(const key of Object.keys(legacy))assert.deepEqual(result[key],legacy[key]);}
});
test('selection scope isolates budgets, account, library, day and source',()=>{
 const plan={day:'2026-09-29',sourceHash:'s',longTermAllocation:{practiceBudgetGroups:groups}};
 const base=planning.practiceSelectionScope('owner','library',plan);
 for(const [owner,library,next] of [['other','library',plan],['owner','other',plan],['owner','library',{...plan,day:'2026-09-30'}],['owner','library',{...plan,sourceHash:'new'}],['owner','library',{...plan,longTermAllocation:{practiceBudgetGroups:[{...groups[0],minutes:0}]}}]])assert.notEqual(planning.practiceSelectionScope(owner,library,next),base);
});
