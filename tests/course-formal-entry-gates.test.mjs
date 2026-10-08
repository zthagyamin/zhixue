import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {createHooks,loader,nodes,tick,text} from './helpers/causal-harness.mjs';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {sealStudyItem,sealStudySnapshot,routableStudyItem} from '../app/account-study-content.ts';
import {createNonWordRuntime} from '../src/infrastructure/nonword-study/index.ts';
import {createSubmissionJournal} from '../app/study-submission-journal.ts';
import {prepareStudySubmission,persistOriginalSubmission} from '../app/study-submission.ts';
import {recordStudyAttempt} from '../app/study-event-controller.ts';
import {getLocalStudyEvent} from '../app/local-study-events.ts';
import {cacheLocalStudySnapshot} from '../app/local-account-study.ts';
import {prepareAttemptEvidence} from '../src/domain/assessment/index.ts';
import {quizBody,snapshotBody} from './fixtures/account-study-fixtures.mjs';

globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/course-task-support-v2.json',import.meta.url)));
let serial=0;
const noView=()=>null;
test('original vocabulary markers retain legacy recall policy even under a V2 recall display',()=>{
  const draft={read:(_field,fallback)=>fallback};
  for(const marker of [{kind:'word'},{eventKind:'word'},{word:'example'},{pluginType:'three-stage'}])
    assert.throws(()=>prepareAttemptEvidence({rating:'good',mode:'recall',recallConfigured:true,
      original:{...marker,learningSupport:{schemaVersion:2,type:'recall'}}},draft),/study-attempt-policy-unready/);
  const result=prepareAttemptEvidence({rating:'again',mode:'recall',recallConfigured:true,
    original:{kind:'practice',learningSupport:{schemaVersion:2,type:'recall'}}},draft);
  assert.equal(result.rating,'again');assert.equal(result.observation,null);
});
const presentationOverrides={
  'app/plugins/index.ts':{registry:{get:()=>({id:'@zhixue/plugin-recall',renderUI:noView})}},
  'app/study-dashboard/nonword-plugin-host.tsx':{NonWordPluginHost:noView,useNonWordRoundCache:()=>()=>{throw Error('No group restoration requested');}},
  'app/components/ai-sidebar/study-ai-workspace.tsx':{StudyAIOfflineContext:noView},
  'app/math-text.tsx':{MathText:noView},'app/learning-draft.tsx':{LearningDraftBoundary:noView,LearningDraftLeaveGuard:noView},
  'app/study-guidance.tsx':{StudyGuidanceHelp:noView},'app/study-plugin-options.tsx':{StudyPluginOptionsProvider:noView,StudyPluginOptionsSlot:noView},
  'app/study-item-source.tsx':{StudyItemSource:noView},'app/review-context.tsx':{ReviewContext:noView},
  'app/plugins/tutor-follow-up.tsx':{TutorFollowUp:noView},'app/calculation-client.ts':{gradeCalculationInWorker:()=>{throw Error('No calculation requested');}},
};
async function fixture(version=2){
  const ordinal=serial++,ownerId=`formal-entry-${ordinal}`,workspaceId=`account:${ownerId}`;
  const support=version===2?structuredClone(fixtures.cases.find(row=>row.valid&&row.mode==='recall').support):
    {schemaVersion:1,type:'recall',criteria:[{id:'key',text:'最后放入的元素最先取出。',mandatory:true}],hints:['想想放入顺序。','比较最后放入的元素。','最后放入的元素最先取出。']};
  const practice={itemId:'question-one',abilityId:'reading-main',domain:'course',questionType:'recall',prompt:'什么是栈的后进先出？',sourceLabel:'Synthetic captured reference',
    ...(version===1?{answer:'最后放入的元素最先取出。',explanation:'原始参考。'}:{})};
  const item=await sealStudyItem(quizBody({schemaVersion:2,learningSupport:support,practice}));
  const snapshot=await sealStudySnapshot(snapshotBody([item],{snapshotId:`original-snapshot-${ordinal}`}));
  await cacheLocalStudySnapshot(workspaceId,{snapshot,items:[item]});
  const scope={workspaceId,ownerId,libraryId:snapshot.libraryId,snapshotId:snapshot.snapshotId,itemKey:item.itemKey,contentHash:item.contentHash,
    groupId:'original-group',roundId:'original-round',cloud:false};
  const runtime=await createNonWordRuntime(scope,'recall');
  await runtime.session.save('先放入的元素最先取出。',{answer:'先放入的元素最先取出。'});
  await runtime.session.submit('先放入的元素最先取出。','unknown',{maxPreHintLevel:0,answerRevealed:false});
  await runtime.session.assess({status:'incorrect',source:'model',rating:'again',explanation:'Synthetic first result retained.'});
  const identity=await runtime.session.reserve('again'),original=runtime.session.snapshot(),payloads=[],frames=[],writes=[];
  const journal=createSubmissionJournal();
  async function persist(record,frame,observation){
    writes.push(record);frames.push(structuredClone(frame));
    const payload=await prepareStudySubmission(record,frame,observation,journal);
    await journal.put(payload);await persistOriginalSubmission(payload);await journal.markCoreStored(workspaceId,record.eventId);
    payloads.push(payload);return payload;
  }
  return {scope,item,snapshot,runtime,identity,original,payloads,frames,writes,persist,version};
}
function seam(view){return [...nodes(view)].find(node=>node.props.context?.draft&&typeof node.props.onGrade==='function');}
async function mountPending(f){
  const hooks=createHooks(),services={workspaceId:f.scope.workspaceId,ownerId:f.scope.ownerId,libraryId:f.scope.libraryId,cloud:true,
    current:()=>true,records:()=>[],readAttempt:id=>f.runtime.repository.read(id),persist:f.persist,
    sendCloud:async()=>({durable:true,status:'saved'}),sendCompanion:async()=>({durable:true,status:'saved'}),changed(){}};
  const props={original:{attempt:f.original,item:f.item,snapshot:f.snapshot,referenceVerified:true,resumable:true,capability:'complete',notice:''},
    deviceId:'entry-test-device',services,onClose(){}};
  hooks.mount(loader(hooks.api,presentationOverrides)('app/study-dashboard/pending-review.tsx').PendingAttemptReview,props);hooks.flush();
  const plugin=seam(hooks.view());assert.ok(plugin,'actual pending review must expose the production grade callback');
  assert.equal(plugin.props.context.draft.read('recallAttempt',null),null);
  return {hooks,plugin,async close(){hooks.unmount();}};
}
async function mountPractice(f){
  const hooks=createHooks(),drafts=createLearningDraftStore(`practice-entry:${f.scope.ownerId}`),calls=[];
  const item={...routableStudyItem(f.item),itemId:f.item.practice.itemId,abilityId:f.item.practice.abilityId,domain:'course',questionType:'recall',
    prompt:f.item.practice.prompt,sourceLabel:f.item.practice.sourceLabel,contentHash:f.item.contentHash,fingerprint:f.item.contentHash};
  const props={items:[item],drafts,async onRecordAttempt(attempt,context){
    calls.push({attempt:structuredClone(attempt),identity:structuredClone(context.request.identity)});
    await recordStudyAttempt({identity:context.request.identity,workspaceId:f.scope.workspaceId,domain:'differential-review',
      item:{kind:'due',key:f.item.itemKey},rating:attempt.rating,correct:attempt.correct,stageBefore:0,stageAfter:attempt.correct?3:0,
      reviewedAt:context.request.identity.reviewedAt,isThreeStage:false,delivery:{cloud:'pending',companion:'not-required'}},{
      persistEvent:async record=>{await f.persist(record,{kind:'account',practiceMode:'recall',bundle:{snapshot:f.snapshot,items:[f.item]},originDeviceId:'entry-test-device'},attempt.assistance??null);context.durable();},
      persistProgress:async()=>{},sendCloud:async()=>{},sendCompanion:async()=>{},updateDelivery:async()=>{},
    });
  }};
  hooks.mount(loader(hooks.api,presentationOverrides)('app/practice-session.tsx').PracticeSession,props);
  const deadline=Date.now()+10000;let plugin;
  do{hooks.flush();hooks.render();plugin=seam(hooks.view());if(plugin)break;await tick();}while(Date.now()<deadline);
  assert.ok(plugin,`actual practice component did not enter its ready plugin seam: ${text(hooks.view())}`);
  assert.equal(plugin.props.context.draft.read('recallAttempt',null),null);
  return {hooks,plugin,calls,async close(){hooks.unmount();drafts.dispose();}};
}
async function assertFirstFormal(f){
  assert.equal(f.payloads.length,1);
  const payload=f.payloads[0],event=payload.core.event;
  assert.equal(event.eventId,f.identity.eventId);assert.equal(event.scheduling.reviewedAt,f.identity.reviewedAt);
  assert.equal(event.attempt.rating,'again');assert.equal(event.attempt.correct,false);
  assert.equal(payload.route.record.contentHash,f.item.contentHash);assert.equal(payload.route.record.snapshotId,f.snapshot.snapshotId);
  assert.equal(f.frames[0].bundle.items[0].contentHash,f.original.binding.contentHash);
  const stored=await getLocalStudyEvent(f.scope.workspaceId,f.identity.eventId);assert.equal(stored.event.coreHash,event.coreHash);
  const saved=await f.runtime.repository.read(f.original.attemptId);assert.deepEqual(saved.submitted,f.original.submitted);
  assert.deepEqual(saved.formal,f.original.formal);assert.equal(saved.evaluation.outcome,'incorrect');
}
for(const entry of ['pending','practice']){
  test(`actual ${entry} CourseV2 final callback accepts matched first identity without legacy recall state and cannot upgrade it`,async()=>{
    const f=await fixture(),h=entry==='pending'?await mountPending(f):await mountPractice(f);
    try{
      const outcome=await h.plugin.props.onGrade('again',{identity:f.identity,deferAdvance:true});
      assert.equal(outcome.status,'saved',outcome.error?.message??'CourseV2 callback must reach its durable original writer');
      await assertFirstFormal(f);
      const upgrade=await h.plugin.props.onGrade('good',{identity:f.identity,deferAdvance:true});
      assert.notEqual(upgrade.status,'saved');assert.equal(f.payloads.length,1);await assertFirstFormal(f);
      if(entry==='practice'){assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0].identity,f.identity);assert.equal(h.calls[0].attempt.rating,'again');}
    }finally{await h.close();}
  });
  test(`actual ${entry} RecallSupportV1 final callback retains the policy-unready gate`,async()=>{
    const f=await fixture(1),h=entry==='pending'?await mountPending(f):await mountPractice(f);
    try{
      const outcome=await h.plugin.props.onGrade('again',{identity:f.identity,deferAdvance:true});
      assert.equal(outcome.status,'failed');assert.match(outcome.error.message,/study-attempt-policy-unready/);
      assert.equal(f.payloads.length,0);assert.equal(f.writes.length,0);
      assert.equal(Boolean(await getLocalStudyEvent(f.scope.workspaceId,f.identity.eventId)),false);
      const saved=await f.runtime.repository.read(f.original.attemptId);assert.deepEqual(saved.formal,f.original.formal);assert.equal(saved.evaluation.outcome,'incorrect');
    }finally{await h.close();}
  });
}
