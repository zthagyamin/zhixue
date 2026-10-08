import assert from 'node:assert/strict';
import test from 'node:test';
import {dashboardEffect,dashboardFunction,dashboardJsxProp} from './fixtures/dashboard-functions.mjs';
import {rebuildEventProgress} from '../app/review-projection.ts';
import {nativeSourceScope,nativeProgressView} from '../app/native-progress-view.ts';
import {attempt} from './fixtures/task-event-fixtures.mjs';
import {attachLegacyBindings} from './fixtures/causal-controller-bindings.mjs';
const settle=async()=>{for(let i=0;i<30;i++)await new Promise(resolve=>setImmediate(resolve));};
function fixture(){
  const data={source:{scope:'native',path:'fixture.md'},subjects:[]};let rawWrites=0,reads=0,projection=null,published=null;
  const env={storageReady:true,accountLoaded:null,accountWanted:false,isDemoMode:false,workspaceId:'account:a',submissionJournal:{},gatewayEvents:[],eventMutation:{current:0},eventProjection:{current:null},
    accountLoadedRef:{current:null},accountIntentRef:{current:false},accountAttemptActiveRef:{current:false},nativeProjectionRef:{current:null},taskWorkspaceRef:{current:'account:a'},taskStudyDataRef:{current:data},nativeScope:nativeSourceScope('account:a',data),nativeSourceScope,
    readRecoverableStudyEvents:async()=>{reads++;return[];},readNativeStudyHistory:async()=>{reads++;return{events:[],excludedKeys:['word:tree']};},rebuildEventProgress,putLocalStudyEvent:async()=>{},
    setProgress:()=>rawWrites++,setNativeProjection:value=>projection=value,setProgressEvents:value=>published=value,setCloudMessage(){},setNativeHistoryError(){}};
  return{env,run:()=>dashboardEffect('进度恢复未应用',env)(),get:()=>({rawWrites,reads,projection,published})};
}
test('native history recovery publishes a source-bound derived view, not a merged legacy cache',async()=>{
  const f=fixture();f.run();await settle();assert.equal(f.get().rawWrites,0);assert.deepEqual(f.get().projection.excludedKeys,['word:tree']);
  const result=nativeProgressView({itemStages:{'word:tree':3},fsrsData:{},answered:1,correct:1},f.get().projection,{workspaceId:'account:a',sourceScope:f.env.nativeScope});assert.deepEqual(result.unresolvedKeys,['word:tree']);
});
test('account intent blocks native history while the account library is still loading',()=>{
  const f=fixture();f.env.accountWanted=true;f.env.accountIntentRef.current=true;assert.equal(f.run(),undefined);assert.equal(f.get().reads,0);
});
test('a source or account change while native history is reading cannot publish the old projection',async()=>{
  const f=fixture(),event=await attempt('native-stale','2026-08-31T01:00:00Z',0,1);
  f.env.readNativeStudyHistory=async()=>{f.env.accountIntentRef.current=true;return{events:[event],excludedKeys:[]};};f.run();await settle();assert.equal(f.get().projection,null);assert.equal(f.get().published,null);
});

test('unknown history cannot enter legacy plan generation or write a new served group',async()=>{
  const message=[];let entered=false,writes=0;
  const env={storageReady:true,normalizedSubjects:[{id:'words'}],progressHistoryReady:false,setPlanMessage:value=>message.push(value),setPlanLoading(){entered=true;},uiProgress:{},
    workspaceId:'account:a',vocabPacingWorkspace:'account:a',subjectPacing:{subjects:{}},isVocabularySubject:()=>false,saveWorkspaceRecord:async()=>{writes++;}};
  attachLegacyBindings(env);await dashboardFunction('generateTodayPlan',env)();assert.equal(entered,false);assert.match(message[0],/历史|核对/);
  assert.equal(dashboardEffect('const next: SubjectPacing',env)(),undefined);assert.equal(writes,0);
});

test('background history cannot replace an active native stage but initial recovery and exit still work',async()=>{
  const f=fixture();f.env.accountAttemptActiveRef.current=true;f.run();await settle();assert.ok(f.get().projection,'first native recovery must not deadlock');
  f.env.nativeProjectionRef.current=f.get().projection;const before=f.get().projection;f.run();await settle();assert.equal(f.get().projection,before,'active stage is frozen');
  f.env.accountAttemptActiveRef.current=false;f.run();await settle();assert.notEqual(f.get().projection,before,'exit refresh publishes newly verified history');
});
test('entering practice during native replay also freezes the pending publication',async()=>{
  const f=fixture();f.env.nativeProjectionRef.current={workspaceId:'account:a',sourceScope:f.env.nativeScope};
  f.env.readNativeStudyHistory=async()=>{f.env.accountAttemptActiveRef.current=true;return{events:[],excludedKeys:[]};};f.run();await settle();assert.equal(f.get().projection,null);
});

test('finishing inline native practice rereads frozen history even without another grade',()=>{
  let refreshes=0;const env={accountAttemptActiveRef:{current:true},accountLoadedRef:{current:null},accountPendingLoadedRef:{current:null},pendingLocalSourceRef:{current:null},workspaceId:'account:a',setPracticeItems(){},setPracticeSummary(){},noteEventsChanged(){refreshes++;}};
  dashboardJsxProp('PracticeSession','onFinish',env)({answered:0,correct:0,wrong:0});assert.equal(env.accountAttemptActiveRef.current,false);assert.equal(refreshes,1);
});
