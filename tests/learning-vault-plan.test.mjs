import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPlanInput } from '../app/plan-input-builder.ts';
import { generateDailyPlan } from '../app/daily-plan.ts';
import { buildDynamicUiModel, stableStudyItemKey } from '../app/dynamic-ui-model.ts';
import * as runtime from '../app/plan-runtime.ts';
import * as pacing from '../app/vocab-pacing.ts';

const day = '2026-08-31';
const constraints = { dailyMinutes: { min: 30, max: 30, source: 'user' }, minReviewMinutes: 0, loadFactor: 1 };
const vocab = { id: 'ielts-vocabulary', name: '词汇', pluginType: 'three-stage', domain: 'ielts', groupQuota: 20,
  items: Array.from({length:60}, (_,i)=>({word:`w${i}`,abilityId:`word:w${i}`})) };
const question = {itemId:'q1', abilityId:'ability-q', domain:'paper', sourceNote:'paper.md', stateRef:'paper.md',
  questionType:'recall',prompt:'Explain the result',answer:'The main result',fingerprint:'q1',sourceLabel:'Paper'};
const entry = (key,extra={})=>({kind:'study',itemKey:key,domain:'paper',estimatedMinutes:2,reasons:[],...extra});
const plan = items=>({day,planHash:'test',items,totalMinutes:2,overloaded:false,skipped:[]});
const event = (key,correct,stageAfter=correct?3:0)=>({eventType:'practice-attempt',item:{key},occurredAt:day+'T01:00:00Z',attempt:{correct,rating:correct?'good':'again',stageAfter}});

test('fresh learning-vault due items and Python enter the plan without previous browser FSRS',async()=>{
  const python={id:'python-practice',name:'Python',pluginType:'code',domain:'python',items:[{itemId:'py:q1',abilityId:'py-a',topic:'add',prompt:'Implement add'}]};
  const input=buildPlanInput({day,subjects:[python],duePractice:[question],constraints});
  const result=await generateDailyPlan(input);
  assert.deepEqual(result.items.map(i=>i.itemKey).sort(),['practice:py:q1','practice:q1']);
  assert.equal(result.items.find(i=>i.itemKey==='practice:q1').kind,'review');
});
test('fresh practice references remain visible as playable subjects',()=>{
  const subjects=runtime.studySubjectsWithPractice?.([], [question]);
  assert.equal(subjects?.[0]?.items[0]?.itemId,'q1');
  const result=buildDynamicUiModel({subjects,day,plan:plan([entry('practice:q1')]),catalog:[],demoMode:false});
  assert.equal(result.playableSubjects[0]?.items.length,1);
});
test('completed first group no longer consumes capacity on the next day',async()=>{
  const stages=Object.fromEntries(vocab.items.slice(0,20).map(i=>[i.abilityId,3]));
  const p=await generateDailyPlan(buildPlanInput({day,subjects:[vocab],itemStages:stages,constraints}));
  assert.equal(p.items[0]?.itemKey,'vocab-group:ielts-vocabulary:1');
});
test('unfinished yesterday served group precedes other new groups',async()=>{
  const p=await generateDailyPlan(buildPlanInput({day,subjects:[vocab],itemStages:{},previousServe:{dayKey:'2026-08-30',group:2},constraints}));
  assert.equal(p.items[0]?.itemKey,'vocab-group:ielts-vocabulary:2');
  assert.equal(p.items[0]?.practice?.carriedFromPreviousDay,true);
});
test('overdue vocabulary needs a fresh completed review, not a historical stage',()=>{
  const item=entry('word:w0',{kind:'overdue',domain:'ielts'});
  const progress={itemStages:{'word:w0':3}};
  assert.equal(runtime.isPlanEntryDone(item,[vocab],progress,[],day),false);
  assert.equal(runtime.planItemStages?.(item,[vocab],progress,[],day)['word:w0'],0);
  assert.equal(runtime.isPlanEntryDone(item,[vocab],progress,[event('word:w0',true)],day),true);
});
test('wrong attempts never complete a planned question',()=>{
  const item=entry('practice:q1');
  assert.equal(runtime.isPlanEntryDone(item,[],{itemStages:{}},[event('practice:q1',false)],day),false);
  assert.equal(runtime.isPlanEntryDone(item,[],{itemStages:{}},[event('practice:q1',true)],day),true);
});
test('different questions sharing an ability retain separate identities and plan entries',async()=>{
  const subject={id:'reading-comprehension',name:'Reading',pluginType:'quiz',domain:'ielts',items:[
    {itemId:'q1',abilityId:'shared',topic:'First'}, {itemId:'q2',abilityId:'shared',topic:'Second'}]};
  assert.notEqual(stableStudyItemKey(subject.items[0]),stableStudyItemKey(subject.items[1]));
  const p=await generateDailyPlan(buildPlanInput({day,subjects:[subject],constraints}));
  assert.deepEqual(p.items.map(i=>i.practice.itemIds[0]).sort(),['q1','q2']);
});
test('missing explicit item ids do not resolve through a sibling without an item id',()=>{
  const item=entry('shared',{practice:{kind:'question',subjectId:'reading-comprehension',count:1,itemKeys:['shared'],itemIds:['gone']}});
  const subjects=[{id:'reading-comprehension',name:'Reading',pluginType:'quiz',items:[{abilityId:'shared',topic:'Sibling',prompt:'Wrong target'}]}];
  assert.throws(()=>runtime.selectPlannedPractice(item,subjects,[]),/匹配|找到/);
});
test('another practice round is restricted to the effective plan',()=>{
  const other={...question,itemId:'q2',abilityId:'other'};
  const result=runtime.practiceForPlan?.(plan([entry('practice:q1')]),[],[question,other]);
  assert.deepEqual(result?.map(i=>i.itemId),['q1']);
});

test('choosing a planned group persists its real membership and clears stale overrides',()=>{
  const current={settings:{quota:20,override:0},serve:{dayKey:day,group:0},previousServe:{dayKey:'2026-08-30',group:0}};
  const selected=pacing.selectPlanGroup?.(current,day,{groupIndex:1,itemKeys:['word:w20','word:w21']});
  assert.deepEqual(selected?.serve,{dayKey:day,group:1,itemKeys:['word:w20','word:w21']});
  assert.equal(selected?.settings.override,null);
  assert.deepEqual(selected?.previousServe,current.previousServe);
});
test('carry-over follows yesterday actual members when the quota changes',()=>{
  const served={dayKey:'2026-08-30',group:1,itemKeys:['word:w10','word:w11']};
  assert.equal(runtime.isCarriedGroup(day,served,0,vocab.items.slice(0,20),{itemStages:{}}),true);
  assert.equal(runtime.isCarriedGroup(day,served,1,vocab.items.slice(20,40),{itemStages:{}}),false);
});
