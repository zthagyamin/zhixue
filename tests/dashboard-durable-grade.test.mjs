import assert from 'node:assert/strict';
import test from 'node:test';
import {dashboardJsxProp,dashboardFunction} from './fixtures/dashboard-functions.mjs';
import {recordStudyAttempt as recordCore} from '../app/study-event-controller.ts';
import {advanceSubjectRound,emptySubjectRound} from '../app/subject-round.ts';
import {createSubjectRoundSessions} from '../app/subject-round-resume.ts';
import {advanceThreeStageSession} from '../app/three-stage-order.ts';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {applySavedNativeAttempt} from '../app/native-progress-view.ts';
import {prepareAttemptEvidence} from '../src/domain/assessment/index.ts';
import {reviewSubmission} from '../src/domain/planning/word-review-probe.ts';
import {attemptFailureMessage} from '../src/features/study-attempt/index.ts';
import {createSubjectGradeHandler} from '../src/features/study-attempt/index.ts';
import {completesSubjectItemAfterAttempt,isSubjectPassComplete} from '../src/domain/planning/index.ts';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
  const put=deferred(),entered=deferred(),network=deferred(),attempts=[],saved=[],observations=[];
  let progress={itemStages:{},fsrsData:{},answered:0,correct:0},rounds={},indices={only:0},indexUpdates=0,bumps=0,networkCalls=0,eventUpdates=0;
  const learningDrafts=createLearningDraftStore(),draftAdapter=learningDrafts.adapter('item','calculation:1');draftAdapter.write('value','3');
  const item={itemId:'only',abilityId:'only',prompt:'1 + 2 = ?',contentHash:'a'.repeat(64)},workspaceId='account:fixture-owner';
  let projection={workspaceId,sourceScope:'fixture',events:[],itemStages:{},fsrsData:{},excludedKeys:[]};
  const roundSession=createSubjectRoundSessions();
  const env={createSubjectGradeHandler,prepareAttemptEvidence,reviewSubmission,quickReview:false,attemptFailureMessage,completesSubjectItemAfterAttempt,roundScope:undefined,getVisibleSubjectRound:roundSession.getVisible,learningDrafts,draftAdapter,draftViewId:'view-a',draftFrame:{navigationEpoch:0},practiceRequest:{current:0},activeLearningDraftsRef:{current:learningDrafts},roundSnapshot:undefined,visibleLearningRef:{current:'view-a'},taskWorkspaceRef:{current:workspaceId},accountModeEpoch:{current:0},
    accountPracticeModes:{current:new Map()},accountLoaded:null,currentItem:item,itemProgressKey:'only',actualPluginType:'calculation',
    nativeView:{ready:true,unresolvedKeys:[]},nativeScope:'fixture',applySavedNativeAttempt,setNativeProjection:fn=>projection=fn(projection),
    advanceSubjectRound,advanceThreeStageSession,round:emptySubjectRound(),items:[item],idx:0,learningStages:{},uiProgress:progress,
    resolveStudyItemProgressKey:()=> 'only',completedStage:0,isDemoMode:false,workspaceId,domain:'python',itemKind:'python',
    sessionUser:{userId:'fixture-owner'},cloudSyncMetadata:{decision:'enabled'},companionSession:{token:'synthetic'},data:{source:{}},subject:{id:'only'},
    itemLabel:()=> '隔离题',markdownNotePath:()=>undefined,resolveEventAbilityId:()=> 'only',eventMutation:{current:0},noteEventsChanged(){},
    putLocalStudyEvent:async record=>{entered.resolve();await put.promise;saved.push(record);},
    captureAttemptFrame:(item,mode)=>({kind:'local',practiceMode:mode}),
    persistSubmittedEvent:async(record,frame,observation)=>{observations.push(structuredClone(observation));entered.resolve();await put.promise;saved.push(record);return {core:record,frame,observation};},
    sendSubmittedCloud:()=>{networkCalls++;return network.promise;},sendSubmittedCompanion:()=>{networkCalls++;return network.promise;},
    setProgress:fn=>progress=fn(progress),setProgressEvents:()=>eventUpdates++,
    setItemIndices:fn=>{indexUpdates++;indices=fn(indices);},setSubjectRounds:fn=>{roundSession.set(fn);rounds=roundSession.getRounds();},setStageRoundBump:fn=>bumps=fn(bumps),
    setDemoProgress(){throw new Error('Not a demo');},setPlanMessage(){},
    sendV3ToCloud:()=>{networkCalls++;return network.promise;},sendV3ToCompanion:()=>{networkCalls++;return network.promise;},updateStudyEventDelivery:async()=>{},
    recordStudyAttempt:(input,deps)=>{const promise=recordCore(input,deps);attempts.push(promise);promise.catch(()=>{});return promise;}};
  t.after(()=>{put.resolve();network.resolve();});
  return {env,put,entered,network,attempts,saved,observations,roundSession,grade:dashboardJsxProp('Plugin.renderUI','onGrade',env),state:()=>({progress,projection,rounds,indices,indexUpdates,bumps,networkCalls,eventUpdates})};
}
test('the actual grade callback freezes assistance at the accepted submit boundary, before asynchronous core creation',async t=>{
  const f=fixture(t),observer=f.env.draftAdapter.assistance;observer.cover();observer.shown('ai-hint','hint-one');f.grade('good');
  observer.shown('ai-tutor','late-feedback');await f.entered.promise;
  assert.deepEqual(f.observations,[{observationScope:'current-page-attempt',preSubmitAssistance:[{action:'ai-hint',count:1}],postSubmitFeedback:[]}]);
  f.put.resolve();f.network.resolve();await Promise.all(f.attempts);
});
test('the actual grade callback advances only after durable local storage and never waits for network',async t=>{
  const f=fixture(t);f.grade('again');await f.entered.promise;
  assert.equal(f.state().indexUpdates,0);assert.deepEqual(f.state().rounds,{});
  f.put.resolve();await tick();assert.equal(f.saved.length,1);assert.equal(f.state().indexUpdates,1);
  assert.equal(f.state().progress.answered,1);assert.equal(f.state().bumps,1,'The current one-item view is invalidated after durable traversal');
  assert.deepEqual(f.state().rounds.only.reviewedKeys,['only']);assert.deepEqual(f.state().rounds.only.correctKeys,[]);
  assert.equal(isSubjectPassComplete(f.state().rounds.only,['only']),true);
  assert.equal(f.state().projection.itemStages.only,0);assert.equal(f.state().projection.events.length,1);assert.deepEqual(f.state().projection.fsrsData.only,f.state().progress.fsrsData.only);
  assert.equal(f.state().networkCalls,2,'Both enabled transports are genuinely still pending');
  assert.equal(f.env.learningDrafts.isPending(),false);f.network.resolve();await Promise.all(f.attempts);
});
test('account grading updates only the matching library view, not legacy local progress',async t=>{
  const f=fixture(t);let view={workspaceId:f.env.workspaceId,libraryId:'library-a',progress:{itemStages:{},fsrsData:{},answered:0,correct:0}};
  f.env.accountLoaded={bundle:{snapshot:{libraryId:'library-a'}}};f.env.accountAttemptHashes={current:new Map()};f.env.accountAttemptSnapshots={current:new Map()};f.env.setAccountProgress=fn=>view=fn(view);
  dashboardJsxProp('Plugin.renderUI','onGrade',f.env)('good');await f.entered.promise;f.put.resolve();await tick();
  assert.equal(view.progress.itemStages.only,3);assert.equal(view.progress.answered,1);assert.equal(f.state().progress.answered,0);
});
test('failed local persistence keeps input and cannot create a completed round',async t=>{
  const f=fixture(t);f.grade('good');await f.entered.promise;f.put.reject(new Error('quota'));
  await Promise.allSettled(f.attempts);await tick();
  assert.equal(f.saved.length,0);assert.equal(f.state().progress.answered,0);assert.equal(f.state().indexUpdates,0);assert.deepEqual(f.state().rounds,{});
  assert.equal(f.env.draftAdapter.read('value',''),'3');assert.equal(f.env.learningDrafts.isPending(),false);
});
test('repeated grading while a local write is pending produces only one immutable attempt',async t=>{
  const f=fixture(t);f.grade('again');f.grade('again');await f.entered.promise;
  assert.equal(f.attempts.length,1);f.put.resolve();f.network.resolve();await Promise.all(f.attempts);
});
test('a late saved attempt cannot navigate away from a newly selected page',async t=>{
  const f=fixture(t);f.grade('again');await f.entered.promise;f.env.visibleLearningRef.current='another-view';f.put.resolve();
  await tick();assert.equal(f.state().progress.answered,1);assert.equal(f.state().indexUpdates,0);assert.equal(f.state().bumps,0);
  f.network.resolve();await Promise.all(f.attempts);
});
test('a late attempt in an old workspace cannot update or dispatch through the new workspace',async t=>{
  const f=fixture(t);f.grade('again');await f.entered.promise;f.env.taskWorkspaceRef.current='different-workspace';f.env.accountModeEpoch.current++;
  f.put.resolve();await tick();f.network.resolve();await Promise.all(f.attempts);
  assert.equal(f.saved.length,1);assert.equal(f.saved[0].workspaceId,'account:fixture-owner');assert.equal(f.state().progress.answered,0);
  assert.equal(f.state().indexUpdates,0);assert.equal(f.state().eventUpdates,0);assert.equal(f.state().networkCalls,0);
});
test('navigation intent before the next paint prevents a delayed attempt from selecting a different item',async t=>{
  const f=fixture(t);f.grade('again');await f.entered.promise;f.env.practiceRequest.current++;f.put.resolve();
  await tick();assert.equal(f.state().indexUpdates,0);f.network.resolve();await Promise.all(f.attempts);
});

for(const mode of ['calculation','recall','three-stage'])test(`${mode} retry keeps the progress of another item completed after the first failure`,async t=>{
 const f=fixture(t),items=[f.env.currentItem,{itemId:'next',abilityId:'next',prompt:'B',contentHash:'b'.repeat(64)}],inputs=[];
 let writes=0;f.network.resolve();
 const renderGrade=(index,draft)=>{
  const state=f.state(),round=state.rounds.only;
  const env={...f.env,actualPluginType:mode,currentItem:items[index],items,idx:index,itemProgressKey:items[index].abilityId,draftAdapter:draft,
   uiProgress:state.progress,learningStages:{only:2,next:2,...state.progress.itemStages},completedStage:mode==='three-stage'?2:0,
   round:round??emptySubjectRound(),roundSnapshot:round,resolveStudyItemProgressKey:item=>item.abilityId,
   recordStudyAttempt:(input,deps)=>{inputs.push(structuredClone(input));return f.env.recordStudyAttempt(input,deps);},
   persistSubmittedEvent:async record=>{if(++writes===1)throw Error('disk');f.saved.push(record);return {core:record};}};
  return dashboardJsxProp('Plugin.renderUI','onGrade',env);
 };
 renderGrade(0,f.env.draftAdapter)('good');await Promise.allSettled(f.attempts);await tick();
 assert.equal(f.saved.length,0);assert.equal(f.env.draftAdapter.hasSaveFailure(),true);
 renderGrade(1,f.env.learningDrafts.adapter('item-b',mode+':1'))('good');await Promise.all(f.attempts.slice(1));await tick();
 assert.deepEqual(f.state().rounds.only.correctKeys,['next']);
 renderGrade(0,f.env.draftAdapter)('good');await Promise.all(f.attempts.slice(1));await tick();
 assert.equal(f.saved.length,2);assert.equal(f.state().progress.answered,2);
 assert.deepEqual(f.state().rounds.only.correctKeys,['only','next']);
 if(mode==='three-stage')assert.deepEqual(inputs.map(input=>input.stageBefore),[2,2,2]);
 if(mode==='recall')assert.deepEqual(new Set(f.state().rounds.only.reviewedKeys),new Set(['only','next']));
 assert.deepEqual(inputs[2],inputs[0],'Retry preserves the immutable formal command, independently of page traversal');
});

for(const [rating,expectedStage] of [['good',3],['again',0]])test(`the actual quick word review callback saves ${rating} as one honest grade`,async t=>{
 const f=fixture(t),word={...f.env.currentItem,word:'tree',meaning:'树',example:'This tree grows in the garden.'};
 let submittedFrame;
 const env={...f.env,currentItem:word,items:[word],actualPluginType:'three-stage',itemKind:'word',domain:'ielts',quickReview:true,completedStage:0,learningStages:{only:0},
   persistSubmittedEvent:async(record,frame)=>{submittedFrame=frame;f.entered.resolve();await f.put.promise;f.saved.push(record);return{core:record};}};
 f.network.resolve();dashboardJsxProp('Plugin.renderUI','onGrade',env)(rating);
 await f.entered.promise;f.put.resolve();await Promise.all(f.attempts);await tick();
 assert.equal(submittedFrame.practiceMode,'flashcard');
 assert.deepEqual([f.saved[0].event.attempt.stageBefore,f.saved[0].event.attempt.stageAfter],[0,expectedStage]);
 assert.ok(f.saved[0].event.scheduling);assert.equal(f.state().progress.itemStages.only,expectedStage);
 if(rating==='again'){assert.equal(f.state().indices.only,0);assert.equal(f.state().bumps,1);}
 else assert.deepEqual(f.state().rounds.only.correctKeys,['only']);
});

for(const mode of ['calculation','recall'])test(`${mode} continuing saved A after B preserves both and selects the unfinished C`,async t=>{
 const f=fixture(t),items=[f.env.currentItem,...['B','C'].map(id=>({itemId:id,abilityId:id,prompt:id,contentHash:id.toLowerCase().repeat(64)}))];
 f.network.resolve();f.put.resolve();
 const grade=(index,draft)=>{
  const state=f.state(),round=state.rounds.only;
  return dashboardJsxProp('Plugin.renderUI','onGrade',{...f.env,actualPluginType:mode,items,currentItem:items[index],idx:index,
   itemProgressKey:items[index].abilityId,draftAdapter:draft,uiProgress:state.progress,round:round??emptySubjectRound(),roundSnapshot:round,
   resolveStudyItemProgressKey:item=>item.abilityId});
 };
 grade(0,f.env.draftAdapter)('good',{deferAdvance:true});await Promise.all(f.attempts);await tick();
 const b=f.env.learningDrafts.adapter('item-b',mode+':1');
 grade(1,b)('good',{deferAdvance:true});await Promise.all(f.attempts);await tick();
 assert.equal(b.continueAfterFeedback(),true);assert.deepEqual(f.state().rounds.only.correctKeys,['B']);
 assert.equal(f.env.draftAdapter.continueAfterFeedback(),true);
 assert.equal(f.env.draftAdapter.continueAfterFeedback(),false);
 assert.deepEqual(f.state().rounds.only.correctKeys,['only','B']);assert.equal(f.state().indices.only,2);
 assert.equal(f.saved.length,2);assert.equal(f.state().progress.answered,2);
});

test('a saved subject callback cannot mix its original result into a different task scope',async t=>{
 const f=fixture(t);f.put.resolve();f.network.resolve();
 f.grade('good',{deferAdvance:true});await Promise.all(f.attempts);await tick();
 f.roundSession.activate('only','another-task',emptySubjectRound());
 assert.equal(f.env.draftAdapter.continueAfterFeedback(),true);
 assert.deepEqual(f.roundSession.getVisible('only').round.correctKeys,[]);
 assert.equal(f.state().indexUpdates,0);assert.equal(f.saved.length,1);
});

test('a saved vocabulary stage advances to another word before its event projection repaints the old word',async t=>{
 const f=fixture(t),item={abilityId:'only',word:'disturb',contentHash:'a'.repeat(64)},other={abilityId:'next',word:'retain',contentHash:'b'.repeat(64)};
 const env={...f.env,currentItem:item,items:[item,other],actualPluginType:'three-stage',itemKind:'word',domain:'ielts',
   resolveStudyItemProgressKey:item=>item.abilityId,
   setProgressEvents:()=>{f.env.visibleLearningRef.current='old-word-next-stage';}};
 dashboardJsxProp('Plugin.renderUI','onGrade',env)('good');await f.entered.promise;
 assert.equal(f.state().indexUpdates,0);f.put.resolve();await tick();
 assert.equal(f.saved.length,1);assert.equal(f.state().indices.only,1);
 assert.equal(f.state().progress.itemStages.only,1);assert.deepEqual(f.state().rounds.only.correctKeys,[]);
 f.network.resolve();await Promise.all(f.attempts);
});
test('demo grading updates only the demonstration projection, never personal learning storage',t=>{
  const f=fixture(t);let demo={itemStages:{},answered:0,correct:0};
  const grade=dashboardJsxProp('Plugin.renderUI','onGrade',{...f.env,isDemoMode:true,setDemoProgress:fn=>demo=fn(demo)});
  grade('good');assert.equal(demo.answered,1);assert.equal(demo.itemStages.only,3);assert.equal(f.attempts.length,0);assert.equal(f.saved.length,0);
});
test('the inline dashboard save hook resolves after local progress but not network delivery',async t=>{
  const f=fixture(t),env={...f.env,deliveryOwnerRef:{current:f.env.workspaceId},accountLoadedRef:{current:null},resolvableNotePath:()=>undefined};
  const item={itemId:'only',fingerprint:'a'.repeat(64),questionType:'calculation',prompt:'1 + 2 = ?',sourceLabel:'Synthetic',domain:'course'};
  const persist=dashboardFunction('recordPracticeAttempt',env);
  let resolved=false;const saved=f.env.learningDrafts.submit(f.env.draftAdapter,{intent:'good',current:()=>true,execute(request,control){return persist({item,rating:'good',correct:true,attempts:0,assistance:null},{request,durable:()=>control.durable()});}}).then(()=>{resolved=true;});
  await f.entered.promise;assert.equal(resolved,false);assert.equal(f.state().progress.answered,0);f.put.resolve();await saved;
  assert.equal(f.state().progress.answered,1);await tick();assert.equal(f.state().networkCalls,2);f.network.resolve();await Promise.all(f.attempts);
});
test('a real local-source attempt keeps native writeback pending when the paired connection is temporarily absent',async t=>{
  const f=fixture(t),env={...f.env,companionSession:null,cloudSyncMetadata:{decision:'disabled'}};
  dashboardJsxProp('Plugin.renderUI','onGrade',env)('good');await f.entered.promise;f.put.resolve();await tick();
  assert.equal(f.saved[0].companion,'pending');assert.equal(f.saved[0].cloud,'not-required');f.network.resolve();await Promise.all(f.attempts);
});

for(const rating of ['good','again'])test(`calculation ${rating} saves once but retains feedback and view until explicit continue`,async t=>{
 const f=fixture(t),draft=f.env.draftAdapter,s=f.env.learningDrafts;
 draft.write('result',{correct:rating==='good',explanation:'查看计算过程'});
 const version=s.getItemVersion('only');
 f.grade(rating,{deferAdvance:true});await f.entered.promise;
 assert.equal(draft.hasSavedFeedback(),false);assert.equal(draft.continueAfterFeedback(),false);
 f.put.resolve();await tick();
 assert.equal(f.saved.length,1);assert.equal(f.state().progress.answered,1);
 assert.equal(f.state().indexUpdates,0);assert.equal(f.state().bumps,0);assert.deepEqual(f.state().rounds,{});
 assert.equal(s.getItemVersion('only'),version);assert.match(draft.read('result',{}).explanation,/计算过程/);
 f.grade(rating,{deferAdvance:true});assert.equal(f.attempts.length,1);
 assert.equal(draft.continueAfterFeedback(),true);assert.equal(draft.continueAfterFeedback(),false);
 assert.equal(f.state().indexUpdates,1);assert.equal(f.state().progress.answered,1);assert.equal(f.attempts.length,1);
 f.network.resolve();await Promise.all(f.attempts);
});
test('calculation save failure cannot create a saved feedback continuation',async t=>{
 const f=fixture(t);f.env.draftAdapter.write('result',{correct:true,explanation:'原始解析'});
 f.grade('good',{deferAdvance:true});await f.entered.promise;f.put.reject(new Error('quota'));
 await Promise.allSettled(f.attempts);await tick();
 assert.equal(f.env.draftAdapter.hasSavedFeedback(),false);assert.equal(f.env.draftAdapter.continueAfterFeedback(),false);
 assert.equal(f.state().progress.answered,0);assert.equal(f.state().indexUpdates,0);assert.equal(f.env.draftAdapter.read('value',''),'3');
});
