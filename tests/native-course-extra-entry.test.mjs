import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {IDBFactory} from 'fake-indexeddb';
import {createHooks,loader,nodes,text,tick} from './helpers/causal-harness.mjs';
import {createNativeCourseSourceCache} from '../src/infrastructure/course-study/native-source-cache.ts';
import {createLocalAttemptRepository,evaluationFingerprint} from '../src/infrastructure/learning-attempt/index.ts';
import {createSubmissionJournal} from '../app/study-submission-journal.ts';
import {studyHash} from '../src/domain/sync/index.ts';
import {resolveCourseTask,courseTaskHash,courseDiagnosticHash,attemptEvaluationForDiagnostic} from '../src/domain/course-study/index.ts';

globalThis.indexedDB=new IDBFactory();
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/course-task-support-v2.json',import.meta.url)));
let serial=0;
const Marker=()=>null;
const presentation={
  'app/plugins/index.ts':{registry:{get:()=>({id:'@zhixue/plugin-recall',renderUI:()=>null})}},
  'app/study-plugin-options.tsx':{StudyPluginOptionsProvider:()=>null,StudyPluginOptionsSlot:()=>null},
  'app/study-guidance.tsx':{StudyGuidanceHelp:()=>null},'app/review-context.tsx':{ReviewContext:()=>null},
  'app/learning-draft.tsx':{LearningDraftBoundary:()=>null,LearningDraftLeaveGuard:()=>null},
  'app/study-item-source.tsx':{StudyItemSource:()=>null},'app/math-text.tsx':{MathText:()=>null},
  'app/calculation-client.ts':{gradeCalculationInWorker:()=>assert.fail('No calculation requested')},
};
async function until(hooks,predicate,label){
  const deadline=Date.now()+10000;
  // React commits the navigation layout effects before a learner can interact.
  // This hooks harness must flush that last ready render too, not retain run 0.
  do{hooks.flush();await tick();hooks.render();hooks.flush();if(predicate())return;}while(Date.now()<deadline);
  assert.fail(`${label}: ${text(hooks.view())}`);
}
async function fixture(kind='native'){
  const ownerId=`native-extra-entry-${serial++}`,workspaceId=`account:${ownerId}`;
  const support=structuredClone(fixtures.cases.find(row=>row.valid&&row.mode==='recall').support);
  const libraryId=`local-vault:${'a'.repeat(64)}`;
  const identity={schemaVersion:1,libraryId,itemKey:'practice:extra-course',contentHash:'b'.repeat(64),localBindingHash:'c'.repeat(64)};
  const item={schemaVersion:2,kind:'practice',eventKind:'due',itemKey:identity.itemKey,contentHash:identity.contentHash,
    learningSupport:support,practice:{questionType:'recall',prompt:support.task.prompt,domain:'course'}};
  const body={schemaVersion:1,identity,item,taskHash:await courseTaskHash(resolveCourseTask(item))};
  const capture={...body,captureId:await studyHash(body)};
  const cache=createNativeCourseSourceCache({userId:ownerId,libraryId});
  await cache.save(capture);
  const data={id:'extra-course',itemId:'extra-course',pluginType:'recall',prompt:support.task.prompt,
    domain:'course',learningSupport:support,contentHash:identity.contentHash,localBindingHash:identity.localBindingHash};
  const scope={workspaceId,ownerId,libraryId,snapshotId:'local',itemKey:identity.itemKey,contentHash:identity.contentHash,
    groupId:'source-group',roundId:'source-round',cloud:kind==='cloud',temporary:true,
    ...(kind!=='legacy'?{nativeCourseIdentity:identity,nativeCoursePresentation:item}:{})};
  if(kind==='legacy'){
    data.learningSupport={schemaVersion:1,type:'recall',criteria:[{id:'key',text:'Legacy reference.'}],hints:['One','Two','Three']};
    data.explanation='Legacy reference.';
  }
  if(kind==='word')Object.assign(data,{word:'tree',meaning:'树',example:'A tree grows.'});
  const snapshot={scopeKey:`extra-scope-${ownerId}`,title:'Isolated native extra entry',items:[data],modes:['recall'],
    sourceModes:[kind==='word'?'three-stage':'recall'],recoveryScopes:[scope],source:{title:'Synthetic captured source',scope:'fixture'},
    ...(kind==='native'?{recoveryDay:'2026-10-06'}:{})};
  const calls={grade:[],claim:[],capture:[],read:[]};
  const transport={supported:()=>true,
    capture:async value=>{calls.capture.push(value);return capture;},read:async(...values)=>{calls.read.push(values);return capture;},
    grade:async request=>{
      calls.grade.push(structuredClone(request));
      const task=resolveCourseTask(capture.item,request.taskId);
      const diagnostic={schemaVersion:1,status:'correct',source:'model',feedback:'Synthetic authored-source alignment.',
        matchedPointIds:task.criteria.map(point=>point.id),missedPointIds:[],errorPointIds:[],wrongOptionIds:[],missingOptionIds:[],
        pointEvidence:task.criteria.map(point=>({pointId:point.id,sourceId:point.sourceIds[0],
          sourceQuote:task.sources.find(source=>source.sourceId===point.sourceIds[0]).excerpt,
          answerQuote:request.submission.answer,reason:'Synthetic exact quotation.'}))};
      const trace={provider:'synthetic',modelId:'fixture',promptVersion:'course-task-json-v1',ruleVersion:'course-diagnostic-v1',requestId:request.requestId};
      const evaluation=attemptEvaluationForDiagnostic(diagnostic,request.binding.contentHash);
      const {action,submission,selfStatus,...echo}=request;assert.equal(action,'evaluate');void selfStatus;
      const receipt={...echo,durable:true,originRequestId:request.requestId,answerRevision:submission.answerRevision,
        diagnostic,trace,diagnosticHash:await courseDiagnosticHash(diagnostic,trace),
        attemptEvaluationHash:await evaluationFingerprint(evaluation),remediationTaskId:null};
      return {...receipt,receiptHash:await studyHash(receipt)};
    },
    claim:async request=>{calls.claim.push(request);assert.fail('Temporary extra must not claim a formal score');},
  };
  return {ownerId,workspaceId,libraryId,scope,snapshot,capture,transport,calls};
}
async function page(t,f){
  const exits={count:0,confirms:0};
  const hooks=createHooks(),load=loader(hooks.api,{...presentation,'app/study-dashboard/nonword-plugin-host.tsx':{NonWordPluginHost:Marker}},{confirm:()=>{exits.confirms++;return false;}});
  hooks.mount(load('app/extra-practice-session.tsx').ExtraPracticeSession,
    {snapshot:f.snapshot,nativeCourse:f.transport,onExit(){exits.count++;},canOpenLocal:true,getObsidianUri:()=>''});
  t.after(()=>hooks.unmount());
  const card=()=>[...nodes(hooks.view())].find(node=>node.props.context&&typeof node.props.onGrade==='function');
  await until(hooks,()=>Boolean(card()),'Actual extra page did not expose its ready host');
  return {hooks,card,exits};
}

test('actual cached native extra entry forwards the paired host port and original temporary scope',async t=>{
  const f=await fixture(),p=await page(t,f),card=p.card();
  assert.equal(card.type,Marker);
  assert.equal(card.props.context.nativeCourse,f.transport,'Paired native port must reach this actual auxiliary entry');
  assert.deepEqual(card.props.context.nonWordScope.nativeCourseIdentity,f.capture.identity);
  assert.equal(card.props.context.nonWordScope.temporary,true);
  assert.equal(card.props.context.contentSource.data,f.snapshot.items[0]);
  assert.equal(f.calls.grade.length,0,'Opening the extra entry never grades an answer');
  assert.equal(f.calls.claim.length,0);
});

test('actual extra bridge evaluates and continues a native answer without a formal claim or event',async t=>{
  const f=await fixture(),p=await page(t,f),card=p.card();
  assert.equal(card.props.context.nativeCourse,f.transport);
  const boundHooks=createHooks(),hostHooks=createHooks();let learner;
  const CourseProbe=props=>{learner=props;return null;};
  const boundLoad=loader(boundHooks.api,{...presentation,'src/features/course-study/index.ts':{CourseInteraction:CourseProbe}});
  const outer=boundLoad('app/study-dashboard/nonword-plugin-host.tsx').NonWordPluginHost(card.props);
  boundHooks.mount(outer.type,outer.props);
  hostHooks.mount(loader(hostHooks.api)('src/features/nonword-study/host.tsx').NonWordStudyHost,boundHooks.view().props);
  t.after(()=>{hostHooks.unmount();boundHooks.unmount();});
  const reveal=()=>{
    for(const node of nodes(hostHooks.view()))if(typeof node.type==='function'&&typeof node.props.renderPlugin==='function'){
      const child=node.type(node.props);if(child&&typeof child.type==='function')child.type(child.props);
    }
    return Boolean(learner?.lifecycle.ready);
  };
  await until(hostHooks,reveal,'Actual native auxiliary host did not become ready');
  const raw='最后放入的元素最先取出。';learner.draft.write('answer',raw);await learner.lifecycle.submit(raw);
  const evidence=await learner.lifecycle.course.evaluate();
  assert.equal(evidence.diagnostic.status,'correct');assert.equal(f.calls.grade.length,1);
  assert.equal(f.calls.grade[0].purpose,'remediation');assert.equal(f.calls.grade[0].submission.answer,raw);
  const attempts=createLocalAttemptRepository({userId:f.ownerId,libraryId:f.libraryId});
  const saved=await attempts.read(learner.lifecycle.attemptId);
  assert.equal(saved.parentAttemptId,null);assert.equal(saved.checkpoint.purpose,'remediation');
  assert.equal(saved.formal,null);assert.equal(saved.evaluation.status,'resolved');
  await learner.lifecycle.finishRemediation();
  await until(p.hooks,()=>text(p.hooks.view()).includes('本轮练习结束'),'Actual auxiliary continuation did not finish');
  const retained=await attempts.read(saved.attemptId);
  assert.deepEqual(retained.submitted,saved.submitted);assert.equal(retained.formal,null);
  assert.equal(f.calls.claim.length,0);assert.deepEqual(await createSubmissionJournal().list(f.workspaceId),[]);
  assert.equal(f.calls.capture.length,0,'The known cached source is reused');
  const exit=[...nodes(p.hooks.view())].find(node=>node.type==='button'&&text(node)==='返回本轮完成页');
  assert.ok(exit);exit.props.onClick();
  assert.equal(p.exits.confirms,0,'completed durable auxiliary work must not ask to discard unsubmitted input');
  assert.equal(p.exits.count,1);
});

test('unfinished auxiliary input still requires explicit exit and stays intact when declined',async t=>{
  const f=await fixture(),p=await page(t,f),draft=p.card().props.context.draft;
  draft.write('answer','Unsubmitted auxiliary input');
  const exit=[...nodes(p.hooks.view())].find(node=>node.type==='button'&&text(node)==='结束巩固');exit.props.onClick();
  assert.equal(p.exits.confirms,1);assert.equal(p.exits.count,0);assert.equal(draft.read('answer',''),'Unsubmitted auxiliary input');
  assert.equal(f.calls.grade.length,0);assert.equal(f.calls.claim.length,0);
});

for(const kind of ['legacy','word','cloud'])test(`actual ${kind} extra entry does not receive the native course port`,async t=>{
  const f=await fixture(kind),p=await page(t,f);
  assert.equal(p.card().props.context.nativeCourse,undefined);
  if(kind==='word')assert.equal(p.card().props.context.nonWordScope,undefined);
  assert.equal(f.calls.grade.length,0);assert.equal(f.calls.claim.length,0);
});
