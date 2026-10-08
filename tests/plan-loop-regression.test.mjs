import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDynamicUiModel, mergeModuleCatalog } from '../app/dynamic-ui-model.ts';
import { buildPlanInput } from '../app/plan-input-builder.ts';
import * as planner from '../app/daily-plan.ts';
import * as runtime from '../app/dynamic-ui-model.ts';

const day = '2026-08-31';
const vocab = { id: 'ielts-vocabulary', name: '词汇', pluginType: 'three-stage', domain: 'ielts', items: Array.from({length: 40}, (_, i) => ({word: `w${i}`, abilityId: `word:w${i}`})) };
const reading = {id:'reading-comprehension', name:'阅读理解专项', pluginType:'quiz', domain:'ielts', items:[{itemId:'question-1',abilityId:'ability-one',topic:'主旨',prompt:'What?',options:['A','B'],answer:'A'},{itemId:'question-2',abilityId:'ability-two',topic:'结构',prompt:'How?',options:['C','D'],answer:'C'}]};
const entry = (itemKey, extra={}) => ({kind:'study',itemKey,domain:'ielts',estimatedMinutes:2,reasons:['当前学习主线'],...extra});
const plan = (items) => ({day,planHash:'fixture',items,totalMinutes:items.reduce((n,i)=>n+i.estimatedMinutes,0),overloaded:false,skipped:[]});
const model = (p, subjects=[vocab,reading]) => buildDynamicUiModel({subjects,day,plan:p,catalog:[],demoMode:false});

test('a reloaded group plan keeps exactly its saved membership even when the library order changes', () => {
  const p = plan([entry('vocab-group:ielts-vocabulary:1',{practice:{kind:'vocab-group',subjectId:vocab.id,count:2,itemKeys:['word:w20','word:w21'],groupIndex:1}})]);
  const reloaded = JSON.parse(JSON.stringify(p));
  const result = model(reloaded,[{...vocab,items:[...vocab.items].reverse()},reading]);
  assert.deepEqual(result.playableSubjects.map(s=>s.id),['ielts-vocabulary']);
  assert.deepEqual(result.playableSubjects[0].items.map(i=>i.word).sort(),['w20','w21']);
});
test('a current empty plan does not fall back to the full catalog', () => assert.deepEqual(model(plan([])).playableSubjects,[]));
test('unmapped planned questions never expose unrelated module content', () => assert.deepEqual(model(plan([entry('practice:missing')])).playableSubjects,[]));
test('practice itemId maps to the source item even when abilityId differs', () => {
  const result=model(plan([entry('practice:question-1')]));
  assert.deepEqual(result.playableSubjects.map(s=>s.id),['reading-comprehension']);
  assert.deepEqual(result.playableSubjects[0].items.map(i=>i.itemId),['question-1']);
});
test('no plan and yesterday plans preserve normal module learning', () => {
  assert.equal(model(null).playableSubjects[0].items.length,40);
  assert.equal(model({...plan([]),day:'2026-08-30'}).playableSubjects[0].items.length,40);
});
test('generated plans persist practice references and item ids across serialization', async () => {
  const input=buildPlanInput({day,subjects:[vocab,reading],sourceSubjectIds:[vocab.id,reading.id],constraints:{dailyMinutes:{min:60,max:120,source:'user'},loadFactor:1,minReviewMinutes:0}});
  const result=JSON.parse(JSON.stringify(await planner.generateDailyPlan(input)));
  assert.equal(result.items.find(i=>i.itemKey==='vocab-group:ielts-vocabulary:1')?.practice?.itemKeys.length,20);
  assert.equal(result.items.find(i=>i.itemKey==='vocab-group:ielts-vocabulary:1')?.practice?.groupQuota,20);
  assert.deepEqual(result.items.find(i=>i.itemKey==='practice:question-1')?.practice?.itemIds,['question-1']);
});
test('catalog canonicalizes paper quiz history while preserving unrelated course quiz and every item key', () => {
  const catalog=[{id:'old',name:'核心概念理解',pluginType:'quiz',domain:'paper',itemKeys:['old-question'],lastSeenAt:'2099-01-01T00:00:00Z',todayCount:0}, {id:'course',name:'课程测验',pluginType:'quiz',domain:'course',itemKeys:['course-q'],lastSeenAt:'2099-01-01T00:00:00Z',todayCount:0}];
  const result=mergeModuleCatalog(catalog,[reading],`${day}T00:00:00Z`,false);
  assert.deepEqual(result.map(m=>m.name).sort(),['课程测验','阅读理解专项'].sort());
  assert.ok(result.find(m=>m.id===reading.id).itemKeys.includes('old-question'));
  assert.equal(result.find(m=>m.id===reading.id).todayCount,2);
});

test('effective plan restores current-day authority without reviving yesterday drafts', () => {
  const current=plan([entry('ability-one')]);
  assert.deepEqual(runtime.selectEffectivePlan?.(day,null,current),current);
  assert.deepEqual(runtime.selectEffectivePlan?.(day,{...current,day:'2026-08-30'},current),current);
  assert.equal(runtime.selectEffectivePlan?.(day,null,{...current,day:'2026-08-30'}),null);
});
test('single-question routing uses explicit itemId, never all questions or shared-ability siblings', () => {
  const target=entry('ability-one',{practice:{kind:'question',subjectId:reading.id,count:1,itemKeys:['ability-one'],itemIds:['question-1']}});
  const remote=[{itemId:'question-1',abilityId:'shared',prompt:'first'},{itemId:'question-2',abilityId:'shared',prompt:'second'}];
  assert.deepEqual(runtime.selectPlannedPractice?.(target,[reading],remote).map(i=>i.itemId),['question-1']);
  assert.throws(()=>runtime.selectPlannedPractice(entry('missing'),[reading],remote),/匹配|找到/);
});
test('source questions remain playable when not in the due-only practice endpoint', () => {
  const items=runtime.selectPlannedPractice?.(entry('ability-one'),[reading],[]);
  assert.equal(items?.length,1);
  assert.equal(items?.[0].itemId,'question-1');
  assert.equal(items?.[0].answer,0);
});
test('question completion follows today practice event identity, not stale stage values', () => {
  const target=entry('ability-one',{practice:{kind:'question',subjectId:reading.id,count:1,itemKeys:['ability-one'],itemIds:['question-1']}});
  const event={eventType:'practice-attempt',item:{key:'practice:question-1'},occurredAt:'2026-08-30T17:00:00Z',attempt:{correct:true,rating:'good',stageAfter:3}};
  assert.equal(runtime.isPlanEntryDone?.(target,[reading],{itemStages:{}},[event],day),true);
  assert.equal(runtime.isPlanEntryDone?.(target,[reading],{itemStages:{'ability-one':3}},[{...event,occurredAt:'2026-08-29T17:00:00Z'}],day),false);
});
test('carried groups use actual stages and only the previous Shanghai day', () => {
  assert.equal(runtime.isCarriedGroup?.(day,{dayKey:'2026-08-30',group:0},0,[vocab.items[0]],{itemStages:{'word:w0':3}}),false);
  assert.equal(runtime.isCarriedGroup?.(day,{dayKey:'2026-08-30',group:0},0,[vocab.items[0]],{itemStages:{}}),true);
  assert.equal(runtime.isCarriedGroup?.(day,{dayKey:'2026-08-29',group:0},0,[vocab.items[0]],{itemStages:{}}),false);
});
test('candidate deletion recalculates duration, overload and content hash without losing input provenance', async () => {
  const original={...plan([entry('a'),entry('b')]),capacityMinutes:3,overloaded:true};
  const result=await planner.revisePlanCandidate?.(original,[original.items[0]]);
  assert.equal(result?.totalMinutes,2);
  assert.equal(result?.overloaded,false);
  assert.equal(result?.inputHash,'fixture');
  assert.notEqual(result?.planHash,original.planHash);
  assert.equal(original.items.length,2);
});
test('AI failure returns deterministic candidate with visible configuration error', async () => {
  const original=plan([entry('a'),entry('b')]);
  const result=await planner.applyPlanGenerationMode?.(original,'ai',async()=>{throw new Error('尚未配置 DeepSeek API 密钥。');});
  assert.deepEqual(result?.candidate.items.map(i=>i.itemKey),['a','b']);
  assert.match(result?.message??'',/DeepSeek/);
  assert.match(result?.message??'',/回退/);
});
test('AI cannot duplicate, drop, add or mutate selected items', async () => {
  const original=plan([entry('a'),entry('b')]);
  const duplicate=await planner.applyPlanGenerationMode?.(original,'ai',async()=>[entry('a'),entry('a')]);
  assert.deepEqual(duplicate?.candidate.items.map(i=>i.itemKey),['a','b']);
  const reordered=await planner.applyPlanGenerationMode?.(original,'ai',async()=>[entry('b',{estimatedMinutes:999}),entry('a')]);
  assert.deepEqual(reordered?.candidate.items.map(i=>i.itemKey),['b','a']);
  assert.equal(reordered?.candidate.items[0].estimatedMinutes,2);
  assert.equal(reordered?.candidate.totalMinutes,4);
});
test('active invented question subjects normalize before catalog counts and plan filtering', () => {
  const result=model(plan([entry('ability-one')]),[{...reading,id:'invented',name:'核心概念理解',domain:'paper'}]);
  assert.deepEqual(result.playableSubjects.map(s=>s.id),['reading-comprehension']);
  assert.equal(result.historicalModules.find(m=>m.id==='reading-comprehension').todayCount,1);
});
test('the plan content hash binds group membership, not just the group index', async () => {
  const input={day,subjects:[vocab],sourceSubjectIds:[vocab.id],constraints:{dailyMinutes:{min:60,max:120,source:'user'},loadFactor:1,minReviewMinutes:0}};
  const a=await planner.generateDailyPlan(buildPlanInput(input));
  const b=await planner.generateDailyPlan(buildPlanInput({...input,subjects:[{...vocab,items:[...vocab.items].reverse()}]}));
  assert.notEqual(a.planHash,b.planHash);
});
test('a missing explicit question id never falls back to another question sharing its ability', () => {
  const target=entry('shared',{practice:{kind:'question',subjectId:reading.id,count:1,itemKeys:['shared'],itemIds:['missing-question']}});
  assert.throws(()=>runtime.selectPlannedPractice(target,[],[{itemId:'sibling',abilityId:'shared'}]),/匹配|找到/);
});
test('ambiguous unprefixed ability keys do not expand into multiple planned questions', () => {
  const shared={...reading,items:reading.items.map(item=>({...item,abilityId:'shared'}))};
  assert.deepEqual(model(plan([entry('shared')]),[shared]).playableSubjects,[]);
});
test('generic quiz modules without a declared family are not relabeled as IELTS', () => {
  const subject={id:'python',name:'Python 基础知识',pluginType:'quiz',items:[{topic:'变量',prompt:'What is a variable?'}]};
  const result=model(null,[subject]);
  assert.deepEqual(result.playableSubjects.map(s=>s.name),['Python 基础知识']);
  assert.deepEqual(result.historicalModules.map(s=>s.name),['Python 基础知识']);
});

test('repeated normalization retains legacy subject ids for restored plan references', () => {
  const legacy={...reading,id:'legacy-reading',name:'核心概念理解',domain:'paper'};
  const once=runtime.normalizeDynamicSubjects([legacy]);
  const twice=runtime.normalizeDynamicSubjects(once);
  assert.deepEqual(twice,once);
  const target=entry('ability-one',{practice:{kind:'question',subjectId:legacy.id,count:1,itemKeys:['ability-one'],itemIds:['question-1']}});
  assert.equal(model(plan([target]),twice).playableSubjects[0]?.items.length,1);
});

test('planned recall preserves versioned support and content identity',()=>{
 const learningSupport={schemaVersion:1,type:'recall',criteria:[{id:'cause',text:'Cause'}]};
 const item={itemId:'recall-one',abilityId:'cause',prompt:'Why?',answer:'Because',learningSupport,contentHash:'a'.repeat(64)};
 const actual=runtime.selectPlannedPractice(entry('recall-one'),[{id:'causes',name:'Causes',pluginType:'recall',items:[item]}],[])[0];
 assert.deepEqual(actual.learningSupport,learningSupport);assert.equal(actual.contentHash,item.contentHash);
});
