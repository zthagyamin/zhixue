import assert from 'node:assert/strict';
import test from 'node:test';
import {isInitialReviewProbe,reviewDisplayStage,reviewSubmission} from '../src/domain/planning/word-review-probe.ts';
import {attempt} from './fixtures/task-event-fixtures.mjs';
import {wordBody} from './fixtures/account-study-fixtures.mjs';
import {sealStudyItem} from '../app/account-study-content.ts';
import {sealStudyRecord,checkStudyRecordBinding} from '../app/account-study-record.ts';
import {sealStudySnapshot} from '../app/account-study-content.ts';
import {prepareAccountStudyRecord} from '../app/account-study-record-client.ts';
import {snapshotBody} from './fixtures/account-study-fixtures.mjs';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
globalThis.indexedDB=indexedDB;globalThis.IDBKeyRange=IDBKeyRange;
import {recordStudyAttempt} from '../app/study-event-controller.ts';
import {advanceThreeStageSession} from '../app/three-stage-order.ts';
import {dashboardValue} from './fixtures/dashboard-functions.mjs';

const review=(events=[],overrides={})=>({review:true,mode:'three-stage',completedStage:0,itemKeys:['word:tree'],events,
  boundary:{kind:'after',occurredAt:'2026-09-24T18:00:00.000Z'},...overrides});

function actualModuleReview(overrides={}){
  const task={subjectId:'vocab',category:'review'};
  const env={groupedTasks:[task],scopedTask:task,selectedVocabEntry:null,isVocabPaced:true,
    taskScope:{catalog:{subjects:[{subjectId:'vocab',words:[{itemKey:'word:tree',legacyKeys:[]}]}]}},
    subject:{id:'vocab'},itemProgressKey:'word:tree',scopedRound:{anchorEventId:'review-anchor',observedAt:'2026-09-24T18:00:00.000Z'},
    progressEvents:[],accountEvents:[],accountLoaded:null,scopedAccountProgress:null,currentDay:'2026-09-24',
    actualPluginType:'three-stage',completedStage:0,isInitialReviewProbe,reviewDisplayStage,...overrides};
  for(const name of ['plannedCategory','isDueWordReview','catalogWord','reviewKeys','reviewAnchor','quickReview','currentStage'])
    env[name]=dashboardValue(name,env);
  return env;
}

test('actual Today module starts a due word at self-assessment and resumes stage one after forgetting',async()=>{
  const anchor=await attempt('review-anchor','2026-09-24T18:00:00Z',2,3);
  const first=actualModuleReview({progressEvents:[anchor]});
  assert.equal(first.quickReview,true);assert.equal(first.currentStage,3);
  const failed=await attempt('quick-forgot','2026-09-24T18:01:00Z',0,0,false);
  const retry=actualModuleReview({progressEvents:[anchor,failed]});
  assert.equal(retry.quickReview,false);assert.equal(retry.currentStage,1);
  const newWord=actualModuleReview({progressEvents:[anchor],groupedTasks:[{category:'new-word'}],scopedTask:{subjectId:'vocab',category:'new-word'}});
  assert.equal(newWord.quickReview,false);assert.equal(newWord.currentStage,1);
});

test('account and legacy Today review entries use the same final-stage shortcut',async()=>{
  const anchor=await attempt('review-anchor','2026-09-24T18:00:00Z',2,3);
  const account=actualModuleReview({accountLoaded:{},scopedAccountProgress:{historyReady:true},accountEvents:[anchor],currentDay:'2026-09-25'});
  assert.equal(account.quickReview,true);assert.equal(account.currentStage,3);
  const legacy=actualModuleReview({taskScope:null,groupedTasks:null,scopedTask:undefined,selectedVocabEntry:{kind:'overdue'}});
  assert.equal(legacy.quickReview,true);assert.equal(legacy.currentStage,3);
});

test('a fresh due word opens final recall without creating stage-one or stage-two evidence',async()=>{
  const old=await attempt('old-completion','2026-09-24T18:00:00Z',2,3);
  const quick=isInitialReviewProbe(review([old]));
  assert.equal(quick,true);assert.equal(reviewDisplayStage(0,quick),3);
  assert.deepEqual(reviewSubmission({completedStage:0,correct:true,quick}),
    {stageBefore:0,stageAfter:3,practiceMode:'flashcard',isThreeStage:false,repeatCurrent:false});
});

test('forgetting records failure and returns the same word to stage one',async()=>{
  const quick=isInitialReviewProbe(review());
  assert.deepEqual(reviewSubmission({completedStage:0,correct:false,quick}),
    {stageBefore:0,stageAfter:0,practiceMode:'flashcard',isThreeStage:false,repeatCurrent:true});
  const failure=await attempt('forgot-review','2026-09-24T18:01:00Z',0,0,false);
  assert.equal(isInitialReviewProbe(review([failure])),false);
  assert.equal(reviewDisplayStage(0,false),1);
  assert.deepEqual(reviewSubmission({completedStage:1,correct:true,quick:false}),
    {stageBefore:1,stageAfter:2,practiceMode:'three-stage',isThreeStage:true,repeatCurrent:false});
});

test('the quick check finishes one word or immediately relearns it within a multiword group',()=>{
  const known=reviewSubmission({completedStage:0,correct:true,quick:true});
  const afterKnown=advanceThreeStageSession({currentIndex:0,stages:[2,0,0],correct:true,random:()=>0});
  assert.equal(afterKnown.stages[0],known.stageAfter);assert.equal(afterKnown.nextIndex,1);
  const forgotten=reviewSubmission({completedStage:0,correct:false,quick:true});
  const afterFailure=advanceThreeStageSession({currentIndex:0,stages:[2,0,0],correct:false,random:()=>0});
  assert.equal(afterFailure.stages[0],0);
  assert.equal(forgotten.repeatCurrent?0:afterFailure.nextIndex,0);
});

test('previous failure remains a relearning state across the next study day',async()=>{
  const failed=await attempt('yesterday-failure','2026-09-24T18:30:00Z',0,0,false);
  assert.equal(isInitialReviewProbe(review([failed],{boundary:{kind:'day',day:'2026-09-25'}})),false);
  const later=await attempt('relearn-complete','2026-09-24T19:00:00Z',2,3);
  assert.equal(isInitialReviewProbe(review([failed,later],{boundary:{kind:'day',day:'2026-09-25'}})),true);
});

test('new words, free learning and already-started review rounds keep their normal stage',async()=>{
  const started=await attempt('started','2026-09-24T18:01:00Z',0,1);
  for(const input of [review([],{review:false}),review([],{mode:'spelling'}),review([],{completedStage:1}),review([started])])
    assert.equal(isInitialReviewProbe(input),false);
  assert.equal(reviewDisplayStage(0,false),1);assert.equal(reviewDisplayStage(1,false),2);
});

test('single-step review remains a valid account record before three-stage relearning',async()=>{
  const item=await sealStudyItem(wordBody());
  const common={schemaVersion:1,libraryId:'library-a',snapshotId:'snapshot-a',contentHash:item.contentHash,originDeviceId:'device-a',
    provenanceMode:'verified-round',parentEventId:null};
  const remembered=await sealStudyRecord({...common,practiceMode:'flashcard',attemptId:'quick-remembered',roundId:'quick-round-a',
    event:await attempt('quick-remembered-event','2026-09-24T18:02:00Z',0,3,true,{item:{kind:'word',key:item.itemKey}})});
  const forgotten=await sealStudyRecord({...common,practiceMode:'flashcard',attemptId:'quick-forgotten',roundId:'quick-round-b',
    event:await attempt('quick-forgotten-event','2026-09-24T18:03:00Z',0,0,false,{item:{kind:'word',key:item.itemKey}})});
  assert.equal(checkStudyRecordBinding(remembered,item),'ready');
  assert.equal(checkStudyRecordBinding(forgotten,item),'ready');
  assert.ok(remembered.event.scheduling);assert.ok(forgotten.event.scheduling);
});

test('only actual review grades and the final relearning step move the review clock',async()=>{
  const saved=[];
  async function grade(at,rating,transition){
    return recordStudyAttempt({workspaceId:'user:review-test',domain:'ielts',item:{kind:'word',key:'word:tree'},rating,
      correct:rating==='good',stageBefore:transition.stageBefore,stageAfter:transition.stageAfter,
      isThreeStage:transition.isThreeStage,reviewedAt:at,delivery:{cloud:'not-required',companion:'not-required'}},
    {persistEvent:async record=>{saved.push(record.event);},persistProgress:async()=>{},sendCloud:async()=>{},sendCompanion:async()=>{},updateDelivery:async()=>{}});
  }
  await grade('2026-09-24T18:00:00Z','again',reviewSubmission({completedStage:0,correct:false,quick:true}));
  await grade('2026-09-24T18:01:00Z','good',reviewSubmission({completedStage:0,correct:true,quick:false}));
  await grade('2026-09-24T18:02:00Z','good',reviewSubmission({completedStage:1,correct:true,quick:false}));
  await grade('2026-09-24T18:03:00Z','good',reviewSubmission({completedStage:2,correct:true,quick:false}));
  assert.deepEqual(saved.map(event=>[event.attempt.stageBefore,event.attempt.stageAfter,Boolean(event.scheduling)]),
    [[0,0,true],[0,1,false],[1,2,false],[2,3,true]]);
});

test('account review failure and subsequent relearning use separate durable record rounds',async()=>{
  const item=await sealStudyItem(wordBody()),snapshot=await sealStudySnapshot(snapshotBody([item]));
  const bundle={snapshot,items:[item]},common={workspaceId:'account:quick-review',bundle,originDeviceId:'device-a'};
  const failure=await prepareAccountStudyRecord({...common,practiceMode:'flashcard',
    event:await attempt('quick-failure','2026-09-24T18:00:00Z',0,0,false,{item:{kind:'word',key:item.itemKey}})});
  const relearn=await prepareAccountStudyRecord({...common,practiceMode:'three-stage',pendingRecords:[failure],
    event:await attempt('relearn-stage-one','2026-09-24T18:01:00Z',0,1,true,{item:{kind:'word',key:item.itemKey}})});
  const next=await prepareAccountStudyRecord({...common,practiceMode:'three-stage',pendingRecords:[failure,relearn],
    event:await attempt('relearn-stage-two','2026-09-24T18:02:00Z',1,2,true,{item:{kind:'word',key:item.itemKey}})});
  assert.equal(failure.parentEventId,null);assert.equal(relearn.parentEventId,null);
  assert.equal(next.parentEventId,relearn.event.eventId);assert.equal(next.roundId,relearn.roundId);
  assert.notEqual(failure.roundId,relearn.roundId);
});
