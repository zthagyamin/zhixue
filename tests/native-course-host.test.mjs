import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {indexedDB,IDBDatabase} from 'fake-indexeddb';
import {nativeCourseTask,attachNativeCourseDriver} from '../src/infrastructure/course-study/native-host-runtime.ts';
import {createNonWordRuntime} from '../src/infrastructure/nonword-study/index.ts';
import {createLocalCourseEvidenceRepository} from '../src/infrastructure/course-study/evidence-local.ts';
import {createCourseRequestJournal} from '../src/infrastructure/course-study/request-journal.ts';
import {evaluationFingerprint} from '../src/infrastructure/learning-attempt/index.ts';
import {studyHash} from '../src/domain/sync/index.ts';
import {canonicalAttemptJson} from '../src/domain/learning-attempt/index.ts';
import {courseTaskHash,resolveCourseTask,resolveCourseSupportV2,chooseCourseRemediation,courseDiagnosticHash,attemptEvaluationForDiagnostic,deterministicCourseDiagnostic} from '../src/domain/course-study/index.ts';

globalThis.indexedDB=indexedDB;
const fixtures=JSON.parse(readFileSync(new URL('./fixtures/course-task-support-v2.json',import.meta.url)));
let serial=0;
async function fixture(mode='recall'){
  const support=structuredClone(fixtures.cases.find(row=>row.valid&&row.mode===mode).support);
  const item={schemaVersion:2,kind:'practice',eventKind:'due',itemKey:'practice:native-question',contentHash:'b'.repeat(64),learningSupport:support,
    practice:{questionType:mode,prompt:support.task.prompt,domain:'course'}};
  const identity={schemaVersion:1,libraryId:`local-vault:${'a'.repeat(64)}`,itemKey:item.itemKey,contentHash:item.contentHash,localBindingHash:'c'.repeat(64)};
  const body={schemaVersion:1,identity,item,taskHash:await courseTaskHash(resolveCourseTask(item))};
  const capture={...body,captureId:await studyHash(body)};
  const scope={workspaceId:'workspace',ownerId:`host-owner-${serial++}`,libraryId:identity.libraryId,snapshotId:'local',itemKey:item.itemKey,
    contentHash:item.contentHash,groupId:'native-group',roundId:'native-round',cloud:false,nativeCourseIdentity:identity,nativeCoursePresentation:item};
  return {support,item,identity,capture,scope};
}
async function receipt(request,capture,status='correct'){
  const task=resolveCourseTask(capture.item,request.taskId),self=request.action==='self-assess';
  const diagnostic=self?{schemaVersion:1,status:request.selfStatus,source:'self-assess',feedback:'SERVER canonical explicit self assessment.',matchedPointIds:[],missedPointIds:[],errorPointIds:[],wrongOptionIds:[],missingOptionIds:[],pointEvidence:[]}:task.mode==='quiz'?deterministicCourseDiagnostic(task,request.submission.answer):
    {schemaVersion:1,status,source:'model',feedback:'Authenticated synthetic comparison.',matchedPointIds:status==='correct'?task.criteria.map(p=>p.id):[],missedPointIds:[],
      errorPointIds:status==='incorrect'?task.criteria.map(p=>p.id):[],wrongOptionIds:[],missingOptionIds:[],pointEvidence:task.criteria.map(p=>({pointId:p.id,sourceId:p.sourceIds[0],
        sourceQuote:task.sources.find(s=>s.sourceId===p.sourceIds[0]).excerpt,answerQuote:request.submission.answer,reason:'Synthetic quoted evidence.'}))};
  const trace=self||task.mode==='quiz'?null:{provider:'synthetic',modelId:'fixture',promptVersion:'v1',ruleVersion:'v1',requestId:request.requestId};
  const evaluation=attemptEvaluationForDiagnostic(diagnostic,request.binding.contentHash);
  const {action,submission,selfStatus,...echo}=request;assert.ok(action&&submission);void selfStatus;
  const body={...echo,durable:true,originRequestId:request.requestId,answerRevision:request.submission.answerRevision,diagnostic,trace,
    diagnosticHash:await courseDiagnosticHash(diagnostic,trace),attemptEvaluationHash:evaluation.status==='resolved'?await evaluationFingerprint(evaluation):null,
    remediationTaskId:chooseCourseRemediation(resolveCourseSupportV2(capture.item),diagnostic)?.taskId??null};
  return {...body,receiptHash:await studyHash(body)};
}
function transportFor(f,{status='correct',lose=false,gate}={}){
  const requests=[],claims=[],ledger=new Map();let models=0,captures=0;
  return {requests,claims,ledger,get models(){return models;},get captures(){return captures;},supported:()=>true,
    capture:async identity=>{assert.deepEqual(identity,f.identity);captures++;return f.capture;},read:async()=>f.capture,
    grade:async request=>{
      requests.push(structuredClone(request));assert.equal('reference' in request,false);
      if(gate)await gate;
      const key=canonicalAttemptJson([request.binding.ownerId,request.identity.libraryId,request.requestId]);
      if(!ledger.has(key)){models++;ledger.set(key,await receipt(request,f.capture,status));}
      if(lose){lose=false;throw Error('lost HTTP receipt');}
      return ledger.get(key);
    },claim:async request=>{claims.push(structuredClone(request));return {schemaVersion:1,durable:true,status:'accepted',eventId:request.eventId,claimHash:await studyHash(request)};}};
}
async function attach(f,transport,purpose='first',parentId,taskId){
  const prepared=await nativeCourseTask(f.scope,purpose,parentId,taskId,transport);
  assert.ok(prepared);
  const runtime=await createNonWordRuntime(f.scope,prepared.task.mode,{purpose,parentAttemptId:parentId});
  const driver=await attachNativeCourseDriver({runtime,restore:()=>({}),answer:()=>'',fields:()=>({}),phase:()=> 'answering'},runtime,prepared,transport);
  const repository=createLocalCourseEvidenceRepository({userId:f.scope.ownerId,libraryId:f.scope.libraryId},{cloud:false,
    readAttempt:id=>runtime.repository.read(id),readItem:async()=>prepared.item,readNativeCapture:(binding,id)=>prepared.cache.read(binding,id)});
  return {prepared,runtime,driver,repository};
}

test('course driver checkpoints use the real V1 answer field for recall and stable choice IDs',async()=>{
  for(const mode of ['recall','quiz']){
    const f=await fixture(mode),h=await attach(f,transportFor(f)),d=h.driver;
    const values=mode==='recall'?{answer:'This is the saved original.'}:{courseSelection:[f.support.correctOptionIds[0]]};
    const answer=d.answer(values);
    await d.runtime.session.save(answer,d.fields(values),d.phase());
    assert.equal(d.runtime.session.snapshot().answer,answer);
    assert.equal(d.runtime.session.snapshot().checkpoint.pluginFields.answer,answer);
  }
});
test('authenticated capture binds the actual hashed V1 runtime and restores without another model or portable reference',async()=>{
  const f=await fixture(),transport=transportFor(f),h=await attach(f,transport),saved=h.runtime.session.snapshot();
  assert.notEqual(saved.binding.groupId,f.scope.groupId);
  assert.notEqual(await studyHash(f.item),f.item.contentHash);
  assert.equal(await h.runtime.repository.reference(saved.attemptId),null);
  assert.deepEqual(await h.prepared.cache.read(saved.binding,saved.attemptId),f.capture);
  await h.runtime.session.submit('最后放入的元素最先取出。','unknown');
  const evidence=await h.driver.course.evaluate();
  assert.equal(evidence.diagnostic.source,'model');assert.equal(h.runtime.session.snapshot().evaluation.referenceHash,f.item.contentHash);
  assert.equal((await h.repository.pending()).length,0);
  const restored=await attach(f,transport);assert.equal(restored.driver.phase(),'feedback');
  assert.equal(restored.driver.course.evidence().diagnosticHash,evidence.diagnosticHash);
  await restored.driver.course.evaluate();assert.equal(transport.models,1);assert.equal(transport.captures,1);
});
test('old Companion presentation still saves original answer, pending continuation and no fabricated course evidence',async()=>{
  const f=await fixture(),transport={supported:()=>false},h=await attach(f,transport);
  assert.equal(h.prepared.capture,null);assert.equal(h.driver.course.selfAssess,undefined);
  await h.runtime.session.submit('original answer','unknown');
  await assert.rejects(h.driver.course.evaluate(),/unsupported/);
  await h.runtime.session.pending('no-reference','原答案保留，等待支持来源捕获。');await h.runtime.session.traversePending();
  assert.equal(h.runtime.session.snapshot().submitted.answer,'original answer');assert.equal(h.runtime.session.snapshot().checkpoint.traversed,true);
  assert.equal(h.runtime.session.snapshot().evaluation.status,'pending');assert.equal(h.driver.course.evidence(),null);
  await assert.rejects(h.driver.course.beforeFormal(),/capture-required/);
  assert.equal(await h.repository.read(h.runtime.session.snapshot().attemptId),null);
  const outage={supported:()=>true,capture:async()=>{throw Error('offline');}};
  assert.equal((await nativeCourseTask(f.scope,'first',undefined,undefined,outage)).capture,null);
  assert.equal(await nativeCourseTask({...f.scope,nativeCoursePresentation:{...f.item,learningSupport:{}}},'first',undefined,undefined,transport),null);
});
test('lost transport receipt and local transaction failure reuse server request and preserve raw answer on restart',async()=>{
  const f=await fixture(),transport=transportFor(f,{lose:true}),h=await attach(f,transport);
  await h.runtime.session.submit('last in first out','unknown');
  await assert.rejects(h.driver.course.evaluate(),/receipt-unknown/);
  const restarted=await attach(f,transport);
  const transaction=IDBDatabase.prototype.transaction;let abortNext=true;
  IDBDatabase.prototype.transaction=function(...args){
    const tx=transaction.apply(this,args);
    if(this.name==='zhixue-course-evidence-v1'&&args[1]==='readwrite'&&abortNext){abortNext=false;queueMicrotask(()=>tx.abort());}
    return tx;
  };
  try{await assert.rejects(restarted.driver.course.evaluate(),/receipt-unknown/);}finally{IDBDatabase.prototype.transaction=transaction;}
  await restarted.driver.course.evaluate();assert.equal(transport.models,1);
  assert.ok(transport.requests.every(r=>r.requestId===transport.requests[0].requestId));
  assert.equal(restarted.runtime.session.snapshot().submitted.answer,'last in first out');
  assert.equal(restarted.runtime.session.snapshot().formal,null);
});
test('explicit self assessment persists the server canonical feedback and separates self request identity',async()=>{
  const f=await fixture(),transport=transportFor(f,{lose:true}),grade=transport.grade;
  transport.grade=async request=>{
    if(request.action==='evaluate'){transport.requests.push(structuredClone(request));throw Error('AI unavailable before evaluation');}
    return grade(request);
  };
  const h=await attach(f,transport);
  await h.runtime.session.submit('forgotten','unknown');await assert.rejects(h.driver.course.evaluate());
  const modelId=transport.requests[0].requestId;
  await assert.rejects(h.driver.course.selfAssess('incorrect'),/lost HTTP receipt/);
  const evidence=await h.driver.course.selfAssess('incorrect');
  assert.equal(evidence.diagnostic.feedback,'SERVER canonical explicit self assessment.');
  assert.equal(h.runtime.session.snapshot().evaluation.feedback,evidence.diagnostic.feedback);
  assert.equal(h.runtime.session.snapshot().evaluation.source,'self-assess');
  assert.notEqual(transport.requests.at(-1).requestId,modelId);assert.equal(transport.requests.at(-1).selfStatus,'incorrect');
  assert.equal(transport.requests[1].requestId,transport.requests[2].requestId);assert.equal(transport.models,1);
});
test('quiz driver saves and restores exact option IDs using the captured quiz task',async()=>{
  const f=await fixture('quiz'),transport=transportFor(f),h=await attach(f,transport);
  const values={courseSelection:f.support.correctOptionIds,answer:'unrelated display text'};
  const raw=h.driver.answer(values);assert.equal(raw,JSON.stringify(f.support.correctOptionIds));
  assert.deepEqual(h.driver.fields(values),{answer:raw});
  await h.runtime.session.submit(raw,'unknown');await h.driver.course.evaluate();
  const restored=await attach(f,transport);
  assert.deepEqual(restored.driver.restore(),{answer:'',courseSelection:f.support.correctOptionIds});
  assert.equal(transport.requests[0].submission.answer,raw);assert.equal(transport.models,1);
});
test('formal claim requires both resolved original stores and the fixed V1 reserved event',async()=>{
  const f=await fixture(),transport=transportFor(f),h=await attach(f,transport);
  await h.runtime.session.submit('last in first out','unknown');
  await assert.rejects(h.driver.course.beforeFormal(),/evidence-required/);assert.equal(transport.claims.length,0);
  await h.driver.course.evaluate();await assert.rejects(h.driver.course.beforeFormal(),/evidence-required/);
  const reserved=await h.runtime.session.reserve('good');await h.driver.course.beforeFormal();
  assert.equal(transport.claims[0].eventId,reserved.eventId);assert.equal(transport.claims[0].occurredAt,reserved.reviewedAt);
  assert.equal(h.runtime.session.snapshot().formal.status,'claimed');
  assert.equal(transport.claims[0].diagnosticHash,h.driver.course.evidence().diagnosticHash);
});
test('authored child uses captured parent reference and cannot upgrade the original wrong result or make a formal claim',async()=>{
  const f=await fixture(),wrong=transportFor(f,{status:'incorrect'}),h=await attach(f,wrong);
  await h.runtime.session.submit('先放入的元素最先取出。','unknown');const original=await h.driver.course.evaluate(),parent=h.runtime.session.snapshot();
  const drift=structuredClone(f.item);drift.learningSupport.criteria[0].text='new reference';
  const correct=transportFor(f),child=await attach({...f,scope:{...f.scope,nativeCoursePresentation:drift}},correct,'remediation',parent.attemptId);
  assert.equal(child.prepared.parentEvidenceHash,original.diagnosticHash);assert.notEqual(child.prepared.task.taskId,h.prepared.task.taskId);
  assert.deepEqual(child.prepared.item,f.item);
  await child.runtime.session.submit('最后放入的元素最先取出。','unknown');await child.driver.course.evaluate();
  assert.equal(correct.requests[0].parentDiagnosticHash,original.diagnosticHash);
  assert.equal((await h.runtime.repository.read(parent.attemptId)).evaluation.outcome,'incorrect');
  await assert.rejects(child.driver.course.beforeFormal(),/evidence-required/);assert.equal(correct.claims.length,0);
  await assert.rejects(nativeCourseTask(f.scope,'remediation',parent.attemptId,h.prepared.task.taskId,correct),/remediation-binding/);
  await assert.rejects(nativeCourseTask({...f.scope,contentHash:'d'.repeat(64),nativeCourseIdentity:{...f.identity,contentHash:'d'.repeat(64)}},'remediation',parent.attemptId,undefined,correct),/parent-source/);
});
test('owner, library and source changes cannot borrow another captured reference',async()=>{
  const f=await fixture(),transport=transportFor(f);await attach(f,transport);
  const otherOwner={...f.scope,ownerId:'another-owner'},unavailable={supported:()=>false};
  assert.equal((await nativeCourseTask(otherOwner,'first',undefined,undefined,unavailable)).capture,null);
  const libraryId=`local-vault:${'d'.repeat(64)}`;
  assert.equal((await nativeCourseTask({...f.scope,libraryId,nativeCourseIdentity:{...f.identity,libraryId}},'first',undefined,undefined,unavailable)).capture,null);
  assert.equal((await nativeCourseTask({...f.scope,contentHash:'e'.repeat(64),nativeCourseIdentity:{...f.identity,contentHash:'e'.repeat(64)},nativeCoursePresentation:{...f.item,contentHash:'e'.repeat(64)}},'first',undefined,undefined,unavailable)).capture,null);
  await assert.rejects(nativeCourseTask({...f.scope,nativeCourseCapture:{...f.capture,identity:{...f.identity,localBindingHash:'e'.repeat(64)}}},'first'),/integrity/);
});
test('cancelled late authenticated result cannot persist a local diagnosis, apply V1 feedback or clear recovery request',async()=>{
  const f=await fixture();let release;const gate=new Promise(resolve=>release=resolve),transport=transportFor(f,{gate}),h=await attach(f,transport);
  await h.runtime.session.submit('last in first out','unknown');const abort=new AbortController(),work=h.driver.course.evaluate(abort.signal);
  while(!transport.requests.length)await new Promise(resolve=>setTimeout(resolve,1));
  abort.abort();release();await assert.rejects(work,/cancelled/);
  const record=await h.repository.read(h.runtime.session.snapshot().attemptId);assert.equal(record.diagnostic,null);
  assert.equal(h.runtime.session.snapshot().evaluation.status,'pending');assert.equal(h.runtime.session.snapshot().formal,null);
  await h.driver.course.evaluate();assert.equal(transport.models,1);assert.equal(transport.requests[1].requestId,transport.requests[0].requestId);
  const saved=h.runtime.session.snapshot(),key=canonicalAttemptJson([canonicalAttemptJson(['native-course-v1',f.identity,f.capture.captureId,null]),'evaluate',saved.binding,saved.attemptId,saved.submitted.answerRevision,f.capture.taskHash]);
  const journal=createCourseRequestJournal({userId:f.scope.ownerId,libraryId:f.scope.libraryId});
  assert.equal(await journal.request(key,()=> 'fresh-after-apply'),'fresh-after-apply');
});
test('cancelled self assessment ignores a signal-blind late reply and retains the same self request on retry',async()=>{
  const f=await fixture();let release;const gate=new Promise(resolve=>release=resolve),transport=transportFor(f,{gate}),h=await attach(f,transport);
  await h.runtime.session.submit('forgotten','unknown');
  const abort=new AbortController(),work=h.driver.course.selfAssess('incorrect',abort.signal);
  while(!transport.requests.length)await new Promise(resolve=>setTimeout(resolve,1));
  abort.abort();release();await assert.rejects(work,/cancelled/);
  const record=await h.repository.read(h.runtime.session.snapshot().attemptId);assert.equal(record.diagnostic,null);
  assert.equal(h.runtime.session.snapshot().evaluation.status,'pending');assert.equal(h.runtime.session.snapshot().formal,null);
  const evidence=await h.driver.course.selfAssess('incorrect');
  assert.equal(evidence.diagnostic.feedback,'SERVER canonical explicit self assessment.');
  assert.equal(transport.models,1);assert.equal(transport.requests[1].requestId,transport.requests[0].requestId);
});
