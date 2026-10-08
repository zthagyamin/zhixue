import test from 'node:test';
import assert from 'node:assert/strict';
import {loader} from './helpers/causal-harness.mjs';
const activity={completedTaskIds:['done'],startedTaskIds:['started'],pendingItemByTask:{started:'word:2'}};
const load=loader({}, {
 'app/study-submission-history.ts':{readAccountLocalPractice:async()=>({bundles:[],records:[],taskRecords:[]})},
 'app/account-study-planning-projection.ts':{accountTaskCompletedItems:async()=>({done:['word:1']}),accountTaskActivity:async()=>structuredClone(activity)},
});
const {createPlanningSourceAdapter,resolvePlanningGroups}=load('app/study-dashboard/planning-source-adapter.ts');
const day='2026-09-20',lease={scope:{owner:'owner',libraryId:'lib',day,mode:'account'},current:()=>true};
function frame(){
 const catalog={sourceHash:'source',subjects:[]},cloudCatalog={catalogHash:'catalog',snapshotId:'snapshot',libraryId:'lib',subjects:[]},bundle={snapshot:{snapshotId:'snapshot',libraryId:'lib'},items:[]};
 const source={plan:{day,sourceHash:'source',tasks:[]},catalog,cloud:{catalogHash:'catalog'},cloudCatalog,bundle};
 return {owner:'owner',day,account:{catalogs:[cloudCatalog],bundles:[bundle],records:[]},accountPlan:{ready:true,error:null,source},progress:{itemStages:{}},overrides:{item:{},subject:{}},selection:null,journal:{},readAccountDay:async()=>assert.fail('subject entry should not introduce a network requirement')};
}

test('subject source uses the verified account snapshot and projects actual activity for resume',async()=>{
 const f=frame(),adapter=createPlanningSourceAdapter(()=>f),source=await adapter.loadSubject(lease);
 assert.equal(source.plan,f.accountPlan.source.plan);assert.deepEqual(source.completedTaskIds,activity.completedTaskIds);
 assert.deepEqual(source.startedTaskIds,activity.startedTaskIds);assert.deepEqual(source.pendingItemByTask,activity.pendingItemByTask);
});

test('unverified plan source requires explicit recovery, while a verified empty day may use free study',async()=>{
 const f=frame(),adapter=createPlanningSourceAdapter(()=>f);f.accountPlan.ready=false;
 await assert.rejects(adapter.loadSubject(lease),/今日计划暂不可用/);
 f.accountPlan={ready:true,source:null,error:'offline'};await assert.rejects(adapter.loadSubject(lease),/今日计划暂不可用/);
 f.accountPlan.error=null;assert.equal(await adapter.loadSubject(lease),null);
});

for(const mode of ['three-stage','spelling','flashcard','recall','quiz','calculation','code','paper'])test(`${mode} resolves a real same-mode subject into one multi-item group`,()=>{
 const items=Array.from({length:3},(_,i)=>({accountItemKey:'item:'+i,id:'item:'+i,pluginType:mode,
  ...(mode==='three-stage'||mode==='spelling'?{word:'term'+i,meaning:'意义',example:'Example '+i}:{}),
  ...(mode==='flashcard'?{front:'front '+i,back:'back '+i}:{}),
  ...(['recall','quiz','calculation','code'].includes(mode)?{prompt:'Question '+i,answer:'3',options:['3','4'],initialCode:'pass',testCode:'assert True'}:{}),
  ...(mode==='paper'?{paper:{paperId:'paper'+i,title:'Synthetic paper',sections:[{id:'s',title:'Section',paragraphs:[{id:'p',rawEn:'Synthetic paragraph.'}]}]}}:{}),
 }));
 for(const item of items)assert.equal(load('app/plugin-routing.ts').resolvePluginType(item,mode),mode);
 const subject={id:'subject',name:'Subject',pluginType:mode,items};
 const tasks=items.map(item=>({taskId:item.id,subjectId:'subject',category:'review',title:item.id,quantity:1,sourceHash:'source',action:{kind:'practice',itemKeys:[item.id]}}));
 const plan={day,tasks},catalog={subjects:[{subjectId:'subject',words:[]}],sourceHash:'source'};
 const groups=resolvePlanningGroups(plan,catalog,[subject],{itemStages:{}},{item:{},subject:{}});
 assert.equal(groups.length,1);assert.deepEqual(groups[0].itemKeys,items.map(item=>item.id));
 assert.equal(groups[0].adapter.items.length,3);
});
