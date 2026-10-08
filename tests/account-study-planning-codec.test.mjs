import assert from 'node:assert/strict';
import test from 'node:test';
import {generateTaskPlan} from '../app/task-plan-engine.ts';
import {editTaskPlan} from '../app/task-plan-edit.ts';
import {vocabularyInput,courseSubject} from './fixtures/task-plan-input.mjs';
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';
import {wordBody,quizBody,snapshotBody} from './fixtures/account-study-fixtures.mjs';
let api;
try {api=await import('../app/account-study-planning.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;}
function ready(){assert.equal(typeof api?.toCloudPlanningCatalog,'function','Portable planning codec must exist');}
const context=baseRevision=>({baseRevision,factsHash:'d'.repeat(64),eventThrough:0,taskThrough:0,nativeBaseRevision:2});
async function setup(){
  ready();const input=vocabularyInput(20),course=courseSubject(2,{targetCount:1});input.catalog.subjects.push(course);
  input.reviews=[{roundId:'review-one',itemKey:'practice:question-one',subjectId:'reading',dueAt:'2026-08-31T00:00:00.000Z',completed:false,completionRule:'graded-practice'}];
  input.catalog.practiceSources=[{itemKey:'practice:question-one',subjectId:'reading',title:'Reading check',sourceHash:'c'.repeat(64),completionRule:'graded-practice'}];
  const items=await Promise.all([
    ...Array.from({length:20},(_,i)=>sealStudyItem(wordBody({itemKey:`word:${i}`,subjectId:'vocab',title:`term${i}`,
      word:{...wordBody().word,word:`term${i}`,example:`term${i} appears here.`}}))),
    sealStudyItem(quizBody({itemKey:'practice:question-one'})),
  ]);
  const snapshot=await sealStudySnapshot(snapshotBody(items));const bundle={snapshot,items};
  const converted=await api.toCloudPlanningCatalog(input.catalog,bundle);
  return {input,course,bundle,...converted};
}
test('cloud catalog has opaque materials and content-versioned practice without Vault paths',async()=>{
  const {catalog,materials}=await setup();const json=JSON.stringify(catalog);
  assert.ok(!json.includes('subjects/course/u0'));assert.ok(!json.includes('\u0022contentRef\u0022:'));assert.ok(!json.includes('\u0022stateRef\u0022:'));
  assert.equal(Object.keys(materials).length,2);assert.ok(Object.keys(materials).every(key=>key.startsWith('material:')));
  assert.equal(catalog.subjects[0].words[0].sourceHash,catalog.contentRefs['word:0']);
  assert.deepEqual(await api.parseCloudPlanningCatalog(catalog),catalog);
});
test('missing content membership or added local path fails before a cloud fact can be signed',async()=>{
  const input=vocabularyInput(1),item=await sealStudyItem(wordBody({itemKey:'another-word'}));
  const snapshot=await sealStudySnapshot(snapshotBody([item]));
  await assert.rejects(api.toCloudPlanningCatalog(input.catalog,{snapshot,items:[item]}),/content|membership/);
  const {catalog}=await setup();catalog.subjects[1].units[0].stateRef='private.md';
  await assert.rejects(api.parseCloudPlanningCatalog(catalog),/field/);
});
test('existing deterministic engine still produces 20 new words, mandatory review and explicit goal',async()=>{
  const {catalog}=await setup(),engineCatalog=await api.toEnginePlanningCatalog(catalog);
  const words=engineCatalog.subjects.flatMap(subject=>subject.words).map(word=>({lexemeKey:`${word.language}:${word.word.toLowerCase()}`,itemKeys:[word.itemKey],status:'unseen'}));
  const plan=await generateTaskPlan({day:'2026-08-31',catalog:engineCatalog,words,reviews:[{roundId:'review-one',itemKey:'practice:question-one',subjectId:'reading',dueAt:'2026-08-31T00:00:00.000Z',completed:false,completionRule:'graded-practice'}],completions:[],previous:null});
  assert.equal(plan.vocabulary.assignedLexemeKeys.length,20);assert.equal(plan.tasks.filter(t=>t.category==='review').length,1);
  assert.ok(plan.tasks.some(task=>task.goalId==='course:daily'&&task.required));
  const cloud=await api.sealCloudTaskPlan(plan,catalog,context(0));assert.deepEqual(await api.parseCloudTaskPlan(cloud,catalog),cloud);
  assert.ok(!JSON.stringify(cloud).includes('contentRef'));
});
test('manual edit and order remain engine-validated before resealing shared draft',async()=>{
  const {catalog}=await setup(),engineCatalog=await api.toEnginePlanningCatalog(catalog);
  const empty=await generateTaskPlan({day:'2026-08-31',catalog:engineCatalog,words:engineCatalog.subjects[0].words.map(w=>({lexemeKey:`en:${w.word}`,itemKeys:[w.itemKey],status:'learned'})),reviews:[],completions:[],previous:null});
  const unit=engineCatalog.subjects[1].units[1],task={taskId:'manual-u1',subjectId:'course',title:'Custom',category:'subject',origin:'manual',required:false,unitIds:[unit.unitId],quantity:1,action:unit.action,completionRule:unit.completionRule,sourceHash:unit.sourceHash};
  const edited=await editTaskPlan(empty,{type:'upsert',task},engineCatalog);
  const cloud=await api.sealCloudTaskPlan(edited,catalog,context(3));assert.equal(cloud.baseRevision,3);assert.equal(cloud.tasks[0].action.kind,'open-material');
});
test('materializing an approved plan restores native refs and records both hashes',async()=>{
  const {catalog,materials,input}=await setup(),engineCatalog=await api.toEnginePlanningCatalog(catalog);
  const plan=await generateTaskPlan({day:'2026-08-31',catalog:engineCatalog,words:engineCatalog.subjects[0].words.map(w=>({lexemeKey:`en:${w.word}`,itemKeys:[w.itemKey],status:'learned'})),reviews:[],completions:[],previous:null});
  const cloud=await api.sealCloudTaskPlan(plan,catalog,context(0));
  const native=await api.materializeCloudTaskPlan(cloud,input.catalog,materials);
  assert.equal(native.cloudPlanHash,cloud.cloudPlanHash);assert.notEqual(native.nativePlan.planHash,cloud.enginePlanHash);
  assert.ok(native.nativePlan.tasks.some(task=>task.action.kind==='open-note'&&task.action.contentRef.includes('subjects/course')));
  const changed={...materials,[Object.keys(materials)[0]]:{...materials[Object.keys(materials)[0]],unitId:'wrong-unit'}};
  await assert.rejects(api.materializeCloudTaskPlan(cloud,input.catalog,changed),/material/);
});
test('unknown cloud fields and changed nested task fail integrity',async()=>{
  const {catalog}=await setup(),engineCatalog=await api.toEnginePlanningCatalog(catalog);
  const plan=await generateTaskPlan({day:'2026-08-31',catalog:engineCatalog,words:engineCatalog.subjects[0].words.map(w=>({lexemeKey:`en:${w.word}`,itemKeys:[w.itemKey],status:'learned'})),reviews:[],completions:[],previous:null});
  const cloud=await api.sealCloudTaskPlan(plan,catalog,context(0));
  await assert.rejects(api.parseCloudTaskPlan({...cloud,vaultPath:'private'},catalog),/field/);
  const changed=structuredClone(cloud);changed.tasks[0].title='changed';await assert.rejects(api.parseCloudTaskPlan(changed,catalog),/integrity/);
});
test('planning facts are separate, path-free and bind legacy coverage explicitly',async()=>{
  const {catalog}=await setup(),facts=await api.sealCloudPlanningFacts({schemaVersion:1,libraryId:catalog.libraryId,snapshotId:catalog.snapshotId,
    catalogHash:catalog.catalogHash,observedAt:'2026-09-01T00:00:00.000Z',nativePlanRevision:2,sourceReviews:[],captureReviews:[],legacyEvents:[],legacyTaskEvents:[],contentCandidates:[],historyComplete:true});
  assert.deepEqual(await api.parseCloudPlanningFacts(facts),facts);assert.match(facts.factsHash,/^[a-f0-9]{64}$/);
  await assert.rejects(api.parseCloudPlanningFacts({...facts,stateRef:'private.md'}),/field/);
});
import {spawnSync} from 'node:child_process';
import {buildLongTermPlanningInput} from '../app/long-term-planning-input.ts';
test('allocated words, material and independent physical practice survive TS/Python cloud seal and materialize',async()=>{
 const {input,bundle}=await setup();input.catalog.subjects.push({subjectId:'reading',name:'Reading',priority:2,planningStatus:'none',words:[],units:[],goals:[]});
 const {catalog,materials}=await api.toCloudPlanningCatalog(input.catalog,bundle),engine=await api.toEnginePlanningCatalog(catalog);
 const facts={...input,catalog:engine,words:engine.subjects.flatMap(s=>s.words).map(w=>({lexemeKey:`${w.language}:${w.word.toLowerCase()}`,itemKeys:[w.itemKey],status:'unseen'}))};
 const source=buildLongTermPlanningInput(facts),chosen=source.bindings.filter(b=>b.kind==='vocabulary').slice(0,5).concat(source.bindings.filter(b=>b.itemId==='course:u1'||b.itemId==='practice:question-one'));
 facts.longTermAllocation={schemaVersion:1,planId:'portable-allocation',day:input.day,vocabularyTarget:5,items:chosen.map(binding=>{const {title,...identity}=binding;void title;return {...identity,sourceHash:source.inventory.find(i=>i.itemId===binding.itemId).sourceHash};})};
 const plan=await generateTaskPlan(facts);const cloud=await api.sealCloudTaskPlan(plan,catalog,context(0));assert.deepEqual((await api.toEngineTaskPlan(cloud,catalog)),plan);
 const native=(await api.materializeCloudTaskPlan(cloud,input.catalog,materials)).nativePlan;assert.deepEqual(native.longTermAllocation,plan.longTermAllocation);
 const script=`import json,sys\nsys.path.insert(0,'companion')\nfrom account_sync_plan_writer import validate_cloud_plan,materialize_cloud_plan\nx=json.load(sys.stdin)\nvalidate_cloud_plan(x['cloud'])\nprint(json.dumps(materialize_cloud_plan(x['cloud'],x['native'],x['materials']),ensure_ascii=False))`;
 const result=spawnSync(process.env.PYTHON??'C:/Users/30972/Documents/ChatGPT/项目/.codex-staging/zhixue-review-python/Scripts/python.exe',['-c',script],{input:JSON.stringify({cloud,native:input.catalog,materials}),encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'}});
 assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),native);
});
