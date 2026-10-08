import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openD1} from './helpers/sqlite-d1.mjs';
import {AccountStudyStore} from '../db/account-study-store.ts';
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';
import {quizBody,snapshotBody} from './fixtures/account-study-fixtures.mjs';
import {D1LearningAttemptStore,attemptFingerprint,evaluationFingerprint} from '../src/infrastructure/learning-attempt/index.ts';
import {D1CourseEvidenceStore} from '../src/infrastructure/course-study/index.ts';
import {courseTaskHash,resolveCourseTask,courseDiagnosticHash} from '../src/domain/course-study/index.ts';
import {createNonWordSession} from '../src/application/nonword-study/index.ts';
import {courseEvidenceOriginal,executeCourseAction} from '../src/application/course-study/index.ts';
import {createAccountStudyApplication} from '../src/application/account-study/index.ts';
import {courseEvaluationTrace} from '../src/domain/course-ai/index.ts';

const sources=JSON.parse(readFileSync(new URL('./fixtures/course-task-support-v2.json',import.meta.url)));
const at='2026-10-06T00:00:00.000Z';
async function setup(t,{mode='recall',providerFailure=false,loseReceipt=false}={}){
  const db=await openD1(),scope={userId:'course-action-user',libraryId:'course-action-lib'};
  t.after(()=>db.sqlite.close());
  db.sqlite.exec("INSERT INTO learning_accounts(user_id) VALUES ('course-action-user')");
  const support=structuredClone(sources.cases.find(row=>row.valid&&row.mode===mode).support),body=quizBody({schemaVersion:2,learningSupport:support});
  body.practice={itemId:'question-one',abilityId:'reading-main',domain:'course',questionType:mode,prompt:support.task.prompt,sourceLabel:'Synthetic course'};
  const item=await sealStudyItem(body),snapshot=await sealStudySnapshot(snapshotBody([item],{libraryId:scope.libraryId}));
  const study=new AccountStudyStore(db.binding);await study.putSnapshot(scope,{snapshot,items:[item]},0);
  const attempts=new D1LearningAttemptStore(db.binding),evidence=new D1CourseEvidenceStore(db.binding,courseEvidenceOriginal(study,attempts));
  const binding={ownerId:scope.userId,libraryId:scope.libraryId,snapshotId:snapshot.snapshotId,itemKey:item.itemKey,contentHash:item.contentHash,groupId:'group',roundId:'round'};
  let operation=0;
  const session=createNonWordSession({repository:{read:id=>attempts.read(scope,id),mutate:m=>attempts.mutate(scope,m)},binding,attemptId:'course-action-first',formalEventId:'formal-first',mode,purpose:'first',now:()=>at,newId:()=>`op-${++operation}`,fingerprint:attemptFingerprint,evaluationFingerprint});
  await session.open();await session.submit(mode==='quiz'?JSON.stringify(support.correctOptionIds):'刚放进去的那个会先拿出来','unknown');
  const task=resolveCourseTask(item),taskHash=await courseTaskHash(task);
  await evidence.mutate(scope,{schemaVersion:1,kind:'bind',attemptId:'course-action-first',binding,operationId:'bind',expectedRevision:0,updatedAt:at,taskId:task.taskId,taskHash,parentAttemptId:null,parentEvidenceHash:null});
  const journal=new Map(),seen=[];let calls=0,lost=loseReceipt;
  const settings={model:'synthetic-model',provider:'deepseek',baseUrl:'https://example.invalid',revision:1,maxOutputTokens:500};
  const deps={getStudyStore:async()=>study,getAttemptStore:async()=>attempts,getCourseEvidenceStore:async()=>evidence,
    fingerprintCourseEvaluation:evaluationFingerprint,now:()=>new Date(at),getCourseAiTrace:()=>courseEvaluationTrace(settings.model),
    getAiStore:async()=>({getSettings:async()=>settings,begin:async(_,request)=>{const old=journal.get(request.requestId);if(old)return {status:'completed',result:old,settings};return {status:'accepted',settings};},
      complete:async(_,id,_hash,result)=>{journal.set(id,result);},fail:async()=>{}}),
    getCourseAi:async()=>({run:async(request,definition,answer)=>{calls++;seen.push({request,task:definition,answer});if(providerFailure)throw Error('course-ai-provider-error');
      return {diagnostic:{schemaVersion:1,status:'correct',source:'model',feedback:'转述符合原要点。',matchedPointIds:['key'],missedPointIds:[],errorPointIds:[],wrongOptionIds:[],missingOptionIds:[],pointEvidence:[{pointId:'key',sourceId:'section',sourceQuote:'最后放入的元素最先取出',answerQuote:answer,reason:'对应原定义。'}]},trace:{...courseEvaluationTrace(settings.model),provider:'deepseek',requestId:request.requestId}};
    }}),getAccessStore:async()=>({profile:async()=>({libraryId:scope.libraryId})})};
  if(loseReceipt)deps.getCourseEvidenceStore=async()=>({...evidence,supported:()=>evidence.supported(),read:(s,id)=>evidence.read(s,id),mutate:(s,m)=>evidence.mutate(s,m),writeModel:async(s,m)=>{if(lost){lost=false;throw Error('simulated-write-outage');}return evidence.writeModel(s,m);}});
  const context={deps,scope:async()=>scope,requireRole:(p,role)=>{if(p.kind!==role)throw Error('role-rejected');}},auth={principal:{kind:'browser',userId:scope.userId}};
  const request={schemaVersion:1,attemptId:'course-action-first',taskId:task.taskId,taskHash,answerRevision:session.snapshot().submitted.answerRevision,evidenceRevision:1};
  const grade=body=>executeCourseAction({action:'course-grade',requestId:'client-first',request,...body},auth,context,new AbortController().signal);
  return {db,scope,item,session,evidence,context,auth,request,grade,calls:()=>calls,seen,deps};
}
test('real course action reads original answer, persists diagnostic, and repeats without model/official score duplication',async t=>{
  const f=await setup(t),first=await f.grade();assert.equal(first.value.evidence.diagnostic.status,'correct');assert.equal(f.calls(),1);
  assert.equal(f.seen[0].answer,f.session.snapshot().submitted.answer);assert.deepEqual(f.seen[0].task.sources,f.item.learningSupport.task.sources);
  assert.equal(f.session.snapshot().evaluation.status,'pending');assert.equal(f.session.snapshot().formal,null);
  const second=await f.grade();assert.equal(second.value.status,'duplicate');assert.equal(f.calls(),1);
  assert.equal(second.value.evidence.diagnosticHash,first.value.evidence.diagnosticHash);
});
test('course action cannot accept client reference, stale revisions or another task',async t=>{
  const f=await setup(t);
  for(const request of [{...f.request,answer:'forged'},{...f.request,answerRevision:99},{...f.request,taskHash:'b'.repeat(64)}])await assert.rejects(f.grade({request}));
  assert.equal(f.calls(),0);assert.equal(f.session.snapshot().formal,null);
});
test('provider failure keeps persisted unknown diagnosis and preserves original answer without self-assessment',async t=>{
  const f=await setup(t,{providerFailure:true}),result=await f.grade();
  assert.equal(result.value.evidence.diagnostic.status,'undetermined');assert.equal(result.value.evidence.diagnostic.source,'none');
  assert.equal(result.value.evidence.attemptEvaluationHash,null);assert.equal(f.session.snapshot().submitted.answer,'刚放进去的那个会先拿出来');assert.equal(f.session.snapshot().formal,null);
});
test('prepared provider result is journaled before evidence outage and retry reuses it',async t=>{
  const f=await setup(t,{loseReceipt:true});await assert.rejects(f.grade(),/receipt-unknown/);assert.equal(f.calls(),1);
  const result=await f.grade();assert.equal(result.value.evidence.diagnostic.status,'correct');assert.equal(f.calls(),1);
});
test('journaled result survives another device saving unknown without another model call',async t=>{
  const f=await setup(t,{loseReceipt:true});await assert.rejects(f.grade(),/receipt-unknown/);
  const current=await f.evidence.read(f.scope,f.request.attemptId),diagnostic={schemaVersion:1,status:'undetermined',source:'none',reason:'offline',feedback:'另一设备仍待核对。',matchedPointIds:[],missedPointIds:[],errorPointIds:[],wrongOptionIds:[],missingOptionIds:[],pointEvidence:[]};
  await f.evidence.mutate(f.scope,{schemaVersion:1,kind:'diagnose',attemptId:f.request.attemptId,binding:f.session.snapshot().binding,operationId:'other-device-note',expectedRevision:current.revision,updatedAt:at,answerRevision:f.request.answerRevision,diagnostic,trace:null,diagnosticHash:await courseDiagnosticHash(diagnostic,null),attemptEvaluationHash:null});
  const result=await f.grade({request:{...f.request,evidenceRevision:2}});
  assert.equal(result.value.evidence.diagnostic.status,'correct');assert.equal(f.calls(),1);assert.equal(f.session.snapshot().formal,null);
});
test('choice assessment uses original reliable answer set without reserving AI usage',async t=>{
  const f=await setup(t,{mode:'quiz'}),result=await f.grade();assert.equal(result.value.evidence.diagnostic.source,'deterministic');assert.equal(result.value.evidence.diagnostic.status,'correct');assert.equal(f.calls(),0);
});
test('actual account application rejects wrong account/library and device model requests',async t=>{
  const f=await setup(t),app=createAccountStudyApplication(f.deps);
  await assert.rejects(app.post({action:'course-grade',expectedUserId:'other',requestId:'request',request:f.request},f.auth,new AbortController().signal),/account-mismatch/);
  await assert.rejects(app.post({action:'course-grade',libraryId:'other',requestId:'request',request:f.request},f.auth,new AbortController().signal),/library-mismatch/);
  await assert.rejects(app.post({action:'course-grade',requestId:'request',request:f.request},{principal:{kind:'device',state:'active',userId:f.scope.userId,libraryId:f.scope.libraryId}},new AbortController().signal),/action-not-allowed/);
  assert.equal(f.calls(),0);
});
