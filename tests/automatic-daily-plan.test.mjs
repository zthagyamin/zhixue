import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {createAccountPreview} from './fixtures/account-preview.mjs';
import {createAccountStudyClient} from '../app/account-study-client.ts';
import {createSubmissionJournal} from '../app/study-submission-journal.ts';
import {composeAccountPlanningInput} from '../app/account-study-planning-projection.ts';
import {buildLongTermPlanningInput} from '../app/long-term-planning-input.ts';
import {generateLongTermSchedule,rebalanceScheduleOnDelta} from '../app/long-term-pacing.ts';
import {createTaskPlanningSession} from '../app/task-planning-session.ts';
import {vocabularyInput} from './fixtures/task-plan-input.mjs';
import {loadTaskDraft,saveTaskDraft} from '../app/local-task-plan.ts';
import {createAutomaticPlanningCoordinator} from '../src/application/planning/index.ts';
import {previewLongTermPlan} from '../app/long-term-editor-model.ts';
import {buildLongTermEditorSource} from '../app/long-term-editor-source.ts';

let automatic;
try { automatic=await import('../app/automatic-account-day.ts'); }
catch(error) { if(error.code!=='ERR_MODULE_NOT_FOUND')throw error; }
const day='2026-09-16';
function schedule(input){
  const source=buildLongTermPlanningInput(input);
  return generateLongTermSchedule(source.inventory,{planId:'automatic-fixture',startDate:day,targetDeadline:'2026-09-18',
    dailyMinutesBudget:{workdayMin:0,workdayMax:120,weekendMax:120,minReviewRatio:0},bufferRatio:0,
    subjectsConfig:[...new Set(source.inventory.map(item=>item.subjectId))].map(subjectId=>({subjectId,priority:1,completionCriteria:'fixed-rounds',requiredRounds:1}))},source.fsrsMap,
    {asOfDate:day,generatedAt:day+'T00:00:00.000Z'});
}
async function account(t){
  globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
  const origin='http://127.0.0.1:4319',preview=await createAccountPreview({origin,scenario:'no-plan',day});t.after(()=>preview.close());
  const client=createAccountStudyClient({companionUrl:origin,expectedUserId:preview.userId,cache:null,
    fetcher:(path,init)=>preview.handle(new Request(new URL(path,origin),{...init,headers:{...init?.headers,Origin:origin}}))});
  const loaded=await client.load(),workspaceId='account:'+preview.userId,journal=createSubmissionJournal();
  const composed=await composeAccountPlanningInput({...loaded,day,previous:null});
  const snapshot=schedule(composed.input);
  await client.mutateLongTermPlan({operationId:'long-term-first',expectedRevision:0,enabled:true,snapshot});
  return {client,loaded,workspaceId,journal,day,preview,snapshot};
}
async function prepare(f,options={}){
  assert.equal(typeof automatic?.prepareAutomaticAccountDay,'function','automatic account day implementation is required');
  return automatic.prepareAutomaticAccountDay({...f,state:await f.client.getPlanState(f.day),
    expectedLongTermRevision:(await f.client.getLongTermPlanState()).revision,isCurrent:()=>true,...options});
}
test('account opening prepares one shared long-term draft without approval, learning events or AI',async t=>{
  const f=await account(t),state=await prepare(f);
  assert.equal(state.revision,1);assert.equal(state.decision,'draft');assert.equal(state.approvedPlan,null);
  assert.equal(state.currentPlan.longTermAllocation.planId,f.snapshot.spec.planId);
  assert.equal((await prepare(f)).currentPlan.cloudPlanHash,state.currentPlan.cloudPlanHash);
  assert.equal((await f.client.getPlanState(day)).revision,1);
  assert.equal(f.preview.inspect().records,0);assert.deepEqual(f.preview.inspect().aiRequests,[]);
});
test('simultaneous devices converge on one daily draft through existing revision checks',async t=>{
  const f=await account(t),state=await f.client.getPlanState(day);
  const results=await Promise.all([prepare(f,{state}),prepare(f,{state})]);
  assert.ok(results.every(result=>result.revision===1));
  assert.equal(results[0].currentPlan.cloudPlanHash,results[1].currentPlan.cloudPlanHash);
  assert.equal((await f.client.getPlanState(day)).revision,1);
});
test('existing, rejected and cancelled arrangements are never replaced automatically',async t=>{
  const f=await account(t),draft=await prepare(f);
  for(const decision of ['draft','approved','rejected','cancelled']){
    const state={...draft,decision};
    const result=await prepare(f,{state,client:{getLongTermPlanState:()=>assert.fail('existing state must be preserved')}});
    assert.equal(result,state);
  }
  const rejected={...draft,currentPlan:null,decision:'rejected'};
  assert.equal(await prepare(f,{state:rejected}),rejected);
});
test('paused goals, missing history and a superseded scope cannot issue a daily draft',async t=>{
  const f=await account(t);
  await f.client.mutateLongTermPlan({operationId:'pause',expectedRevision:1,enabled:false,snapshot:f.snapshot});
  assert.equal((await prepare(f)).currentPlan,null);
  await f.client.mutateLongTermPlan({operationId:'resume',expectedRevision:2,enabled:true,snapshot:f.snapshot});
  assert.equal((await prepare(f,{isCurrent:()=>false})).currentPlan,null);
  await assert.rejects(prepare(f,{loaded:{...f.loaded,eventThrough:1,taskThrough:1}}),/核对|history|fence/);
  assert.equal((await f.client.getPlanState(day)).revision,0);
});
test('new day gets its own allocation and rereading an earlier draft leaves it unchanged',async t=>{
  const f=await account(t),first=await prepare(f);
  const composed=await composeAccountPlanningInput({...f.loaded,day:'2026-09-17',previous:null}),source=buildLongTermPlanningInput(composed.input);
  const snapshot=rebalanceScheduleOnDelta(f.snapshot,source.inventory,[],source.fsrsMap,{asOfDate:'2026-09-17',generatedAt:'2026-09-17T00:00:00.000Z'});
  await f.client.mutateLongTermPlan({operationId:'new-day',expectedRevision:1,enabled:true,snapshot});
  const next=await prepare({...f,day:'2026-09-17'});
  assert.equal(next.currentPlan.day,'2026-09-17');assert.equal(next.currentPlan.longTermAllocation.day,'2026-09-17');
  assert.equal((await f.client.getPlanState(day)).currentPlan.cloudPlanHash,first.currentPlan.cloudPlanHash);
});
test('native prepares after reconciliation and restores the same local draft',async()=>{
  const input={...vocabularyInput(6),day},snapshot=schedule(input),drafts=new Map(),writes=[];
  const session=createTaskPlanningSession({loadDraft:async(_owner,date)=>drafts.get(date)??null,saveDraft:async(_owner,draft)=>{drafts.set(draft.plan.day,structuredClone(draft));writes.push(draft);},
    loadBundle:async()=>({context:{catalog:input.catalog,sourceReviews:[],captureReviews:[],observedAt:day+'T01:00:00.000Z',planRevision:0,capabilities:[]},
      authority:{revision:0,candidate:null,history:[]},localEvents:[],companionRecords:[],taskEvents:[],legacyItemKeys:[],
      history:{local:'complete',cloud:'not-applicable',companion:'complete',tasks:'complete'},longTermPlan:snapshot}),
    putTaskEvent:async()=>assert.fail('automatic draft is not learning'),client:{suggestPlan:async()=>assert.fail('automatic day cannot call AI'),applyTaskPlan:async()=>assert.fail('automatic draft cannot write back')},publish:()=>{}});
  await session.open('native-fixture',day);
  assert.equal(session.snapshot().draft,null,'read authority before fixing the daily allocation');
  await session.prepareAutomaticDay(snapshot);
  const first=session.snapshot().draft;assert.ok(first,'today draft should be ready without clicking generate');
  assert.equal(first.plan.longTermAllocation.planId,snapshot.spec.planId);assert.equal(first.dirty,true);
  await session.open('native-fixture',day);assert.equal(session.snapshot().draft.plan.planHash,first.plan.planHash);
  assert.equal(writes.filter(draft=>draft.plan.day===day).length,1);
});

test('native stale long-term identities cannot block loading the facts needed to repair the schedule',async()=>{
  const old={...vocabularyInput(4),day},snapshot=schedule(old),current={...vocabularyInput(0),day};
  const session=createTaskPlanningSession({loadDraft:async()=>null,saveDraft:async()=>assert.fail('stale goals cannot create a draft'),
    loadBundle:async()=>({context:{catalog:current.catalog,sourceReviews:[],captureReviews:[],observedAt:day+'T01:00:00.000Z',planRevision:0,capabilities:[]},
      authority:{revision:0,candidate:null,history:[]},localEvents:[],companionRecords:[],taskEvents:[],legacyItemKeys:[],
      history:{local:'complete',cloud:'not-applicable',companion:'complete',tasks:'complete'},longTermPlan:snapshot}),
    putTaskEvent:async()=>{},client:{suggestPlan:async()=>assert.fail('no AI'),applyTaskPlan:async()=>{}},publish:()=>{}});
  await session.open('native-fixture',day);assert.equal(session.snapshot().ready,true);assert.equal(session.snapshot().draft,null);
});

test('actual dashboard reconciliation prepares the native day despite its own ready transitions',async()=>{
  const input={...vocabularyInput(4),day},old=schedule(input),order=[],stamp={current:'source-1'};
  old.asOfDate='2026-09-15';let goals=old;
  const source=await buildLongTermEditorSource({input,events:[],sourceHashesByEventId:{},todayLocked:false});
  const session=createTaskPlanningSession({loadDraft:async()=>null,saveDraft:async()=>{},
    loadBundle:async()=>({context:{catalog:input.catalog,sourceReviews:[],captureReviews:[],observedAt:day+'T01:00:00.000Z',planRevision:0,capabilities:[]},
      authority:{revision:0,candidate:null,history:[]},localEvents:[],companionRecords:[],taskEvents:[],legacyItemKeys:[],
      history:{local:'complete',cloud:'not-applicable',companion:'complete',tasks:'complete'},longTermPlan:goals}),
    putTaskEvent:async()=>{},client:{suggestPlan:async()=>assert.fail('no AI'),applyTaskPlan:async()=>{}},publish:()=>{stamp.current='ready-transition';}});
  await session.open('lifecycle',day);stamp.current='source-1';
  const coordinator=createAutomaticPlanningCoordinator({isCurrent:request=>request.sourceStamp==='stable-facts',
    loadSource:async()=>{order.push('read');return source;},preview:previewLongTermPlan,
    save:async(_request,mutation)=>{order.push('reconcile');goals=mutation.snapshot;return{enabled:true,revision:2,snapshot:goals,lastOperationId:'saved'};},
    refreshGoals:()=>assert.fail('successful preparation needs no retry'),
    prepareDaily:async(request,state,isCurrent)=>{assert.equal(request.mode,'native');order.push('prepare');return session.prepareAutomaticDay(state.snapshot,isCurrent);},
    now:()=>day+'T12:00:00.000Z',
  });
  const result=await coordinator.request({scope:'scope',mode:'native',day,sourceStamp:'stable-facts',trigger:stamp.current,ready:true,state:{enabled:true,revision:1,snapshot:old,lastOperationId:'old'}});
  assert.equal(result.status,'prepared');assert.equal(stamp.current,'ready-transition');
  assert.deepEqual(order,['read','reconcile','prepare']);assert.ok(session.snapshot().draft);assert.equal(goals.asOfDate,day);
});

test('native simultaneous tabs converge through real IndexedDB without replacing manual changes',async()=>{
  globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
  const input={...vocabularyInput(4),day},goals=schedule(input);
  const make=()=>createTaskPlanningSession({loadDraft:loadTaskDraft,saveDraft:saveTaskDraft,
    loadBundle:async()=>({context:{catalog:input.catalog,sourceReviews:[],captureReviews:[],observedAt:day+'T01:00:00.000Z',planRevision:0,capabilities:[]},
      authority:{revision:0,candidate:null,history:[]},localEvents:[],companionRecords:[],taskEvents:[],legacyItemKeys:[],
      history:{local:'complete',cloud:'not-applicable',companion:'complete',tasks:'complete'},longTermPlan:goals}),
    putTaskEvent:async()=>{},client:{suggestPlan:async()=>assert.fail('no AI'),applyTaskPlan:async()=>{}},publish:()=>{}});
  const first=make(),second=make();await Promise.all([first.open('parallel',day),second.open('parallel',day)]);
  await Promise.all([first.prepareAutomaticDay(goals),second.prepareAutomaticDay(goals)]);
  assert.equal(first.snapshot().draft.plan.planHash,second.snapshot().draft.plan.planHash);
  await first.optionalMinutes(7);await second.prepareAutomaticDay(goals);
  assert.equal((await loadTaskDraft('parallel',day)).plan.optionalMinutes,7);
});

test('pausing goals during account preparation prevents the pending draft write',async t=>{
  const f=await account(t),original=f.client.getLongTermPlanState;let reads=0;
  const client={...f.client,getLongTermPlanState:async()=>{
    if(++reads===2)await f.client.mutateLongTermPlan({operationId:'pause-mid-prepare',expectedRevision:1,enabled:false,snapshot:f.snapshot});
    return original();
  }};
  assert.equal((await prepare(f,{client})).currentPlan,null);
  assert.equal((await f.client.getPlanState(day)).revision,0);
});

test('native evidence change immediately invalidates an in-flight first-day read',async()=>{
  const input={...vocabularyInput(4),day},goals=schedule(input),saved=[];let release,started,calls=0;
  const waiting=new Promise(resolve=>{started=resolve;});
  const bundle={context:{catalog:input.catalog,sourceReviews:[],captureReviews:[],observedAt:day+'T01:00:00.000Z',planRevision:0,capabilities:[]},
    authority:{revision:0,candidate:null,history:[]},localEvents:[],companionRecords:[],taskEvents:[],legacyItemKeys:[],
    history:{local:'complete',cloud:'not-applicable',companion:'complete',tasks:'complete'},longTermPlan:goals};
  const session=createTaskPlanningSession({loadDraft:async()=>null,saveDraft:async(_owner,draft)=>saved.push(draft),
    loadBundle:async()=>{if(++calls===2){started();return new Promise(resolve=>{release=()=>resolve(bundle);});}return bundle;},
    putTaskEvent:async()=>{},client:{suggestPlan:async()=>assert.fail('no AI'),applyTaskPlan:async()=>{}},publish:()=>{}});
  await session.open('scope-change',day);const pending=session.prepareAutomaticDay(goals);
  await waiting;session.evidenceChanged();release();await pending;
  assert.equal(session.snapshot().draft,null);assert.deepEqual(saved,[]);
});

test('the last goal day with existing practice still prepares its preserved allocation',async()=>{
  const input={...vocabularyInput(2),day},inventory=buildLongTermPlanningInput(input),base=schedule(input);
  const snapshot=generateLongTermSchedule(inventory.inventory,{...base.spec,targetDeadline:day},inventory.fsrsMap,{asOfDate:day,generatedAt:day+'T00:00:00.000Z'});
  const source=await buildLongTermEditorSource({input,events:[],sourceHashesByEventId:{},todayLocked:true});
  let prepared=null;
  const coordinator=createAutomaticPlanningCoordinator({isCurrent:()=>true,loadSource:async()=>source,preview:previewLongTermPlan,
    save:()=>assert.fail('no future day to rebalance'),refreshGoals:()=>assert.fail('preserved day is ready'),
    prepareDaily:async(request,state)=>{assert.equal(request.mode,'native');prepared=state.snapshot;return true;},now:()=>day+'T12:00:00.000Z'});
  assert.equal((await coordinator.request({scope:'scope',mode:'native',day,sourceStamp:'facts',trigger:'source',ready:true,state:{enabled:true,revision:1,snapshot,lastOperationId:'old'}})).status,'prepared');
  assert.deepEqual(prepared,snapshot);
});
