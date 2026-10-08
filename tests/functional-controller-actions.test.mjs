import {dashboardFunction} from './fixtures/dashboard-functions.mjs';
// Current controller functions; controlled transports/persistence. Scheduler is a test double, unchanged by this patch.
import test from 'node:test';import assert from 'node:assert/strict';
import {loader,extract,createHooks,deferred,tick} from './helpers/causal-harness.mjs';
import {attachLegacyBindings,attachNavigationBindings} from './fixtures/causal-controller-bindings.mjs';
const C='app/study-dashboard/use-dashboard-controller.ts';
const load=loader(createHooks().api),ref=current=>({current});
function state(initial){let value=initial;return{get:()=>value,set:v=>{value=typeof v==='function'?v(value):v;}};}
function restartFixture(count=2){
 const drafts=load('app/learning-draft-store.ts').createLearningDraftStore('restart'),rounds=load('app/subject-round.ts'),progress=state({itemStages:{A:3,B:3},fsrsData:{}}),status=state(null),notes=[];
 const records=[],puts=[];let put=async record=>{records.push(record);return'inserted';};
 const core=extract('app/study-event-controller.ts','recordStudyAttempt')({scheduleReviewAt:()=>({due:'2030-01-01T00:00:00.000Z'}),withStudyEventCoreHash:async event=>({...event,coreHash:'fixture'}),SCHEDULER_VERSION:'fixture',isDurableCompanionAck:()=>false});
 const deps={learningDrafts:drafts,subjects:[{id:'s',pluginType:'three-stage',items:['A','B'].slice(0,count).map(id=>({id,word:id,contentHash:id}))}],uiProgress:progress.get(),workspaceId:'account:a',accountLibraryId:null,nativeScope:'local:l',currentDay:'2026-09-15',data:{source:{path:'a.md'}},restartEpoch:ref(1),accountModeEpoch:ref(1),practiceRequest:ref(1),taskWorkspaceRef:ref('account:a'),activeLearningDraftsRef:ref(drafts),eventMutation:ref(0),restartWork:ref(null),isDemoMode:false,accountLoaded:null,sessionUser:{id:'a'},cloudSyncMetadata:{decision:'enabled'},
 createRestartBatch:load('app/restart-batch.ts').createRestartBatch,resolveStudyItemProgressKey:item=>item.id,learningDraftItemId:load('app/learning-draft-store.ts').learningDraftItemId,emptySubjectRound:rounds.emptySubjectRound,focusRound:rounds.focusRound,clearItemStages:()=>{},setSubjectRounds(){},setItemIndex(){},setProgress:progress.set,setNativeProjection(){},setRestartStatus:status.set,setPlanMessage:m=>notes.push(m),domainForSubject:()=> 'ielts',isVocabularySubject:()=>true,itemKindForDomain:()=> 'word',itemLabel:item=>item.word,markdownNotePath:path=>path,resolveEventAbilityId:item=>item.id,applySavedNativeAttempt:()=>{},recordStudyAttempt:core,
 putLocalStudyEvent:async record=>{puts.push(record);return put(record);},listLocalItemEvents:async(_o,_kind,key)=>records.filter(r=>r.event.item.key===key),noteEventsChanged(){deps.eventMutation.current++;},updateStudyEventDelivery:async()=>{},flushV3Targets:async()=>{}};
 return{deps,drafts,progress,status,notes,records,puts,setPut:f=>put=f,restart:extract(C,'restartSubjectRound')(deps)};
}
test('FUN-01 duplicate normal restart holds the actual draft lock and creates one event per item',async()=>{
 const f=restartFixture(),wait=deferred();f.setPut(async record=>{await wait.promise;f.records.push(record);return'inserted';});
 const first=f.restart('s');await tick();assert.equal(f.drafts.isPending(),true);assert.equal(f.puts.length,1);await f.restart('s');assert.equal(f.puts.length,1);wait.resolve();await first;
 assert.equal(f.puts.length,2);assert.equal(new Set(f.puts.map(r=>r.eventId)).size,2);assert.deepEqual(f.progress.get().itemStages,{A:0,B:0});assert.equal(f.drafts.isPending(),false);assert.equal(f.status.get().completed,2);
});
test('FUN-01 failed suffix retries the same immutable event and never replays the successful prefix',async()=>{
 const f=restartFixture();let fail=true;f.setPut(async record=>{if(record.event.item.key==='B'&&fail)throw Error('disk');f.records.push(record);return'inserted';});
 await f.restart('s');assert.equal(f.status.get().completed,1);assert.equal(f.status.get().canRetry,true);assert.equal(f.drafts.isPending(),false);assert.equal(f.progress.get().itemStages.B,3);
 fail=false;await f.restart('s');assert.deepEqual(f.puts.map(r=>r.event.item.key),['A','B','B']);assert.equal(f.puts[1].eventId,f.puts[2].eventId);assert.equal(f.status.get().completed,2);
});
test('FUN-01 delayed restart projection cannot overwrite a newer persisted answer',async()=>{
 const f=restartFixture(1),wait=deferred();f.setPut(async record=>{await wait.promise;f.records.push(record);return'inserted';});const pending=f.restart('s');await tick();
 f.progress.set(p=>({...p,itemStages:{...p.itemStages,A:1}}));f.records.push({event:{eventId:'new-answer',item:{key:'A',kind:'word'},occurredAt:'2099-01-01T00:00:00.000Z'}});wait.resolve();await pending;assert.equal(f.progress.get().itemStages.A,1);
});
test('FUN-01 leaving the original scope stops unsaved remaining reset items',async()=>{
 const f=restartFixture(),wait=deferred();f.setPut(async record=>{await wait.promise;f.records.push(record);return'inserted';});const pending=f.restart('s');await tick();f.deps.practiceRequest.current++;wait.resolve();await pending;assert.equal(f.puts.length,1);assert.equal(f.progress.get().itemStages.A,3);assert.equal(f.status.get().canRetry,false);assert.equal(f.drafts.isPending(),false);
});
test('FUN-03 manual sync uses the post-flush receipt snapshot even when bootstrap succeeds',async()=>{
 const messages=[],status=[],pending={coreUploads:['event'],coreWritebacks:[],recovery:[],assistance:[],tasks:[],legacyQueues:false};
 const deps={manualSyncing:false,accountWorkspaceId:'account:a',deliveryOwnerRef:ref('account:a'),workspaceId:'account:a',accountModeEpoch:ref(1),taskWorkspaceRef:ref('account:a'),manualSyncBusy:ref(false),setManualSyncing(){},setCloudStatus:s=>status.push(s),setCloudMessage:s=>messages.push(s),runManualStudySync:async d=>{await d.flushV3();return{supported:true};},flushCloudOutbox:async()=>{},flushV3Targets:async()=>{},runV3Bootstrap:async()=>({supported:true}),refreshReviewDiagnostics:async()=>{},exportStudyRecovery:async()=>({complete:true,pending}),manualSyncResult:load('app/manual-sync-result.ts').manualSyncResult};
 await dashboardFunction('syncCloudNow',deps)();assert.equal(status.at(-1),'error');assert.match(messages.at(-1),/云端待接收 1/);assert.doesNotMatch(messages.at(-1),/学习进度已同步/);
 pending.coreUploads=[];await dashboardFunction('syncCloudNow',deps)();assert.equal(status.at(-1),'synced');
});
test('FUN-07 website signout continues after a bounded revoke wait and retains original data checks',async()=>{
 const assigned=[],wait=deferred(),requests=[],deadline=load('app/action-deadline.ts').withinDeadline;
 const deps={signOutBusy:ref(false),prepareStudyNavigation:()=>()=>true,workspaceId:'account:a',accountWorkspaceId:'account:a',deliveryOwnerRef:ref('account:a'),learningDrafts:{isPending:()=>false,hasBuffers:()=>false,clear(){}},window:{confirm:()=>true,location:{assign:url=>assigned.push(url)}},exportStudyRecovery:async()=>({payload:{accountLibraries:[]}}),hasPendingStudyRecovery:()=>true,cancelAccountRead(){},accountModeEpoch:ref(0),companionSession:{},companionUrl:'http://localhost:43121',companionHeaders:{},setCompanionSession(){},fetch:(_url,options)=>{requests.push(options);return wait.promise;},withinDeadline:(operation,ms)=>{assert.equal(ms,2000);return deadline(operation,10);}};
 await dashboardFunction('signOut',deps)();assert.deepEqual(assigned,['/signout-with-chatgpt?return_to=/']);assert.equal(requests[0].signal.aborted,true);wait.reject(Error('late revoke'));await tick();
 const cancelled={...deps,signOutBusy:ref(false),prepareStudyNavigation:()=>null};await dashboardFunction('signOut',cancelled)();assert.equal(requests.length,1);
});
test('FUN-10 local reject really discards the matching candidate without claiming remote audit',async()=>{
 const candidate=state({planHash:'local',day:'2026-09-15'}),messages=[];const deps={useCallback:fn=>fn,rejectPlanBusy:ref(false),deliveryOwnerRef:ref('account:a'),planCandidate:candidate.get(),companionPlanClient:null,syncState:'offline',workspaceId:'account:a',taskWorkspaceRef:ref('account:a'),accountModeEpoch:ref(1),currentDay:'2026-09-15',setPlanCandidate:candidate.set,setPlanMessage:m=>messages.push(m),fetchCurrentPlan:async()=>{},sessionUser:null,setPlanLoading(){}};
 attachLegacyBindings(deps);await extract(C,'rejectTodayPlan')(deps)();assert.equal(candidate.get(),null);assert.match(messages.at(-1),/本页候选/);assert.doesNotMatch(messages.at(-1),/记入审计/);
});
test('FUN-10 failed remote rejection preserves the candidate and duplicate requests do not run',async()=>{
 const wait=deferred(),candidate=state({planHash:'a',day:'2026-09-15'});let calls=0;const deps={useCallback:fn=>fn,rejectPlanBusy:ref(false),deliveryOwnerRef:ref('account:a'),planCandidate:candidate.get(),companionPlanClient:{rejectPlan:()=>{calls++;return wait.promise;}},syncState:'connected',workspaceId:'account:a',taskWorkspaceRef:ref('account:a'),accountModeEpoch:ref(1),currentDay:'2026-09-15',setPlanCandidate:candidate.set,setPlanMessage(){},fetchCurrentPlan:async()=>{},sessionUser:null,setPlanLoading(){}};attachLegacyBindings(deps);const reject=extract(C,'rejectTodayPlan')(deps),first=reject();await reject();assert.equal(calls,1);wait.reject(Error('remote'));await first;assert.equal(candidate.get().planHash,'a');
});
test('FUN-11 actual account continue restores validated A completion and resumes pending B',async()=>{
 const scope=load('app/subject-round-resume.ts'),sessions=scope.createSubjectRoundSessions(),indices=state({}),selected=[];
 const task={taskId:'task',subjectId:'s',sourceHash:'source',category:'practice',action:{kind:'practice',itemKeys:['A','B']}},bundle={snapshot:{snapshotId:'ss',libraryId:'l'},items:['A','B'].map(itemKey=>({itemKey,subjectId:'s',kind:'practice',eventKind:'due',contentHash:'c'.repeat(64),practice:{itemId:itemKey,abilityId:itemKey,domain:'course',questionType:'recall',prompt:itemKey,answer:'reference'}}))};
 const catalog={sourceHash:'source',libraryId:'l',catalogHash:'c',snapshotId:'ss',subjects:[{subjectId:'s',name:'S',words:[],units:[],goals:[]}],practiceSources:['A','B'].map(itemKey=>({itemKey,subjectId:'s',sourceHash:'c'.repeat(64)}))};
 const deps={prepareStudyNavigation:()=>()=>true,currentDay:'2026-09-15',practiceRequest:ref(0),accountModeEpoch:ref(0),workspaceId:'account:a',taskWorkspaceRef:ref('account:a'),accountLoadedRef:ref({catalogs:[{catalogHash:'c',snapshotId:'ss'}],bundles:[bundle],records:[]}),readAccountLocalPractice:async()=>({bundles:[],records:[]}),submissionJournal:{},accountTaskCompletedItems:async()=>({task:['A']}),accountTaskActivity:async()=>({completedTaskIds:[],startedTaskIds:['task'],pendingItemByTask:{task:'A'}}),practicePlanForTask:()=>({items:[]}),setFreeStudySubject(){},accountAttemptActiveRef:ref(false),setActiveTaskScope(){},setSelectedPlanVocabKey(){},setItemIndices:indices.set,setTab:id=>selected.push(id),setPlanMessage:message=>{throw Error(message);},activateSubjectRound:sessions.activate,...scope};
 deps.accountLoadedRef.current.catalogs=[catalog];
 const groups=load('app/study-practice-groups.ts');Object.assign(deps,{...groups,practiceSelection:null,setPracticeSelection(){},uiProgress:{itemStages:{},fsrsData:{}},
  reviewGoalView:load('app/study-review-goal.ts').reviewGoalView,accountStudyPayload:load('app/account-study-payload.ts').accountStudyPayload,
  normalizeDynamicSubjects:load('app/dynamic-ui-model.ts').normalizeDynamicSubjects,resolveStudyItemProgressKey:load('app/dynamic-ui-model.ts').resolveStudyItemProgressKey,
  assertPlanningStudySources:load('app/task-plan-runtime.ts').assertPlanningStudySources,filterPlanSubject:load('app/plan-runtime.ts').filterPlanSubject,
  getPracticeGroups:(plan,catalog,_subjects,ids)=>groups.studyPracticeGroups(plan,catalog,()=> 'recall',ids)});
 attachNavigationBindings(deps);await extract(C,'startAccountLearning')(deps)({day:deps.currentDay,sourceHash:'source',tasks:[task]},'task',catalog, {catalogHash:'c'},'B');assert.equal(indices.get().s,1);assert.deepEqual(sessions.getRounds().s.correctKeys,['A']);assert.deepEqual(selected,['s']);
 const round=load('app/subject-round.ts').advanceSubjectRound({round:sessions.getRounds().s,itemKeys:['A','B'],currentIndex:1,correct:true});assert.ok(round.round.correctKeys.includes('A'));assert.equal(round.complete,true);
});
test('FUN-04 actual export whitelist includes only this owner material and real restore merges idempotently',async()=>{
 const backup=load('app/trial-material-backup-model.ts'),hash=load('app/local-json-integrity.ts').hashLocalJson;
 const owner='account:a',library='local:l',kind=backup.trialMaterialRecordKind(library),body={subject:'math',title:'example',questions:[{id:'q',prompt:'x < 0?',answer:'x > 0',filename:'x.md',section:null,kind:'qa'}]};
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(body))),entry={id:'trial-'+Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join(''),...body};
 const rows=[{id:`${owner}:${kind}`,workspaceId:owner,kind,value:[entry]},{id:owner+':companion-session',workspaceId:owner,kind:'companion-session',value:{key:'private'}}];
 const db={transaction(){const tx={objectStore:()=>({index:()=>({getAll:()=>({result:structuredClone(rows)})})})};queueMicrotask(()=>tx.oncomplete());return tx;},close(){}};
 const read=extract('app/local-study-db.ts','exportRecoveryWorkspaceRecords')({openStudyDb:async()=>db,RECORD_STORE:'fixture',recordId:(a,b)=>a+':'+b,parseBackupTrialMaterials:backup.parseBackupTrialMaterials});
 const exported=await read(owner);assert.equal(exported.length,1);assert.equal(exported[0].kind,kind);assert.deepEqual(exported[0].value,[entry]);
 const payload={workspaceRecords:exported},file={format:'zhixue-study-recovery-v1',schemaVersion:1,workspaceId:owner,payload,payloadHash:await hash(payload)};
 let target=[];const restore=extract('app/trial-material-backup.ts','restoreTrialMaterialBackup')({...backup,updateWorkspaceRecord:async(_o,_k,_f,fn)=>{target=fn(target);},loadWorkspaceRecord:async()=>target});
 await restore(owner,library,file);await restore(owner,library,file);assert.deepEqual(target,[entry]);await assert.rejects(restore('account:b',library,file));assert.deepEqual(target,[entry]);
});
test('R-01 exported direct tab callbacks cannot bypass trial navigation consent',()=>{
 const destinations=[];let allow=false;
 const practiceRequest=ref(4),loading=[];
 const request=extract(C,'requestStudyTab')({tab:'today',confirmStudyNavigation:()=>allow,setTab:next=>destinations.push(next),practiceRequest,setPracticeLoading:value=>loading.push(value)});
 request('sources');assert.deepEqual(destinations,[]);assert.equal(practiceRequest.current,4);allow=true;request('sources');assert.deepEqual(destinations,['sources']);assert.equal(practiceRequest.current,5);assert.deepEqual(loading,[false]);
});
test('actual planning host captures synchronous mode retirement even before the next render',()=>{
 const bundle={snapshot:{libraryId:'synthetic-library'}},account={bundle,bundles:[bundle]};
 const env={workspaceId:'owner',accountLoadedRef:ref(account),accountModeEpoch:ref(3),taskWorkspaceRef:ref('owner')};
 attachNavigationBindings(env);const current=env.navigationOptions.captureBoundary();assert.equal(current(),true);
 env.accountModeEpoch.current++;env.accountLoadedRef.current=null;assert.equal(current(),false);
 env.accountLoadedRef.current=account;assert.equal(current(),false,'returning to the old visible account cannot revive the captured epoch');
});
