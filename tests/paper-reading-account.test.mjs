import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createAccountStudyApplication} from '../src/application/account-study/index.ts';
import {createPaperReadingStore} from '../app/paper-reading/store.ts';
import {deferred,tick,waitForObservation} from './helpers/causal-harness.mjs';
const auth={principal:{kind:'browser',userId:'u'}},scope={ownerId:'account:u',libraryId:'account:l'};
const unit={schemaVersion:1,unitId:'unit',title:'Paper',goal:'Explain mechanism',source:{...scope,materialFingerprint:'a'.repeat(64),sourceVersion:'b'.repeat(64),sectionId:'s',paragraphs:[{id:'p',rawEn:'ReLU avoids saturation for positive inputs.'}]}};
const candidate={status:'ready',ability:'mechanism',question:'Why does ReLU help on positive inputs?',reference:[{point:'Avoid saturation.',paragraphId:'p',quote:'avoids saturation'}],quality:{sourceSufficient:true,taskSpecific:true,referenceConsistent:true,missingVisuals:false}};
function fixture({loseEvaluationReceipt=false,holdEvaluation}={}){
 globalThis.indexedDB=new IDBFactory();const store=createPaperReadingStore(),requests=[],receipts=new Map();
 const settings={enabled:true,configured:true,model:'fixture',provider:'deepseek',baseUrl:'https://fixture.invalid/v1',maxOutputTokens:2400,revision:1};let lost=false;
 const app=createAccountStudyApplication({getAccessStore:async()=>({profile:async()=>({libraryId:'l',revision:1})}),getPaperReadingStore:async()=>store,now:()=>new Date('2026-10-08T08:00:00Z'),
  getAiStore:async()=>({getSettings:async()=>settings,begin:async(_scope,input)=>{
   const existing=receipts.get(input.requestId);if(existing)return existing;receipts.set(input.requestId,{status:'pending',settings});return {status:'accepted',settings};},
   complete:async(_scope,id,_hash,result)=>{receipts.set(id,{status:'completed',result,settings});if(loseEvaluationReceipt&&!lost&&result.kind==='evaluate'){lost=true;throw Error('lost acknowledgement');}},fail:async()=>{}}),
  getPaperReadingProvider:async()=>({run:async(kind,input,trace)=>{requests.push({kind,input});if(kind==='evaluate'&&holdEvaluation)await holdEvaluation.promise;return {trace,output:kind==='prepare'?candidate:
    {status:'resolved',outcome:'incorrect',matches:[],issues:[{pointIndex:0,sourceQuote:'avoids saturation',kind:'missing',reason:'No mechanism supplied.'}],explanation:'Explain how positive inputs avoid saturation.'}};}}),
 });
 const post=(body,principal=auth)=>app.post(structuredClone(body),principal,new AbortController().signal);
 const register=()=>post({action:'mutate-paper-reading',mutation:{schemaVersion:1,operationId:'register',unitId:'unit',expectedRevision:0,kind:'register',unit}});
 return {post,register,store,requests};
}
test('actual account dispatcher authenticates owner/library and rejects client grading flags',async()=>{
 const f=fixture();await f.register();
 await assert.rejects(f.post({action:'read-paper-reading',unitId:'unit',libraryId:'other'}),/library-mismatch/);
 await assert.rejects(f.post({action:'read-paper-reading',unitId:'unit'},{principal:{kind:'device',userId:'u',libraryId:'l',state:'active'}}),/action-not-allowed/);
 await assert.rejects(f.post({action:'read-paper-reading',unitId:'unit',expectedUserId:'other'}),/account-mismatch/);
 await assert.rejects(f.post({action:'prepare-paper-reading',unitId:'unit',requestId:'p',rating:'good'}),/invalid-paper-reading-fields/);
});
test('account preparation is explicit, cached, source-bound and produces no formal event',async()=>{
 const f=fixture();await f.register();await f.post({action:'read-paper-reading',unitId:'unit'});assert.equal(f.requests.length,0);
 const response=await f.post({action:'prepare-paper-reading',unitId:'unit',requestId:'p'});assert.equal(response.value.workspace.task.status,'ready');
 await f.post({action:'prepare-paper-reading',unitId:'unit',requestId:'p2'});assert.equal(f.requests.length,1);
 assert.equal('formal' in response.value.workspace,false);assert.equal('rating' in response.value.workspace,false);
 await assert.rejects(f.post({action:'mutate-paper-reading',mutation:{schemaVersion:1,operationId:'forged',unitId:'unit',expectedRevision:2,kind:'task',task:response.value.workspace.task}}),/paper-reading-service-only/);
});
test('account evaluation reads persisted answer and reference, not a submitted reference override',async()=>{
 const f=fixture();await f.register();let response=await f.post({action:'prepare-paper-reading',unitId:'unit',requestId:'p'});
 let state=response.value.workspace;
 response=await f.post({action:'mutate-paper-reading',mutation:{schemaVersion:1,operationId:'s',unitId:'unit',expectedRevision:state.revision,kind:'submit',answer:'I forgot',referenceSeen:false,submittedAt:'2026-10-08T08:00:00Z'}});
 state=response.value.workspace;
 await assert.rejects(f.post({action:'evaluate-paper-reading',unitId:'unit',attemptId:state.activeAttemptId,requestId:'e',reference:'forged'}),/invalid-paper-reading-fields/);
 const result=await f.post({action:'evaluate-paper-reading',unitId:'unit',attemptId:state.activeAttemptId,requestId:'e'});
 assert.equal(f.requests[1].input.answer,'I forgot');assert.deepEqual(f.requests[1].input.task.reference,candidate.reference);
 assert.equal(result.value.workspace.attempts[0].evaluation.outcome,'incorrect');
 assert.equal(result.value.workspace.attempts[0].submission.answer,'I forgot');
});

test('lost AI completion receipt leaves the saved answer pending and same request restores without a second model call',async()=>{
 const f=fixture({loseEvaluationReceipt:true});await f.register();const ready=await f.post({action:'prepare-paper-reading',unitId:'unit',requestId:'p'});
 const submitted=await f.post({action:'mutate-paper-reading',mutation:{schemaVersion:1,operationId:'s',unitId:'unit',expectedRevision:ready.value.workspace.revision,kind:'submit',answer:'I forgot',referenceSeen:false,submittedAt:'2026-10-08T08:00:00Z'}});
 const state=submitted.value.workspace,request={action:'evaluate-paper-reading',unitId:'unit',attemptId:state.activeAttemptId,requestId:'e'};
 await assert.rejects(f.post(request),/paper-ai-receipt-unknown/);
 const pending=await f.store.read(scope,'unit');assert.equal(pending.attempts[0].evaluation.status,'pending');
 assert.equal(pending.operations.some(op=>op.operationId==='e'),false);
 const recovered=await f.post(request);assert.equal(recovered.value.workspace.attempts[0].evaluation.outcome,'incorrect');
 assert.equal(f.requests.length,2);assert.equal(recovered.value.workspace.attempts[0].submission.answer,'I forgot');
});
test('account source registration rejects array digests before any durable write',async()=>{
 for(const field of ['sourceVersion','materialFingerprint']){
  const f=fixture(),malformed={...unit,source:{...unit.source,[field]:[unit.source[field]]}};
  await assert.rejects(f.post({action:'mutate-paper-reading',mutation:{schemaVersion:1,operationId:'bad',unitId:'unit',expectedRevision:0,kind:'register',unit:malformed}}),/binding|invalid/);
  assert.equal(await f.store.read(scope,'unit'),null);
 }
});
test('a duplicate request waiting on a model reservation cannot occupy the original feedback operation',async()=>{
 const gate=deferred(),f=fixture({holdEvaluation:gate});await f.register();
 const ready=await f.post({action:'prepare-paper-reading',unitId:'unit',requestId:'p'});
 const submitted=await f.post({action:'mutate-paper-reading',mutation:{schemaVersion:1,operationId:'s',unitId:'unit',expectedRevision:ready.value.workspace.revision,kind:'submit',answer:'I forgot',referenceSeen:false,submittedAt:'2026-10-08T08:00:00Z'}});
 const request={action:'evaluate-paper-reading',unitId:'unit',attemptId:submitted.value.workspace.activeAttemptId,requestId:'e'};
 const original=f.post(request);await waitForObservation(tick,()=>f.requests.some(r=>r.kind==='evaluate'));
 await assert.rejects(f.post(request),/paper-ai-request-pending/);
 assert.equal((await f.store.read(scope,'unit')).operations.some(op=>op.operationId==='e'),false);
 gate.resolve();const result=await original;assert.equal(result.value.workspace.attempts[0].evaluation.outcome,'incorrect');
 assert.equal((await f.post(request)).value.workspace.attempts[0].evaluation.outcome,'incorrect');assert.equal(f.requests.length,2);
});
