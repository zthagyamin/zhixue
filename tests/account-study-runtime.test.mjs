import assert from 'node:assert/strict';
import test from 'node:test';
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';
import {wordBody,quizBody,snapshotBody} from './fixtures/account-study-fixtures.mjs';
import {vocabularyInput} from './fixtures/task-plan-input.mjs';
import {generateTaskPlan} from '../app/task-plan-engine.ts';
import {practicePlanForTask} from '../app/task-plan-runtime.ts';
import {filterPlanSubject} from '../app/plan-runtime.ts';
import {toCloudPlanningCatalog,toEnginePlanningCatalog,sealCloudTaskPlan} from '../app/account-study-planning.ts';
import {accountCompletedTaskIds} from '../app/account-study-planning-projection.ts';
import {accountStudyPayload} from '../app/account-study-payload.ts';
import {sealStudyRecord} from '../app/account-study-record.ts';
import {recordBody} from './fixtures/account-study-fixtures.mjs';
import {attempt} from './fixtures/task-event-fixtures.mjs';
import {dashboardFunction} from './fixtures/dashboard-functions.mjs';
let api;
try { api=await import('../app/account-study-runtime.ts'); } catch(error) { if(error.code!=='ERR_MODULE_NOT_FOUND')throw error; }
async function bundle(items,id='snapshot-a',revision=1){return {items,snapshot:await sealStudySnapshot(snapshotBody(items,{snapshotId:id,revision}))};}

test('AI binds the displayed snapshot when an unchanged question occurs in historical snapshots',async()=>{
  assert.equal(typeof api?.resolveAccountStudyItem,'function');
  const item=await sealStudyItem(quizBody()),old=await bundle([item]),current=await bundle([item],'snapshot-b',2);
  const found=api.resolveAccountStudyItem({bundle:current,bundles:[current,old]}, {itemId:'question-one',fingerprint:item.contentHash,accountSnapshotId:'snapshot-a'});
  assert.equal(found.bundle.snapshot.snapshotId,'snapshot-a');
  assert.equal(found.item.itemKey,'question-one');
  assert.equal(api.resolveAccountStudyItem({bundle:current,bundles:[current,old]},{itemId:'question-one',fingerprint:item.contentHash}).bundle.snapshot.snapshotId,'snapshot-b');
});

test('explicit item identity never falls back to another question sharing its prompt',async()=>{
  assert.equal(typeof api?.resolveAccountStudyItem,'function');
  const item=await sealStudyItem(quizBody()),one=await bundle([item]);
  assert.throws(()=>api.resolveAccountStudyItem({bundle:one,bundles:[one]},{itemId:'missing-item',prompt:item.practice.prompt}),/未同步|未找到/);
  assert.throws(()=>api.resolveAccountStudyItem({bundle:one,bundles:[one]},{itemId:'question-one',fingerprint:'f'.repeat(64)}),/版本|刷新/);
  assert.throws(()=>api.resolveAccountStudyItem({bundle:one,bundles:[one]},{itemId:'question-one',accountSnapshotId:'unknown-snapshot'}),/快照|同步/);
});

test('AI refuses real ambiguity inside one snapshot and binds a word in recall mode by stable ID',async()=>{
  assert.equal(typeof api?.resolveAccountStudyItem,'function');
  const left=await sealStudyItem(quizBody()),right=await sealStudyItem(quizBody({itemKey:'question-two',practice:{...quizBody().practice,itemId:'question-two'}})),word=await sealStudyItem(wordBody()),one=await bundle([left,right,word]);
  assert.throws(()=>api.resolveAccountStudyItem({bundle:one,bundles:[one]},{prompt:left.practice.prompt}),/多道|唯一/);
  assert.equal(api.resolveAccountStudyItem({bundle:one,bundles:[one]},{itemId:'word:tree',prompt:'请闭卷解释：Tree',fingerprint:word.contentHash}).item.itemKey,'word:tree');
});

test('approved account task scopes take precedence even when local task planning is disabled',async()=>{
  assert.equal(typeof api?.resolveModuleTaskScope,'function');
  const input=vocabularyInput(40),plan=await generateTaskPlan(input),task=plan.tasks.find(t=>t.category==='new-word');
  const exact={...task,action:{kind:'practice',itemKeys:task.action.itemKeys.slice(0,15)}};
  const scopedPlan={...plan,tasks:[exact]},scope={plan:scopedPlan,catalog:input.catalog,taskId:task.taskId,subjectId:task.subjectId,adapter:practicePlanForTask(scopedPlan,task.taskId,input.catalog)};
  const result=api.resolveModuleTaskScope({day:plan.day,subjectId:task.subjectId,active:scope,accountMode:true,approved:null,local:null,freeStudy:false});
  const subject={id:task.subjectId,pluginType:'three-stage',items:input.catalog.subjects[0].words.map(w=>({abilityId:w.itemKey,word:w.word}))};
  assert.equal(filterPlanSubject(subject,result.adapter,[subject]).length,15);
});

test('direct module navigation uses today approved tasks and explicit free study remains available',async()=>{
  assert.equal(typeof api?.resolveModuleTaskScope,'function');
  const input=vocabularyInput(40),plan=await generateTaskPlan(input),task=plan.tasks.find(t=>t.category==='new-word');
  const approved={plan:{...plan,tasks:[{...task,action:{kind:'practice',itemKeys:task.action.itemKeys.slice(0,15)}}]},catalog:input.catalog};
  const base={day:plan.day,subjectId:task.subjectId,active:null,accountMode:true,approved,local:null,freeStudy:false};
  const result=api.resolveModuleTaskScope(base);
  assert.equal(result.adapter.items[0].practice.itemKeys.length,15);
  assert.equal(api.resolveModuleTaskScope({...base,freeStudy:true}),null);
  assert.equal(api.resolveModuleTaskScope({...base,day:'2026-09-02'}),null);
  assert.equal(api.resolveModuleTaskScope({...base,approved:null,local:approved}),null,'A local draft cannot activate an account task');
});

test('an approved snapshot freezes its planned subject, not new or unplanned subjects',async()=>{
  const input=vocabularyInput(15),plan=await generateTaskPlan(input);
  const word=await sealStudyItem(wordBody()),oldQuestion=await sealStudyItem(quizBody());
  const newQuestion=await sealStudyItem(quizBody({practice:{...quizBody().practice,prompt:'Updated reading material.'}}));
  const science=await sealStudyItem(quizBody({subjectId:'new-science',itemKey:'science-one',practice:{...quizBody().practice,itemId:'science-one'}}));
  const original=await bundle([word,oldQuestion]),current=await bundle([word,newQuestion,science],'snapshot-b',2);
  const cloudCatalog={subjects:[]},approved={plan,catalog:input.catalog,bundle:original,cloudCatalog};
  const loaded={bundle:current,catalog:cloudCatalog},normalizedSubjects=accountStudyPayload(loaded,'account:test').subjects;
  const view=(tab,extra={})=>{
    const accountModuleSource=dashboardFunction('accountModuleSource',{accountLoaded:loaded,freeStudySubject:null,tab,currentDay:plan.day,activeTaskScope:null,
      accountDailyPlan:{source:approved},resolveAccountModuleSource:api.resolveAccountModuleSource,...extra});
    const moduleSubjects=dashboardFunction('moduleSubjects',{accountLoaded:loaded,accountModuleSource,accountStudyPayload,workspaceId:'account:test',normalizeDynamicSubjects:value=>value,demoVisibleSubjects:normalizedSubjects});
    const moduleNavigationSubjects=dashboardFunction('moduleNavigationSubjects',{accountLoaded:loaded,moduleSubjects,subjects:normalizedSubjects});
    return {source:accountModuleSource,subject:moduleNavigationSubjects.find(subject=>subject.id===tab),focused:moduleNavigationSubjects.some(dashboardFunction('studyFocus',{tab}))};
  };
  const newSubject=view('new-science');
  assert.ok(newSubject.subject,'A newly registered subject must not disappear behind an old approved plan');
  assert.equal(newSubject.focused,true);assert.equal(newSubject.subject.items[0].accountSnapshotId,'snapshot-b');
  assert.equal(view('reading').subject.items[0].prompt,'Updated reading material.');
  assert.equal(view('vocab').source,approved,'The planned subject must retain its approved snapshot');
  assert.equal(view('vocab').subject.items[0].accountSnapshotId,'snapshot-a');
  assert.equal(view('vocab',{freeStudySubject:'vocab'}).subject.items[0].accountSnapshotId,'snapshot-b');
  assert.equal(view('vocab',{currentDay:'2026-09-02'}).source,null);
  assert.equal(view('vocab',{accountLoaded:null}).source,null,'Native mode must never select an account snapshot');
});

test('an active account task keeps its own frozen source when the approved plan changes',async()=>{
  assert.equal(typeof api?.resolveAccountModuleSource,'function');
  const input=vocabularyInput(40),plan=await generateTaskPlan(input),task=plan.tasks.find(t=>t.category==='new-word');
  const source={plan,catalog:input.catalog,bundle:{snapshot:{snapshotId:'old-active'}}};
  const active={plan,catalog:input.catalog,subjectId:task.subjectId,taskId:task.taskId,adapter:practicePlanForTask(plan,task.taskId,input.catalog),accountSource:source};
  const replacement={...source,bundle:{snapshot:{snapshotId:'new-approved'}}};
  const base={day:plan.day,subjectId:task.subjectId,active,approved:replacement,freeStudy:false};
  assert.equal(api.resolveAccountModuleSource(base),source);
  assert.equal(api.resolveAccountModuleSource({...base,approved:null}),source);
  assert.equal(api.resolveAccountModuleSource({...base,freeStudy:true}),null);
  assert.equal(api.resolveAccountModuleSource({...base,subjectId:'new-science'}),null);
});

test('fifteen planned words complete against their frozen versions after the current library refreshes',async()=>{
  const input=vocabularyInput(15),items=await Promise.all(input.catalog.subjects[0].words.map(w=>sealStudyItem(wordBody({itemKey:w.itemKey,title:w.word,word:{...wordBody().word,word:w.word}}))));
  const original=await bundle(items),{catalog}=await toCloudPlanningCatalog(input.catalog,original),native=await toEnginePlanningCatalog(catalog);
  const plan=await generateTaskPlan({...input,catalog:native,day:'2026-09-01'}),cloud=await sealCloudTaskPlan(plan,catalog,{baseRevision:0,factsHash:'f'.repeat(64),eventThrough:0,taskThrough:0,nativeBaseRevision:0});
  const current=await bundle(items,'snapshot-new',2),loaded={bundle:current,bundles:[current,original],catalog,catalogs:[catalog],records:[]};
  const state={day:plan.day,revision:1,currentPlan:cloud,approvedPlan:cloud,approvedOperationId:'approve-one',decision:'approved'};
  const source=await api.prepareAccountPlanSource(loaded,state,plan.day);
  assert.equal(source.bundle.snapshot.snapshotId,'snapshot-a');
  assert.equal(source.plan.tasks[0].action.itemKeys.length,15);
  const payload=accountStudyPayload({...loaded,bundle:source.bundle,catalog:source.cloudCatalog},'account:test');
  assert.equal(payload.subjects[0].items[0].accountSnapshotId,'snapshot-a');
  const rows=[];
  for(let i=0;i<items.length;i++){
    let parent=null;
    for(let stage=0;stage<3;stage++){
      const event=await attempt(`word-${i}-stage-${stage}` ,`2026-09-01T01:${String(i).padStart(2,'0')}:0${stage}Z`,stage,stage+1,true,{item:{kind:'word',key:items[i].itemKey}});
      const record=await sealStudyRecord(await recordBody({event,contentHash:items[i].contentHash,roundId:`round-${i}`,attemptId:`attempt-${i}-${stage}`,parentEventId:parent}));
      rows.push({sequence:rows.length+1,record});parent=event.eventId;
    }
  }
  assert.deepEqual(await accountCompletedTaskIds(cloud,catalog,[original,current],rows.slice(0,-1)),[]);
  assert.deepEqual(await accountCompletedTaskIds(cloud,catalog,[original,current],rows),[plan.tasks[0].taskId]);
  assert.equal(await api.prepareAccountPlanSource(loaded,{...state,approvedPlan:null,approvedOperationId:null},plan.day),null);
});

test('the mobile dashboard calls account AI with the visible question binding and needs no Companion',async()=>{
  const item=await sealStudyItem(quizBody()),previous=await bundle([item]),current=await bundle([item],'snapshot-b',2);
  const loaded={bundle:current,bundles:[current,previous]};let sent;
  const call=dashboardFunction('runAccountQuestionAi',{
    accountLoadedRef:{current:loaded},accountWorkspaceId:'account:test',accountQuestionAiHydrated:true,
    accountAiRequestIds:{current:new Map()},saveWorkspaceRecord:async()=>{},resolveAccountStudyItem:api.resolveAccountStudyItem,
    accountClient:{questionAi:async value=>{sent=value.request;return {result:{...value.request,text:'Checked',verdict:'partial',rating:'hard'}};}},
  });
  const result=await call('recall-grade',{itemId:'question-one',fingerprint:item.contentHash,accountSnapshotId:'snapshot-a'},'My answer');
  assert.equal(sent.snapshotId,'snapshot-a');assert.equal(sent.itemKey,'question-one');assert.equal(sent.contentHash,item.contentHash);assert.equal(sent.kind,'recall-grade');assert.equal(result.rating,'hard');
});
