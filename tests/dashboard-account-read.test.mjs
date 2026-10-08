import assert from 'node:assert/strict';
import test from 'node:test';
import {dashboardFunction,dashboardEffect} from './fixtures/dashboard-functions.mjs';
import {projectAccountProgress} from '../app/account-study-progress.ts';
import {studyHash} from '../app/account-study-content.ts';
function fixture(active=true){
  const bundle={snapshot:{snapshotId:'same-snapshot',libraryId:'library-a',revision:1},items:[]},old={bundle,bundles:[bundle],records:[],writebacks:[],facts:{observedAt:'2026-09-01'},eventThrough:0,taskThrough:0};
  let dataChanges=0,progressChanges=0,progress={itemStages:{word:2,oldOnly:2},fsrsData:{},answered:2,correct:2};
  let view={schemaVersion:1,workspaceId:'account:user-a',libraryId:'library-a',progress,evidenceHash:'a'.repeat(64),historyReady:true};
  const env={accountModeEpoch:{current:1},accountApplyEpoch:{current:0},accountWorkspaceId:'account:user-a',workspaceId:'account:user-a',taskWorkspaceRef:{current:'account:user-a'},currentDay:'2026-09-05',
    accountLoadedRef:{current:old},accountBundlesRef:{current:new Map()},accountAttemptActiveRef:{current:active},accountPendingLoadedRef:{current:null},pendingLocalSourceRef:{current:null},setLocalSourcePending(){},accountDeviceId:'device-a',
    getLocalStudySnapshot:async(_workspace,library)=>library==='library-a'?bundle:null,putLocalStudySnapshot:async()=>{},cacheLocalStudySnapshot:async()=>{},putLocalStudyRecord:async()=>{},applyLocalStudyReceipt:async()=>{},
    materializeStudyHistory:async()=>[],setLastStudyReceipts(){},foldCoreReceiptNotice:current=>current,
    eventMutation:{current:0},listPendingStudyEvents:async()=>[],composeAccountPlanningInput:async()=>({events:[]}),rebuildEventProgress:async()=>({events:[],itemStages:{word:3},fsrsData:{}}),
    submissionJournal:{},readAccountLocalPractice:async()=>({records:[],bundles:[],pendingKeys:new Set(),pendingIds:new Set()}),
    loadAccountProgress:async()=>null,projectAccountProgress,studyHash,emptyProgress:{itemStages:{},fsrsData:{},answered:0,correct:0},
    setAccountReadStatus(){},setAccountLoaded(){},setAccountPreferred(){},setAccountOptedOut(){},setProgress(){throw new Error('Account replay must not change legacy progress');},setAccountProgress(fn){progressChanges++;view=fn(view);progress=view.progress;},setProgressEvents(){},setData(){dataChanges++;},setSyncState(){},noteEventsChanged(){},accountStudyPayload:value=>value};
  return{env,old,apply:dashboardFunction('applyAccountLoaded',env),counts:()=>({dataChanges,progressChanges}),progress:()=>progress};
}
test('same-snapshot background progress cannot reset an active question',async()=>{
  const f=fixture(),incoming={...f.old,eventThrough:1,taskThrough:1};await f.apply(incoming,1);
  assert.deepEqual(f.counts(),{dataChanges:0,progressChanges:0});assert.equal(f.env.accountPendingLoadedRef.current,incoming);assert.equal(f.env.accountLoadedRef.current,f.old);
});
test('an account application from the previous workspace cannot start projecting private data',async()=>{
  const f=fixture(false);f.env.taskWorkspaceRef.current='account:user-b';await f.apply(f.old,1);assert.deepEqual(f.counts(),{dataChanges:0,progressChanges:0});
});
test('workspace changes during replay cannot publish late progress or source data',async()=>{
  const f=fixture(false);f.env.composeAccountPlanningInput=async()=>{f.env.taskWorkspaceRef.current='account:user-b';return{events:[]};};
  const apply=dashboardFunction('applyAccountLoaded',f.env);await apply(f.old,1);assert.deepEqual(f.counts(),{dataChanges:0,progressChanges:0});
});
test('starting practice during replay also freezes the not-yet-published progress',async()=>{
  const f=fixture(false);f.env.composeAccountPlanningInput=async()=>{f.env.accountAttemptActiveRef.current=true;return{events:[]};};
  await dashboardFunction('applyAccountLoaded',f.env)({...f.old,eventThrough:1,taskThrough:1},1);assert.deepEqual(f.counts(),{dataChanges:0,progressChanges:0});assert.equal(f.env.accountLoadedRef.current,f.old);
});
test('cloud replay preserves the visible projection for an item with a locally pending attempt',async()=>{
  const f=fixture(false);f.env.readAccountLocalPractice=async()=>({records:[],bundles:[],pendingKeys:new Set(['word']),pendingIds:new Set()});
  await dashboardFunction('applyAccountLoaded',f.env)(f.old,1);assert.equal(f.progress().itemStages.word,2);
});
test('a lower-revision different library starts from its own projection and cannot inherit old stages',async()=>{
  const f=fixture(false);f.old.bundle.snapshot.revision=99;
  const bundle={snapshot:{snapshotId:'new-library-source',libraryId:'library-b',revision:1},items:[]};
  await f.apply({...f.old,bundle,bundles:[bundle]},1);assert.equal(f.counts().dataChanges,1);assert.equal(f.progress().itemStages.oldOnly,undefined);
});
test('account mode does not run the legacy all-workspace progress projector',()=>{
  let reads=0;const env={storageReady:true,accountLoaded:{bundle:{}},listWorkspaceStudyEvents:()=>{reads++;throw new Error('must not read');}};
  assert.equal(dashboardEffect('进度恢复未应用',env)(),undefined);assert.equal(reads,0);
});
