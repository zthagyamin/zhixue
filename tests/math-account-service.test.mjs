import test from 'node:test';
import assert from 'node:assert/strict';
import {accountFixture,auth} from './math-account-fixtures.mjs';
import {parseMathStudyResult} from '../src/application/math-study/index.ts';
test('account math reads saved answer and writes only source-bound optional diagnostics',async()=>{
 const f=accountFixture(),r=(await f.send(f.math)).value;
 assert.equal(r.final,undefined);assert.equal(r.step.status,'correct');assert.equal(r.evidence.calculation.diagnostic.source,'model');assert.equal(f.calls,1);assert.equal(f.a.evaluation.status,'pending');assert.equal(f.a.formal,null);
 const repeat=(await f.send(f.math)).value;assert.equal(repeat.step.status,'correct');assert.equal(f.calls,1);assert.equal(f.writes,1);assert.equal(parseMathStudyResult(r,f.math.request).step.status,'correct');
});
test('strict payload and authenticated scope reject client answer/reference/device changes',async()=>{
 const f=accountFixture();for(const changed of [{...f.math,answer:'3'},{...f.math,request:{...f.math.request,expected:'3'}},{...f.math,expectedUserId:'foreign'},{...f.math,libraryId:'foreign'}])await assert.rejects(f.send(changed));
 await assert.rejects(f.app.post(structuredClone(f.math),{principal:{kind:'device',userId:'owner',libraryId:'library',state:'active'}},new AbortController().signal),/action-not-allowed/);
 f.sourceAvailable=false;await assert.rejects(f.send(f.math),/source/);assert.equal(f.calls,0);assert.equal(f.a.submitted.answer,'3');
});
test('formal optional step recovery never writes a second final grade',async()=>{
 const f=accountFixture();f.a.formal={status:'linked'};await assert.rejects(f.send({...f.math,request:{...f.math.request,mode:'final'}}),/formal/);
 const r=(await f.send({...f.math,request:{...f.math.request,mode:'step'}})).value;assert.equal(r.final,undefined);assert.equal(r.step.status,'correct');assert.equal(f.a.formal.status,'linked');
});
test('semantic invalid evidence becomes pending and prepared model receipt survives sidecar loss',async()=>{
 const invalid=accountFixture();invalid.model=async(k,i,trace)=>({output:{diagnostic:{answerRevision:1,stepRevision:1,stepId:'source-step',sourceVersion:i.binding.contentHash,status:'correct',source:'model',explanation:'correct'},evidence:{sourceQuote:'invented',answerQuote:'invented',reason:'confident'}},trace});
 assert.equal((await invalid.send(invalid.math)).value.step.status,'undetermined');
 const f=accountFixture();f.receiptLoss=true;await assert.rejects(f.send(f.math));assert.equal(f.calls,1);assert.equal(f.writes,0);
 assert.equal((await f.send(f.math)).value.step.status,'correct');assert.equal(f.calls,1);assert.equal(f.writes,1);
});
test('late cancellation and changed frozen inputs reject without diagnostic writes',async()=>{
 const f=accountFixture(),controller=new AbortController();f.model=async(k,i,trace)=>{controller.abort();return {output:{},trace};};
 await assert.rejects(f.app.post(structuredClone(f.math),auth,controller.signal),/cancelled/);assert.equal(f.writes,0);
 const changed=accountFixture(),model=changed.model;changed.model=async(...args)=>{const out=await model(...args);changed.evidence.calculation.stepInput={text:'new',revision:2};return out;};
 await assert.rejects(changed.send(changed.math),/binding/);assert.equal(changed.writes,0);
});
test('mapping absent is explicitly unavailable and no caller mapping authority accepted',async()=>{
 const f=accountFixture();assert.deepEqual((await f.send({action:'math-variant',attemptId:'attempt',seed:8})).value,{status:'unavailable'});
 await assert.rejects(f.send({action:'math-variant',attemptId:'attempt',seed:8,mapping:{}}));
});

test('final grading never silently charges semantic AI and keeps step pending until explicit request',async()=>{
 const f=accountFixture();const r=(await f.send({...f.math,request:{...f.math.request,mode:'final'}})).value;
 assert.equal(r.final.status,'correct');assert.equal(r.step.status,'undetermined');assert.equal(f.calls,0);
 assert.equal((await f.send(f.math)).value.step.status,'correct');assert.equal(f.calls,1);
});

test('cached output trace and frozen source cannot be replaced on model retry',async()=>{
 const f=accountFixture();f.receiptLoss=true;await assert.rejects(f.send(f.math));
 [...f.cache.values()][0].result.trace.promptVersion='forged';await assert.rejects(f.send(f.math),/binding/);assert.equal(f.calls,1);assert.equal(f.writes,0);
 const changed=accountFixture();changed.receiptLoss=true;await assert.rejects(changed.send(changed.math));changed.item.learningSupport.step.reference='Changed immutable reference';
 await assert.rejects(changed.send(changed.math),/binding/);assert.equal(changed.calls,1);assert.equal(changed.writes,0);
});
test('unsupported final formats abstain and blank optional steps are omitted',async()=>{
 const f=accountFixture();f.a.submitted.answer='not a number';f.evidence.calculation.stepInput.text='';
 const r=(await f.send({...f.math,request:{...f.math.request,mode:'final'}})).value;assert.equal(r.final.status,'undetermined');assert.equal(r.step,undefined);assert.equal(f.calls,0);
 assert.equal((await f.send(f.math)).value.step,undefined);
});
test('semantic contradictions and budget unavailable retain pending without model-backed verdict',async()=>{
 const f=accountFixture(),model=f.model;f.model=async(...args)=>{const out=await model(...args);out.output.diagnostic.status='incorrect';return out;};
 assert.equal((await f.send(f.math)).value.step.status,'undetermined');
 const budget=accountFixture();const store=await budget.deps.getAiStore();store.begin=async()=>{throw Error('account-ai-token-limit');};budget.deps.getAiStore=async()=>store;
 assert.equal((await budget.send(budget.math)).value.step.status,'undetermined');assert.equal(budget.calls,0);
});

test('account variant response descriptor is built only from explicit approved mapping',async()=>{
 const f=accountFixture();f.item.learningSupport.variantMappingId='approved-linear';f.deps.getPracticeEvidenceMapping=async()=>({resolveMapping:async()=>({schemaVersion:1,mappingId:'approved-linear',parentItemKey:f.a.binding.itemKey,parentContentHash:f.a.binding.contentHash,hashKind:'content',templateVersion:1,templateId:'context-linear',sourceConditions:['constant rate'],parameters:{rate:3,baseline:5,target:20}})});
 const r=(await f.send({action:'math-variant',attemptId:'attempt',seed:8})).value;assert.equal(r.status,'available');assert.equal(r.descriptor.mappingId,'approved-linear');assert.equal(r.descriptor.variantHash,r.variant.variantHash);assert.deepEqual(r.descriptor.parameters,r.variant.parameters);assert.equal(f.calls,0);assert.equal(f.writes,0);
 f.evidence.variant=r.descriptor;f.a.submitted.answer=JSON.stringify({answerKind:'number',answer:'5'});f.evidence.calculation.stepInput.text='';
 await assert.rejects(f.send({...f.math,request:{...f.math.request,mode:'final'}}),/variant-parent/);
 f.a.parentAttemptId='parent';f.a.checkpoint.purpose='remediation';f.a.answer=f.a.submitted.answer;
 assert.equal((await f.send({...f.math,request:{...f.math.request,mode:'final'}})).value.final.status,'correct');
 f.evidence.variant.templateId='domain-division';await assert.rejects(f.send({...f.math,request:{...f.math.request,mode:'final'}}),/binding/);
});

test('legacy numeric final uses authoritative saved source without authored learning support',async()=>{
 const f=accountFixture();delete f.item.learningSupport;f.evidence=null;
 const r=(await f.send({...f.math,request:{...f.math.request,mode:'final'}})).value;
 assert.equal(r.final.status,'correct');assert.equal(r.step,undefined);assert.equal(f.calls,0);assert.equal(f.writes,0);assert.equal(f.a.formal,null);assert.equal(f.a.evaluation.status,'pending');
});
test('legacy missing unsafe symbolic or explicitly invalid source cannot gain a final verdict',async()=>{
 for(const reference of [undefined,null,'','x+x','1+2','__import__("os")',Number.POSITIVE_INFINITY,'1e101']){
  const f=accountFixture();delete f.item.learningSupport;f.evidence=null;f.item.practice.answer=reference;
  await assert.rejects(f.send({...f.math,request:{...f.math.request,mode:'final'}}));assert.equal(f.calls,0);assert.equal(f.writes,0);assert.equal(f.a.submitted.answer,'3');assert.equal(f.a.formal,null);
 }
 for(const support of [null,{}, {schemaVersion:3,type:'calculation'}, {schemaVersion:1,type:'calculation',mode:'symbolic',variables:['xx'],domain:'real'}]){
  const f=accountFixture();f.item.learningSupport=support;f.evidence=null;
  await assert.rejects(f.send({...f.math,request:{...f.math.request,mode:'final'}}));assert.equal(f.a.formal,null);assert.equal(f.calls,0);assert.equal(f.writes,0);
 }
});
