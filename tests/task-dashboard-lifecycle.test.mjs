import assert from 'node:assert/strict';
import test from 'node:test';
import {attachNavigationBindings,attachRestartBindings} from './fixtures/causal-controller-bindings.mjs';
import {dashboardFunction,dashboardClick,dashboardDeclaredFunction,dashboardJsxProp,dashboardValue} from './fixtures/dashboard-functions.mjs';
import {attempt,catalog,DAY} from './fixtures/task-event-fixtures.mjs';
import {generateTaskPlan} from '../app/task-plan-engine.ts';
import {vocabularyInput,courseSubject} from './fixtures/task-plan-input.mjs';
import * as runtime from '../app/task-plan-runtime.ts';
import {rebuildEventProgress} from '../app/review-projection.ts';
import {taskSourceHash} from '../app/task-plan-edit.ts';
import {readBoundStudyHistory} from '../app/native-bound-read.ts';
import {sharedAccountRead} from '../app/account-study-read.ts';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {createLearningDraftStore,learningDraftItemId} from '../app/learning-draft-store.ts';
import {nativeSourceScope,nativeProgressView} from '../app/native-progress-view.ts';
const noop=()=>{};
function attachLocalSource(env){
  env.nativeLongTermSnapshot??=async()=>null;
  env.submissionJournal??={};env.readNativeStudyHistory??=async(_workspace,_journal,options={})=>({events:[...options.cachedEvents??[],...(await env.listWorkspaceStudyEvents()).map(row=>row.event),...options.companionEvents??[]],excludedKeys:[]});
  env.nativeSourceScope??=nativeSourceScope;env.nativeView??={ready:true,unresolvedKeys:[]};env.setNativeProjection??=value=>{env.nativeProjection=value;};env.setNativeHistoryError??=noop;
  env.accountLoadedRef??={current:null};env.accountIntentRef??={current:false};env.accountAttemptActiveRef??={current:false};env.pendingLocalSourceRef??={current:null};
  env.taskWorkspaceRef??={current:env.workspaceId??'test'};env.taskStudyDataRef??={current:{}};env.setLocalSourcePending??=noop;env.setStudySourceEpoch??=noop;
  env.applyLocalStudySource=dashboardFunction('applyLocalStudySource',env);return env;
}
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
test('the actual round-completion button resets only the displayed task keys, not the full free library',async()=>{
  const subject={id:'words',pluginType:'three-stage',items:Array.from({length:40},(_,i)=>({abilityId:`word:${i}`,word:`term${i}`}))};
  const recorded=[],uiProgress={itemStages:Object.fromEntries(subject.items.map(item=>[item.abilityId,3])),fsrsData:{}};
  const learningDrafts=createLearningDraftStore(),target=learningDraftItemId(subject.id,'word:5',subject.items[5]),other=learningDraftItemId(subject.id,'word:0',subject.items[0]);
  learningDrafts.adapter(target,'recall:1').write('answer','selected');learningDrafts.adapter(other,'recall:1').write('answer','keep');
  const env={learningDrafts,learningDraftItemId,subjects:[subject],subject,items:[subject.items[5]],uiProgress,resolveStudyItemProgressKey:item=>item.abilityId,
    setSubjectRounds:noop,setItemIndex:noop,isDemoMode:false,domainForSubject:()=> 'ielts',isVocabularySubject:()=>true,
    workspaceId:'test',data:{source:{}},itemLabel:item=>item.word,markdownNotePath:value=>value,resolveEventAbilityId:item=>item.abilityId,
    accountPracticeModes:{current:new Map()},accountLoaded:null,setProgress:noop,clearItemStages:stages=>stages,
    sessionUser:null,cloudSyncMetadata:{decision:'disabled'},companionSession:null,recordStudyAttempt:input=>recorded.push(input)};
  attachRestartBindings(env,recorded);
  let pendingRestart;const restartActual=dashboardFunction('restartSubjectRound',env);
  env.restartSubjectRound=(...args)=>(pendingRestart=restartActual(...args));
  env.resetWarning=dashboardValue('resetWarning',env);
  let confirmed=false,confirmations=0;
  env.window={confirm:message=>{confirmations++;assert.match(message,/记错/);return confirmed;}};
  // Keep the actual lifecycle assertions, and exercise both sides of the new confirmation.
  const restart=dashboardClick('再学一轮',env,1);
  restart();
  assert.deepEqual(recorded,[]);
  assert.equal(learningDrafts.adapter(target,'recall:1').read('answer',null),'selected');
  confirmed=true;restart();await pendingRestart;assert.equal(confirmations,2);
  assert.deepEqual(recorded.map(event=>event.item.key),['word:5']);
  assert.equal(learningDrafts.adapter(target,'recall:1').read('answer',null),null);assert.equal(learningDrafts.adapter(other,'recall:1').read('answer',null),'keep');
});
for(const entryPoint of ['workspace-navigation','开始学习']) test(`${entryPoint} navigation cancels an already waiting practice start`,async()=>{
  const input=vocabularyInput(0),subject=courseSubject(1);subject.units[0].action={kind:'practice',itemKeys:['practice:one']};subject.units[0].completionRule='graded-practice';subject.goals[0].completionBasis='practice-round';input.catalog.subjects.push(subject);
  input.catalog.practiceSources=[{itemKey:'practice:one',subjectId:'course',title:'One',sourceHash:'c'.repeat(64),completionRule:'graded-practice'}];
  const plan=await generateTaskPlan(input),waiting=deferred(),entered=deferred(),request={current:0};let tab='today',items=null;
  const env={taskLearning:{session:{snapshot:()=>({draft:{plan},catalog:input.catalog}),edit:async()=>{entered.resolve();await waiting.promise;}}},practiceRequest:request,
    setPlanMessage:noop,setActiveTaskScope:noop,setFreeStudySubject:noop,setPracticeLoading:noop,setPracticeSummary:noop,setPracticeSessionKey:noop,
    setTab:value=>tab=value,setPracticeItems:value=>items=value,practicePlanForTask:runtime.practicePlanForTask,practiceForTask:()=>[{itemId:'one'}],
    companionPlanClient:{getPractice:()=>{throw new Error('Module task must not use inline practice fetch');}},data:{practiceItems:[]},normalizedSubjects:[{id:'course',items:[{itemId:'one',contentHash:'c'.repeat(64)}]}],subject:{id:'words'},subjects:[{id:'words'}],
    assertPlanningStudySources:runtime.assertPlanningStudySources,taskSourceHash,primarySubject:{id:'words'},accountAttemptActiveRef:{current:false},accountPendingLoadedRef:{current:null},accountLoadedRef:{current:null},applyAccountLoaded:async()=>{},accountStudyPayload:value=>value};
  env.pendingLocalSourceRef={current:null};env.workspaceId='test';attachNavigationBindings(env);const start=dashboardFunction('startTaskLearning',env)(plan.tasks[0].taskId);await Promise.race([entered.promise,start.then(()=>{throw new Error('Practice start returned before the deferred edit boundary');})]);
  try{env.navigateToStudyTab=dashboardFunction('navigateToStudyTab',env);}catch{/* Pre-fix source has no navigation helper. */}
  if(entryPoint==='workspace-navigation'){
    const navigate=dashboardJsxProp('StudyWorkspaceNavigation','onNavigate',env);
    navigate('words');
  }else{
    dashboardClick(entryPoint,env)();
  }
  waiting.resolve({items:[]});await start;
  assert.equal(tab,'words');assert.equal(items,null);
});
test('a task source changed while start was pending cannot open a different question under the old plan',async()=>{
  const input=vocabularyInput(0),subject=courseSubject(1);subject.units[0].action={kind:'practice',itemKeys:['practice:one']};subject.units[0].completionRule='graded-practice';subject.goals[0].completionBasis='practice-round';input.catalog.subjects.push(subject);
  input.catalog.practiceSources=[{itemKey:'practice:one',subjectId:'course',title:'One',sourceHash:'c'.repeat(64),completionRule:'graded-practice'}];
  const plan=await generateTaskPlan(input),waiting=deferred(),entered=deferred(),subjects=[{id:'course',items:[{itemId:'one',contentHash:'c'.repeat(64)}]}];let tab='today',message='';
  const env={taskLearning:{session:{snapshot:()=>({draft:{plan},catalog:input.catalog}),edit:async()=>{entered.resolve();await waiting.promise;}}},practiceRequest:{current:0},
    workspaceId:'test',normalizedSubjects:subjects,taskStudyDataRef:{current:{subjects}},assertPlanningStudySources:runtime.assertPlanningStudySources,taskSourceHash,practicePlanForTask:runtime.practicePlanForTask,
    setPlanMessage:value=>message=value,setFreeStudySubject:noop,setActiveTaskScope:noop,setItemIndices:noop,setSubjectRounds:noop,setPracticeLoading:noop,setTab:value=>tab=value,emptySubjectRound:()=>({}),accountAttemptActiveRef:{current:false}};
  attachNavigationBindings(env);
  const starting=dashboardFunction('startTaskLearning',env)(plan.tasks[0].taskId);await Promise.race([entered.promise,starting.then(()=>{throw new Error(`Practice start returned before the deferred edit boundary: ${message}`);})]);
  env.taskStudyDataRef.current={subjects:[{id:'course',items:[{itemId:'one',contentHash:'d'.repeat(64)}]}]};waiting.resolve();await starting;
  assert.equal(tab,'today');assert.match(message,/来源|版本/);assert.equal(env.accountAttemptActiveRef.current,false);
});
test('external study-data polling triggers planning refresh even when only source review state changed',async()=>{
  let epoch=0;
  const payload={status:'connected',gateway:{mode:'indexed'},subjects:[]};
  const env={active:true,fetch:async()=>({ok:true,status:200,json:async()=>payload}),companionUrl:'http://127.0.0.1:43224',companionHeaders:{},workspaceId:'test',
    setCompanionDetected:noop,setSyncState:noop,setData:noop,scopeStudyPayload:value=>value,flushPendingActivities:noop,setPairingMessage:noop,
    setStudySourceEpoch:update=>epoch=update(epoch),accountLoadedRef:{current:null}};
  attachLocalSource(env);assert.equal(await dashboardDeclaredFunction('fetchStudyData',env)(),true);assert.equal(epoch,1);
});
test('cold full-study reads allow bounded large-catalog loading instead of a health-probe timeout',async t=>{
  let timeout;
  const original=setTimeout;t.mock.method(globalThis,'setTimeout',(callback,milliseconds,...args)=>{timeout=milliseconds;return original(callback,milliseconds,...args);});
  const env={active:true,AbortSignal:{timeout:value=>{timeout=value;return undefined;}},
    fetch:async()=>({ok:true,status:200,json:async()=>({status:'connected',gateway:{mode:'indexed'},subjects:[]})}),
    companionUrl:'http://127.0.0.1:43224',companionHeaders:{},workspaceId:'test',setCompanionDetected:noop,setSyncState:noop,
    setData:noop,scopeStudyPayload:value=>value,flushPendingActivities:noop,setPairingMessage:noop,setStudySourceEpoch:noop,accountLoadedRef:{current:null}};
  attachLocalSource(env);await dashboardDeclaredFunction('fetchStudyData',env)();
  assert.equal(timeout,50000);
});
test('a completed cloud download publishes the same event projection to the learning module immediately',async()=>{
  const event=await attempt('cloud-second-stage','2026-08-31T01:00:00Z',1,2);
  const c=catalog(),context={catalog:c,sourceReviews:[],captureReviews:[],observedAt:'2026-08-31T02:00:00Z',planRevision:0,capabilities:[]};
  let progress={itemStages:{},fsrsData:{}},published;
  const env={companionPlanClient:{getPlanningContext:async()=>context,getPlanDocument:async()=>({revision:0,candidate:null,history:[]})},
    workspaceId:'test',taskWorkspaceRef:{current:'test'},flushV3Targets:async()=>{},cloudSyncMetadata:{decision:'enabled'},runV3Bootstrap:async options=>{assert.equal(options.strict,true);return {supported:true};},eventMutation:{current:0},
    syncTaskEvents:async()=>[],loadPlanningRecords:async()=>[],listWorkspaceStudyEvents:async()=>[{event}],uiProgress:progress,
    fetch:async()=>({ok:true,json:async()=>({status:'connected',source:{title:'fixture',scope:''},subjects:[{id:'vocab',name:'Words',pluginType:'three-stage',items:[{abilityId:'word:tree',word:'Tree',contentHash:'a'.repeat(64)}]}]})}),
    companionUrl:'http://127.0.0.1:43224',companionHeaders:{},scopeStudyPayload:value=>value,setData:noop,setSyncState:noop,
    assertPlanningStudySources:runtime.assertPlanningStudySources,rebuildEventProgress,eventProjection:{current:null},
    setProgressEvents:value=>published=value,setProgress:update=>progress=update(progress)};
  attachLocalSource(env);await dashboardFunction('loadTaskBundle',env)('test',DAY,true);
  assert.equal(progress.itemStages['word:tree'],undefined,'raw legacy cache is preserved');assert.equal(env.nativeProjection.itemStages['word:tree'],2);assert.equal(published[0].eventId,event.eventId);
});
function boundBootstrapEnv(fetcher){
  globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
  return{storageReady:true,sessionUser:{userId:'test'},cloudSyncMetadata:{decision:'enabled',v3:{supported:false,cursor:0,projectionMismatchCount:0}},workspaceId:'account:test',sharedAccountRead,fetch:fetcher,
    readBoundStudyHistory:options=>readBoundStudyHistory({...options,fetcher}),accountLoadedRef:{current:null},accountIntentRef:{current:false},accountModeEpoch:{current:0},taskWorkspaceRef:{current:'account:test'},nativeReadControllers:{current:new Set()},
    setCloudSyncMetadata(){throw new Error('Unverified metadata must not be published');},setCloudMessage:noop,noteEventsChanged:noop};
}
test('strict planning bootstrap does not misclassify malformed successful cloud JSON as unsupported offline',async()=>{
  const env=boundBootstrapEnv(async()=>({ok:true,status:200,json:async()=>{throw new SyntaxError('corrupted cloud JSON');}}));
  await assert.rejects(dashboardFunction('runV3Bootstrap',env)({strict:true,notify:false}),/corrupted cloud JSON/);
});
test('strict planning bootstrap propagates HTTP400 instead of treating a bad cursor as unsupported',async()=>{
  const env=boundBootstrapEnv(async()=>({ok:false,status:400,json:async()=>({message:'invalid-cursor'})}));
  await assert.rejects(dashboardFunction('runV3Bootstrap',env)({strict:true,notify:false}),/native-history-read-400/);
});
test('a delayed cache replay cannot overwrite a newly recorded stage',async()=>{
  const entered=deferred(),resume=deferred(),mutation={current:0},event=await attempt('cache-old-first','2026-08-31T01:00:00Z',0,1);
  let progress={itemStages:{'word:tree':2},fsrsData:{}},published;
  const subjects=[{id:'vocab',items:[{abilityId:'word:tree',word:'Tree',contentHash:'a'.repeat(64)}]}];
  const bundle={studyData:{source:{scope:'fixture'},subjects},context:{catalog:catalog()},localEvents:[event],companionRecords:[]};
  const env={taskWorkspaceRef:{current:'test'},taskStudyDataRef:{current:{}},eventMutation:mutation,assertPlanningStudySources:runtime.assertPlanningStudySources,
    listWorkspaceStudyEvents:async()=>[],rebuildEventProgress:async events=>{entered.resolve();await resume.promise;return rebuildEventProgress(events);},eventProjection:{current:null},
    setProgressEvents:value=>published=value,setProgress:update=>progress=update(progress),scopeStudyPayload:value=>value,setData:noop};
  attachLocalSource(env);const restoring=dashboardFunction('restoreTaskStudy',env)('test',bundle);await entered.promise;mutation.current++;resume.resolve();
  await restoring.catch(()=>{});assert.equal(progress.itemStages['word:tree'],2);assert.equal(published,undefined);
});
test('cache restoration rereads local evidence completed before the restore callback started',async()=>{
  const old=await attempt('cache-first-before','2026-08-31T01:00:00Z',0,1),latest=await attempt('cache-second-between','2026-08-31T01:01:00Z',1,2);
  let progress={itemStages:{'word:tree':2},fsrsData:{}},published;
  const subjects=[{id:'vocab',items:[{abilityId:'word:tree',word:'Tree',contentHash:'a'.repeat(64)}]}];
  const bundle={studyData:{source:{scope:'fixture'},subjects},context:{catalog:catalog()},localEvents:[old],companionRecords:[]};
  const env={taskWorkspaceRef:{current:'test'},taskStudyDataRef:{current:{}},eventMutation:{current:1},assertPlanningStudySources:runtime.assertPlanningStudySources,
    listWorkspaceStudyEvents:async()=>[{event:old},{event:latest}],rebuildEventProgress,eventProjection:{current:null},
    setProgressEvents:value=>published=value,setProgress:update=>progress=update(progress),scopeStudyPayload:value=>value,setData:noop};
  attachLocalSource(env);const restored=await dashboardFunction('restoreTaskStudy',env)('test',bundle);
  assert.equal(progress.itemStages['word:tree'],2);assert.ok(published.some(event=>event.eventId===latest.eventId));
  assert.equal(nativeProgressView(progress,env.nativeProjection,{workspaceId:'test',sourceScope:nativeSourceScope('test',bundle.studyData)}).progress.itemStages['word:tree'],2);
  assert.ok(restored.localEvents.some(event=>event.eventId===latest.eventId));
});
