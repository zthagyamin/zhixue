import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createSourceAdmissionClient,sourceAdmissionFingerprint as hash} from '../src/infrastructure/source-admission/index.ts';
import {createSourceLearningSession} from '../src/application/source-admission/index.ts';
const f=JSON.parse(readFileSync(new URL('./fixtures/source-code-report-python-v1.json',import.meta.url),'utf8'));
const clone=value=>structuredClone(value);
function attempt(){const s=f.submission;return {attemptId:s.attemptId,binding:{ownerId:'local-owner',libraryId:s.binding.libraryId,
 itemKey:s.binding.itemKey,contentHash:s.binding.contentHash,snapshotId:'local',groupId:'group',roundId:'round'},parentAttemptId:null,
 submitted:{answer:s.answer,answerRevision:s.answerRevision,submittedAt:s.submittedAt,assistance:s.assistance},
 checkpoint:{purpose:s.purpose},evaluation:{status:'pending'},formal:null};}
function fixture(options={}){
 const calls=[],capture={...clone(f.capture),status:'confirmed',sourceBinding:clone(f.submission.binding),item:clone(f.query.presentation),eventKind:'python'};
 delete capture.reason;let read=clone(f.readReceipt),live=true,loseHint=false,status='ready',nonce=0;
 const transport=createSourceAdmissionClient({baseUrl:'http://127.0.0.1:8765',sessionToken:'A'.repeat(43),libraryId:f.submission.binding.libraryId,
  remoteOwnerId:f.submission.binding.ownerId,capabilities:['nonword-source-v1','nonword-source-code-hint-v1'],fetcher:async(url,init)=>{
   const body=JSON.parse(init.body);calls.push({url,...body});const request=body.request;
   if(options.onCall)await options.onCall(body);
   if(body.action==='capture')return Response.json(capture);
   if(body.action==='read')return read?Response.json(read):Response.json({error:'source-admission-submission-required'},{status:409});
   if(body.action==='submit'){read=clone(f.readReceipt);return Response.json(read.receipt);}
   if(body.action==='code-report')return Response.json(f.codeReportReceipt);
   if(body.action==='confirm'){read.sourceBinding=clone(capture.sourceBinding);
    if(options.clearEvaluationOnConfirm){read.evaluation=null;read.activeRequestId=null;}
    return Response.json({schemaVersion:1,status:'confirmed',durable:true,
    attemptId:request.attemptId,binding:read.binding,sourceBinding:read.sourceBinding,sourceCaptureId:capture.captureId});}
   if(body.action==='code-hint'){
    if(loseHint){loseHint=false;throw Error('receipt lost after dispatch');}
    const core={schemaVersion:1,durable:true,...request,binding:read.binding,sourceBinding:read.sourceBinding,
     answerRevision:read.submission.answerRevision,answerHash:await hash(read.submission.answer),status,
     ...(status==='ready'?{hint:{text:'Inspect the return value.',sourceQuote:'Implement add.',codeQuote:'return 4',reason:'The public check needs addition.'}}:{reason:'hint-review-receipt-unknown'})};
    return Response.json({...core,receiptHash:await hash(core)});
   }
   if(options.allowFormal&&body.action==='evaluate'){
    const core={schemaVersion:1,durable:true,...request,binding:read.binding,sourceBinding:read.sourceBinding,
     sourceCaptureId:read.sourceBinding.captureId,answerRevision:read.submission.answerRevision,answerHash:await hash(read.submission.answer),
     status:'resolved',correct:false,outcome:'incorrect',explanation:'A constant fails the supplied addition example.'};
    read.evaluation={...core,evaluationHash:await hash(core)};read.activeRequestId=request.requestId;
    return Response.json(read.evaluation);
   }
   if(options.allowFormal&&body.action==='claim'){
    const e=read.evaluation,claim={schemaVersion:1,attemptId:request.attemptId,eventId:request.eventId,binding:read.binding,
     sourceBinding:read.sourceBinding,sourceCaptureId:read.sourceBinding.captureId,evaluationHash:e.evaluationHash,
     answerRevision:e.answerRevision,answerHash:e.answerHash,rating:request.rating,correct:false,occurredAt:read.submission.submittedAt,eventKind:'python'};
    return Response.json({schemaVersion:1,status:'accepted',durable:true,claim,claimHash:await hash(claim)});
   }
   assert.fail('Hint cannot evaluate, claim, self-assess or use direct AI: '+body.action);
  }});
 const session=createSourceLearningSession({query:f.query,libraryId:f.submission.binding.libraryId,transport,fingerprint:options.fingerprint??hash,
  newId:()=>String(++nonce),readCodeReports:async()=>[clone(f.codeReportRequest.report)],current:()=>live});
 return {session,calls,capture,transport,get read(){return read;},set read(value){read=value;},close:()=>{live=false;},lose:()=>{loseHint=true;},pending:()=>{status='pending';}};
}
test('hint durably syncs original code and reports, confirms source, and reads latest evidence without mutating learner result',async()=>{
 const x=fixture(),saved=attempt(),before=clone(saved);x.read=null;
 const receipt=await x.session.requestHint(saved,clone(f.codeReportRequest.report));
 assert.equal(receipt.status,'ready');assert.deepEqual(saved,before);
 const hint=x.calls.find(row=>row.action==='code-hint');
 assert.deepEqual(hint.request,{attemptId:saved.attemptId,requestId:'source-hint:'+await hash([f.submission,f.submission.binding,f.codeReportReceipt.reportId,'1']),reportId:f.codeReportReceipt.reportId});
 assert.ok(x.calls.some(row=>row.action==='submit'));assert.ok(x.calls.some(row=>row.action==='confirm'));
 assert.ok(x.calls.some(row=>row.action==='code-report'));assert.equal(x.calls.some(row=>['evaluate','claim','self-assess'].includes(row.action)),false);
});
test('lost hint receipt explicit retry keeps durable original/report scope with fresh request across refreshed session',async()=>{
 const x=fixture();x.lose();await assert.rejects(x.session.requestHint(attempt(),f.codeReportRequest.report),/receipt-unavailable/);
 const refreshed=createSourceLearningSession({query:f.query,libraryId:f.submission.binding.libraryId,transport:x.transport,
  fingerprint:hash,newId:()=> 'after-refresh',readCodeReports:async()=>[f.codeReportRequest.report]});
 assert.equal((await refreshed.requestHint(attempt(),f.codeReportRequest.report)).status,'ready');
 const requests=x.calls.filter(row=>row.action==='code-hint').map(row=>row.request);
 assert.notEqual(requests[0].requestId,requests[1].requestId);
 assert.equal(requests[0].attemptId,requests[1].attemptId);assert.equal(requests[0].reportId,requests[1].reportId);
 assert.equal(x.calls.every(row=>row.url==='http://127.0.0.1:8765/v1/nonword/source'),true);
});
test('missing/changed report, foreign answer, unconfirmed source and unsupported hint never dispatch code-hint',async()=>{
 const rows=[x=>{x.read.codeReports=[];},x=>{x.capture.status='pending';x.capture.reason='source-unverified';delete x.capture.sourceBinding;delete x.capture.item;delete x.capture.eventKind;},
  x=>{x.read.submission.answer='other';}];
 for(const change of rows){const x=fixture();change(x);await assert.rejects(x.session.requestHint(attempt(),f.codeReportRequest.report));
  assert.equal(x.calls.some(row=>row.action==='code-hint'),false);}
 const x=fixture(),wrong=clone(f.codeReportRequest.report);wrong.runId++;
 await assert.rejects(x.session.requestHint(attempt(),wrong),/report|binding/);assert.equal(x.calls.some(row=>row.action==='code-hint'),false);
 const unsupported=createSourceLearningSession({query:f.query,libraryId:f.submission.binding.libraryId,transport:{supported:()=>true},fingerprint:hash,newId:()=>assert.fail()});
 await assert.rejects(unsupported.requestHint(attempt(),f.codeReportRequest.report),/unsupported/);
 const recall=createSourceLearningSession({query:{...f.query,presentation:{questionType:'recall'}},libraryId:f.submission.binding.libraryId,fingerprint:hash,newId:()=>''});
 assert.equal(recall.requestHint,undefined);
});
test('pending review exposes safe retry reason and a page retired during syncing cannot dispatch hint',async()=>{
 const x=fixture();x.pending();await assert.rejects(x.session.requestHint(attempt(),f.codeReportRequest.report),/hint-review-receipt-unknown/);
 let stopped;const stale=fixture({onCall:async row=>{if(row.action==='code-report')stopped.close();}});stopped=stale;
 await assert.rejects(stale.session.requestHint(attempt(),f.codeReportRequest.report),/stale/);
 assert.equal(stale.calls.some(row=>row.action==='code-hint'),false);
});
test('a temporary hint preserves the previously verified formal cache and does not ask for another grade',async()=>{
 const x=fixture({allowFormal:true}),saved=attempt();
 const result=await x.session.assess(saved);assert.equal(result.status,'confirmed');
 saved.evaluation={status:'resolved',outcome:result.outcome.status,feedback:result.outcome.explanation};
 saved.formal={eventId:'event-original',rating:result.outcome.rating};
 const before=clone(saved);await x.session.requestHint(saved,f.codeReportRequest.report);assert.deepEqual(saved,before);
 await x.session.beforeFormal(saved);
 assert.equal(x.calls.filter(row=>row.action==='evaluate').length,1);
 assert.equal(x.calls.filter(row=>row.action==='claim').length,1);
});
test('hint captures report bytes at invocation and checks the live page after request fingerprinting',async()=>{
 const report=clone(f.codeReportRequest.report),x=fixture({onCall:async row=>{if(row.action==='code-report')report.runId++;}});
 assert.equal((await x.session.requestHint(attempt(),report)).status,'ready');
 let stale;const fingerprint=async value=>{const result=await hash(value);if(Array.isArray(value))stale.close();return result;};
 stale=fixture({fingerprint});await assert.rejects(stale.session.requestHint(attempt(),f.codeReportRequest.report),/stale/);
 assert.equal(stale.calls.some(row=>row.action==='code-hint'),false);
});
test('changed confirmed capture invalidates stale formal cache without grading during hint delivery',async()=>{
 const x=fixture({allowFormal:true,clearEvaluationOnConfirm:true}),saved=attempt();
 const result=await x.session.assess(saved);
 saved.evaluation={status:'resolved',outcome:result.outcome.status,feedback:result.outcome.explanation};
 saved.formal={eventId:'event-original',rating:result.outcome.rating};
 const captureId='source-capture:'+'c'.repeat(64);
 x.capture.captureId=captureId;
 for(const field of ['binding','originalBinding','sourceBinding'])x.capture[field].captureId=captureId;
 assert.equal((await x.session.requestHint(saved,f.codeReportRequest.report)).status,'ready');
 assert.equal(x.calls.filter(row=>row.action==='evaluate').length,1,'Hint must not replace the formal evaluation.');
 await x.session.beforeFormal(saved);
 assert.equal(x.calls.filter(row=>row.action==='evaluate').length,2,'The formal path must rebuild its changed source evidence safely.');
 assert.equal(x.calls.filter(row=>row.action==='claim').length,1);
});
