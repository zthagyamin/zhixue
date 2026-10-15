import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createSourceLearningSession} from '../src/application/source-admission/index.ts';
import {createSourceAdmissionClient,sourceAdmissionFingerprint} from '../src/infrastructure/source-admission/index.ts';
import {createCompanionPlanClient} from '../app/companion-plan-client.ts';

const f=JSON.parse(readFileSync(new URL('./fixtures/source-admission-python-v1.json',import.meta.url),'utf8'));
const clone=value=>structuredClone(value);
function attempt(){return {schemaVersion:1,attemptId:f.submission.attemptId,
  binding:{ownerId:'browser-namespace',libraryId:f.submission.binding.libraryId,itemKey:f.query.itemKey,
    contentHash:f.query.contentHash,snapshotId:'local',groupId:'group',roundId:'round'},
  parentAttemptId:null,revision:2,answerRevision:f.submission.answerRevision,answer:f.submission.answer,
  submitted:{answer:f.submission.answer,answerRevision:f.submission.answerRevision,submittedAt:f.submission.submittedAt,
    assistance:'independent',maxPreHintLevel:0,answerRevealed:false},
  checkpoint:{phase:'submitted',purpose:'first',position:0,traversed:false},evaluation:{status:'pending',reason:'not-requested'},
  formal:null,operations:[],updatedAt:f.submission.submittedAt};}
function fixture(){
  const calls=[],values={capture:clone(f.confirmedCapture),read:clone(f.readReceipt),
    submit:clone(f.submitReceipt),confirm:clone(f.confirmReceipt),claim:clone(f.claimReceipt)};
  let live=true,nonce=0;
  const client=createSourceAdmissionClient({baseUrl:'http://127.0.0.1:8765',sessionToken:'A'.repeat(43),
    libraryId:f.submission.binding.libraryId,capabilities:['nonword-source-v1'],fetcher:async(_,init)=>{
      const body=JSON.parse(init.body);calls.push(body);
      if(body.action==='read'&&values.read===null)return Response.json({error:'source-admission-submission-required'},{status:409});
      if(body.action==='evaluate'){
        const result=clone(f.evaluation);result.requestId=body.request.requestId;
        const {evaluationHash,...core}=result;void evaluationHash;
        result.evaluationHash=await sourceAdmissionFingerprint(core);return Response.json(result);
      }
      return Response.json(values[body.action]);
    }});
  const session=createSourceLearningSession({query:f.query,libraryId:f.submission.binding.libraryId,transport:client,
    fingerprint:sourceAdmissionFingerprint,newId:()=>String(++nonce),current:()=>live});
  return {session,client,calls,values,close:()=>{live=false;}};
}
test('paired source recovery preserves local namespace and obtains fresh source evidence before one claim',async()=>{
  const x=fixture(),saved=attempt(),before=clone(saved);
  const source=await x.session.assess(saved);
  assert.equal(source.status,'confirmed');assert.equal(source.outcome.status,'correct');
  assert.deepEqual(saved,before);assert.equal(saved.binding.ownerId,'browser-namespace');
  const evaluation=clone(f.evaluation);
  saved.evaluation={status:'resolved',outcome:source.outcome.status,feedback:source.outcome.explanation,
    source:source.outcome.source,rating:source.outcome.rating,correct:true,evaluationHash:'a'.repeat(64),referenceHash:f.query.contentHash};
  saved.formal={status:'claimed',eventId:'event-first',occurredAt:f.submission.submittedAt,rating:'good',evaluationHash:'a'.repeat(64),coreHash:null};
  await x.session.beforeFormal(saved);
  assert.equal(x.calls.filter(call=>call.action==='claim').length,1);
  assert.equal(x.calls.find(call=>call.action==='evaluate').request.requestId,evaluation.requestId);
  const refreshed=createSourceLearningSession({query:f.query,libraryId:f.submission.binding.libraryId,
    transport:x.client,fingerprint:sourceAdmissionFingerprint,newId:()=>assert.fail('Resolved evidence must reuse its request.')});
  await refreshed.beforeFormal(saved);
  assert.equal(x.calls.filter(call=>call.action==='claim').length,2,'Same immutable claim can be recovered after refreshing before official writing.');
  assert.deepEqual(saved.binding,before.binding);
});
test('unconfirmed source still saves the exact original remote answer and never evaluates or claims',async()=>{
  const x=fixture();x.values.capture=clone(f.pendingCapture);x.values.read=null;
  assert.equal((await x.session.assess(attempt())).status,'pending');
  const submitted=x.calls.find(call=>call.action==='submit').request;
  assert.deepEqual(submitted,f.submission);
  assert.equal(x.calls.some(call=>['evaluate','claim'].includes(call.action)),false);
});
test('changed local answer identity and stale page cannot obtain a source result',async()=>{
  const x=fixture(),wrong=attempt();wrong.binding.contentHash='c'.repeat(64);
  await assert.rejects(x.session.assess(wrong),/local-binding/);
  assert.equal(x.calls.length,0);x.close();
  await assert.rejects(x.session.assess(attempt()),/stale/);
});
test('restoring an in-flight evaluation reuses its request identity',async()=>{
  const x=fixture();x.values.read.evaluation=null;x.values.read.activeRequestId='existing-in-flight';
  await x.session.assess(attempt());
  assert.equal(x.calls.find(call=>call.action==='evaluate').request.requestId,'existing-in-flight');
});
test('a saved pending evaluation gets a new explicit retry identity',async()=>{
  const x=fixture();x.values.read.evaluation={...clone(f.evaluation),status:'pending',reason:'evaluation-unavailable'};
  delete x.values.read.evaluation.correct;delete x.values.read.evaluation.outcome;delete x.values.read.evaluation.explanation;
  const {evaluationHash,...core}=x.values.read.evaluation;void evaluationHash;
  x.values.read.evaluation.evaluationHash=await sourceAdmissionFingerprint(core);
  x.values.read.activeRequestId=x.values.read.evaluation.requestId;
  await x.session.assess(attempt());
  assert.notEqual(x.calls.find(call=>call.action==='evaluate').request.requestId,x.values.read.activeRequestId);
});

test('actual paired Companion factory stops source requests when its host binding is no longer current',async()=>{
  let current=true,calls=0,release;
  const waiting=new Promise(resolve=>{release=resolve;});
  const companion=createCompanionPlanClient({baseUrl:'http://127.0.0.1:8765',sessionToken:'A'.repeat(43),
    capabilities:['nonword-source-v1'],fetcher:async()=>{calls++;await waiting;return Response.json(f.confirmedCapture);}});
  const source=companion.sourceAdmission(f.submission.binding.libraryId,()=>current);
  const pending=source.capture(f.query);
  while(calls===0)await new Promise(resolve=>setImmediate(resolve));
  current=false;release();
  await assert.rejects(pending,/source-admission-stale/);
  await assert.rejects(source.capture(f.query),/source-admission-stale/);
  assert.equal(calls,1);
});

test('flashcard first self-assessment is persisted before any remote availability and survives later choices',async()=>{
  const saved=attempt();saved.submitted.answer=saved.answer='';
  const query={...clone(f.query),presentation:{questionType:'flashcard',front:'One concept?',back:'One reference.'}};
  let record=null;
  const selfAssessment={read:async()=>record,save:async(attempt,rating)=>{
    record??={schemaVersion:1,attemptId:attempt.attemptId,binding:clone(attempt.binding),
      answerRevision:attempt.submitted.answerRevision,submittedAt:attempt.submitted.submittedAt,rating};
    return clone(record);
  }};
  const options={query,libraryId:saved.binding.libraryId,selfAssessment,
    transport:{supported:()=>false},fingerprint:sourceAdmissionFingerprint,newId:()=>assert.fail('No remote evaluation without transport.')};
  const session=createSourceLearningSession(options);
  await session.assess(saved,{status:'partial',source:'self-assess',rating:'hard',explanation:'Explicit first choice.'});
  assert.equal(record?.rating,'hard','The original oral assessment must be durable even while Companion is unavailable.');
  await session.assess(saved,{status:'correct',source:'self-assess',rating:'easy',explanation:'Later view choice.'});
  assert.equal(record.rating,'hard');assert.equal(session.selfRating(),'hard');
  const restored=createSourceLearningSession(options);await restored.restoreSelf(saved);
  assert.equal(restored.selfRating(),'hard');await restored.beforeContinue(saved);
});

test('failed flashcard self-assessment persistence cannot permit pending continuation',async()=>{
  const saved=attempt(),query={...clone(f.query),presentation:{questionType:'flashcard',front:'One concept?',back:'Reference.'}};
  const session=createSourceLearningSession({query,libraryId:saved.binding.libraryId,
    selfAssessment:{read:async()=>null,save:async()=>{throw Error('self-assessment-save-failed');}},
    transport:{supported:()=>false},fingerprint:sourceAdmissionFingerprint,newId:()=>''});
  await assert.rejects(session.assess(saved,{status:'correct',source:'self-assess',rating:'good',explanation:'Declared.'}),/save-failed/);
  await assert.rejects(session.beforeContinue(saved),/自评|self-assessment/);
});
