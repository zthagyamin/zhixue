import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {indexedDB} from 'fake-indexeddb';
import {sealStudyItem} from '../app/account-study-content.ts';
import {quizBody} from './fixtures/account-study-fixtures.mjs';
import {createNonWordSession} from '../src/application/nonword-study/index.ts';
import {createCourseLearningSession} from '../src/application/course-study/index.ts';
import {createLocalAttemptRepository,attemptFingerprint,evaluationFingerprint} from '../src/infrastructure/learning-attempt/index.ts';
import {createLocalCourseEvidenceRepository,createCourseRequestJournal} from '../src/infrastructure/course-study/index.ts';
import {resolveCourseTask,courseTaskHash,courseDiagnosticHash,attemptEvaluationForDiagnostic} from '../src/domain/course-study/index.ts';
globalThis.indexedDB=indexedDB;
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/course-task-support-v2.json',import.meta.url)));
const at='2026-10-06T00:00:00.000Z';let ordinal=0;
async function setup({grade,cloud}={}){
  const scope={userId:`session-owner-${ordinal++}`,libraryId:'library'},support=fixtures.cases[0].support;
  const body=quizBody({schemaVersion:2,learningSupport:support});
  body.practice={itemId:'question-one',abilityId:'reading-main',domain:'course',questionType:'recall',prompt:support.task.prompt,sourceLabel:'Synthetic course'};
  const item=await sealStudyItem(body),binding={ownerId:scope.userId,libraryId:scope.libraryId,snapshotId:'snapshot',itemKey:item.itemKey,contentHash:item.contentHash,groupId:'group',roundId:'round'};
  const attempts=createLocalAttemptRepository(scope);let op=0;
  const session=createNonWordSession({repository:attempts,binding,attemptId:'first',formalEventId:'formal',mode:'recall',purpose:'first',now:()=>at,newId:()=>`attempt-op-${++op}`,fingerprint:attemptFingerprint,evaluationFingerprint});await session.open();
  const repository=createLocalCourseEvidenceRepository(scope,{cloud:Boolean(cloud),readAttempt:id=>attempts.read(id),readItem:async()=>item});
  const runtime={session,purpose:'first',status:async()=>'',afterWrite:async()=>{}};
  const options={runtime,repository,support,task:resolveCourseTask(item),cloud,grade,journal:createCourseRequestJournal(scope),now:()=>at,newId:()=>`course-op-${++op}`,evaluationFingerprint};
  const port=await createCourseLearningSession(options);
  return {scope,session,repository,options,port};
}
async function saveModel(f,requestId){
  const current=f.session.snapshot(),record=await f.repository.read('first'),answer=current.submitted.answer;
  const diagnostic={schemaVersion:1,status:'correct',source:'model',feedback:'原答符合要点。',matchedPointIds:['key'],missedPointIds:[],errorPointIds:[],wrongOptionIds:[],missingOptionIds:[],pointEvidence:[{pointId:'key',sourceId:'section',sourceQuote:'最后放入的元素最先取出',answerQuote:answer,reason:'包含操作顺序。'}]};
  const trace={modelId:'synthetic',promptVersion:'course-task-json-v1',ruleVersion:'course-diagnostic-v1',requestId};
  const evaluation=attemptEvaluationForDiagnostic(diagnostic,current.binding.contentHash);
  return (await f.repository.mutate({schemaVersion:1,kind:'diagnose',attemptId:'first',binding:current.binding,operationId:`diagnose-${requestId}`,expectedRevision:record.revision,updatedAt:at,answerRevision:current.submitted.answerRevision,diagnostic,trace,diagnosticHash:await courseDiagnosticHash(diagnostic,trace),attemptEvaluationHash:await evaluationFingerprint(evaluation)})).evidence;
}
test('course session does not expose diagnosis until both stores match and restores without another model call',async()=>{
  let calls=0,f;f=await setup({grade:async(_request,id)=>{calls++;return saveModel(f,id);}});
  assert.equal(f.port.evidence().diagnostic,null);await f.session.submit('刚放进去的那个会先拿出来','unknown');
  const result=await f.port.evaluate();assert.equal(result.diagnostic.status,'correct');assert.equal(f.session.snapshot().evaluation.source,'model');assert.equal(f.session.snapshot().formal,null);
  const restored=await createCourseLearningSession(f.options);assert.equal(restored.evidence().diagnosticHash,result.diagnosticHash);assert.equal(restored.originalAnswer(),'刚放进去的那个会先拿出来');
  await restored.evaluate();assert.equal(calls,1);
});
test('stopped evaluation does not apply a result arriving after cancellation',async()=>{
  let release,markEntered,f;const gate=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>markEntered=resolve);
  f=await setup({grade:async(_request,id)=>{markEntered();await gate;return saveModel(f,id);}});await f.session.submit('刚放进去的那个会先拿出来','unknown');
  const abort=new AbortController(),work=f.port.evaluate(abort.signal);await entered;abort.abort();release();
  await assert.rejects(work,/cancelled/);assert.equal(f.session.snapshot().evaluation.status,'pending');assert.equal(f.session.snapshot().formal,null);
});
test('unavailable grading saves unknown, never self-assesses, and explicit retry keeps original submission',async()=>{
  const f=await setup();await f.session.submit('ORIGINAL','unknown');const result=await f.port.evaluate();
  assert.equal(result.diagnostic.status,'undetermined');assert.equal(result.diagnostic.source,'none');assert.equal(f.session.snapshot().evaluation.status,'pending');assert.equal(f.session.snapshot().submitted.answer,'ORIGINAL');assert.equal(f.session.snapshot().formal,null);
});
test('account read outage preserves locally bound task and permits original answer persistence',async()=>{
  const f=await setup({cloud:{read:async()=>{throw Error('offline');},mutate:async()=>{throw Error('offline');}}});
  await f.session.submit('kept locally','unknown');assert.equal(f.port.originalAnswer(),'kept locally');assert.equal((await f.repository.read('first')).taskHash,await courseTaskHash(f.options.task));
});
test('request journal is scoped, atomic and preserves an identity across receipt loss',async()=>{
  const first=createCourseRequestJournal({userId:'journal-a',libraryId:'library'}),other=createCourseRequestJournal({userId:'journal-b',libraryId:'library'});
  const ids=await Promise.all([first.request('same',()=> 'request-a'),first.request('same',()=> 'request-b')]);assert.equal(ids[0],ids[1]);
  assert.equal(await other.request('same',()=> 'request-other'),'request-other');await first.complete('same','wrong');assert.equal(await first.request('same',()=> 'new'),ids[0]);
  await first.complete('same',ids[0]);assert.equal(await first.request('same',()=> 'fresh'),'fresh');
});
test('course formal delivery waits for acknowledged original evaluation and claim',async()=>{
  const f=await setup(),cloud={read:async()=>null,mutate:async()=>{throw Error('not-used');}};
  let confirmed=false;
  const guarded=await createCourseLearningSession({...f.options,cloud,confirmCloudClaim:async()=>confirmed});
  await assert.rejects(guarded.beforeFormal(),/尚未同步/);
  assert.equal(f.session.snapshot().formal,null);
  confirmed=true;await guarded.beforeFormal();
});
