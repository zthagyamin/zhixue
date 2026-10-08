import assert from 'node:assert/strict';
import test from 'node:test';
import {normalizeDynamicSubjects, mergeModuleCatalog, resolveStudyItemProgressKey} from '../app/dynamic-ui-model.ts';
import {buildPlanInput} from '../app/plan-input-builder.ts';
import {isPlanEntryDone,isCarriedGroup as runtimeCarry} from '../app/plan-runtime.ts';
import * as pacing from '../app/vocab-pacing.ts';

const wordSubject = (id) => ({id,name:'术语',sourceMode:'gateway',identity:'scoped',pluginType:'three-stage',domain:id,groupQuota:2,items:['cell','atom','ion'].map(word=>({word,meaning:'词义',example:'Example.',abilityId:`word:${id}:${word}`,itemId:`word:${id}:${word}`}))});
const day = '2026-08-31';
test('gateway subject identity overrides legacy naming and domain folding',()=>{
  const subjects = normalizeDynamicSubjects(['biology','chemistry'].map(id=>({...wordSubject(id),domain:'paper',name:'同名学科',pluginType:'quiz'})));
  assert.deepEqual(subjects.map(s=>s.id),['biology','chemistry']);
  const catalog=mergeModuleCatalog([],subjects,day,false);
  assert.deepEqual(catalog.map(s=>s.id).sort(),['biology','chemistry']);
  assert.ok(catalog.every(s=>s.sourceMode==='gateway'));
});
test('new vocabulary subjects group by plugin and keep independent namespaces and domains',()=>{
  const subjects=normalizeDynamicSubjects([wordSubject('biology'),wordSubject('chemistry')]);
  const input=buildPlanInput({day,subjects,itemStages:{'word:cell':3,'word:atom':3,'word:ion':3}});
  assert.equal(input.pool.length,4);
  assert.ok(input.pool.every(entry=>entry.practice.kind==='vocab-group'));
  assert.deepEqual(input.pool.find(entry=>entry.itemKey==='vocab-group:biology:0').practice.itemKeys,['word:biology:cell','word:biology:atom']);
  assert.equal(input.pool.find(entry=>entry.itemKey==='vocab-group:biology:0').domain,'biology');
});
test('scoped vocabulary cannot inherit legacy progress or completion',()=>{
  const [subject]=normalizeDynamicSubjects([wordSubject('biology')]);
  const progress={itemStages:{'word:cell':3,'word:atom':3,'word:ion':3},fsrsData:{}};
  assert.equal(resolveStudyItemProgressKey(subject.items[0],0,progress),'word:biology:cell');
  const entry={itemKey:'vocab-group:biology:0',kind:'study',domain:'biology',estimatedMinutes:2,reasons:[],practice:{kind:'vocab-group',subjectId:'biology',count:2,itemKeys:['word:biology:cell','word:biology:atom'],groupIndex:0}};
  assert.equal(isPlanEntryDone(entry,[subject],progress,[],day),false);
});
test('legacy migration identity explicitly retains old word progress',()=>{
  const [subject]=normalizeDynamicSubjects([{...wordSubject('biology'),identity:'legacy'}]);
  assert.equal(resolveStudyItemProgressKey(subject.items[0],0,{itemStages:{'word:cell':3},fsrsData:{}}),'word:cell');
});
test('future or disabled result cards do not become optional new-study pool',()=>{
  const subjects=normalizeDynamicSubjects([{id:'astronomy',name:'天文',sourceMode:'gateway',pluginType:'recall',items:[{itemId:'future-card',prompt:'Future question',reviewOnly:true}]}]);
  assert.equal(buildPlanInput({day,subjects}).pool.length,0);
});
test('orphaned old FSRS entries cannot leak into indexed plans',()=>{
  const subjects=normalizeDynamicSubjects([wordSubject('biology')]);
  const input=buildPlanInput({day,subjects,fsrsData:{'word:removed':{due:day,stability:1,difficulty:5}}});
  assert.equal(input.dueReviews.length,0);
});
test('pacing migration assigns legacy state only to legacy vocabulary subject',()=>{
  const legacy={settings:{quota:40,override:1},serve:{dayKey:day,group:1}};
  assert.equal(typeof pacing.migrateSubjectPacing,'function');
  const result=pacing.migrateSubjectPacing(null,legacy);
  assert.deepEqual(result.subjects['ielts-vocabulary'],legacy);
  assert.equal(pacing.pacingForSubject(result,'biology',10).settings.quota,10);
  assert.equal(pacing.pacingForSubject(result,'chemistry').serve.group,0);
  assert.deepEqual(pacing.migrateSubjectPacing(result,{...legacy,settings:{quota:1,override:null}}),result);
});
test('free-study served group snapshot survives changed quota and ordering',()=>{
  assert.equal(typeof pacing.snapshotServedGroup,'function');
  const state=pacing.snapshotServedGroup({settings:{quota:2,override:1},serve:{dayKey:'2026-08-30',group:1}},['word:a','word:b','word:c','word:d']);
  assert.deepEqual(state.serve.itemKeys,['word:c','word:d']);
  assert.equal(runtimeCarry(day,state.serve,0,[{word:'c',abilityId:'word:c'},{word:'d',abilityId:'word:d'}],{itemStages:{}}),true);
});
test('due events use the declared subject domain rather than an IELTS prefix fallback',()=>{
  const subjects=normalizeDynamicSubjects([wordSubject('biology')]);
  const result=buildPlanInput({day,subjects,fsrsData:{'word:biology:cell':{due:day,stability:1,difficulty:5}}});
  assert.equal(result.dueReviews[0].domain,'biology');
});
test('custom subject quotas remain selectable rather than appearing as ten words',()=>{
  assert.equal(typeof pacing.vocabQuotaOptions,'function');
  assert.ok(pacing.vocabQuotaOptions(1).includes(1));
  assert.ok(pacing.vocabQuotaOptions(7).includes(7));
  assert.equal(new Set(pacing.vocabQuotaOptions(20)).size,pacing.vocabQuotaOptions(20).length);
});
