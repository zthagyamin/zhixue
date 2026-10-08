import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB} from 'fake-indexeddb';
import {fixture} from './fixtures/native-math-fixtures.mjs';
import {nativeMathTask,attachNativeMathDriver} from '../src/infrastructure/math-study/native-host-runtime.ts';
import {createNativeMathClient} from '../src/infrastructure/math-study/native-client.ts';
import {createNonWordRuntime} from '../src/infrastructure/nonword-study/index.ts';
import {nativeMathClaimHash,resolveNativeMathSupport} from '../src/domain/math-study/index.ts';
import {studyHash} from '../src/domain/sync/index.ts';
import {nativeScopeReference} from '../src/infrastructure/course-study/native-scope.ts';

globalThis.indexedDB=indexedDB;
async function hostFixture({semantic=false,lose=false,gate,mutateResult}={}){
 const f=await fixture();
 if(semantic){f.support.step.mode='semantic';f.support.step.reference='Intermediate value equals two';f.item.learningSupport=f.support;
  const {captureId,...body}=f.capture;assert.ok(captureId);f.capture.captureId=await studyHash(body);}
 const scope={workspaceId:'workspace',ownerId:f.scope.userId,libraryId:f.scope.libraryId,snapshotId:'local',itemKey:f.identity.itemKey,contentHash:f.identity.contentHash,groupId:'group',roundId:'round',cloud:false,nativeMathIdentity:f.identity,nativeMathPresentation:f.item};
 const calls=[],claims=new Map(),results=new Map(),barriers=[];
 let wasLost=false;
 const client=createNativeMathClient({baseUrl:'http://127.0.0.1:5195',sessionToken:'test',capabilities:['native-math-v1'],fetcher:async(url,init)=>{
  const body=JSON.parse(init.body);calls.push({url,body});
  const reply=value=>({ok:true,status:200,json:async()=>value});
  if(url.endsWith('/source/capture')||url.endsWith('/source/read'))return reply({schemaVersion:1,durable:true,capture:f.capture});
  if(url.endsWith('/read')){
   const claim=claims.get(body.attemptId);if(!claim)return {ok:false,status:400,json:async()=>({error:'native-math-attempt-not-found'})};
   return reply({schemaVersion:1,durable:true,claim,results:[],formalBarrier:null});
  }
  if(url.endsWith('/claim')){
   if(body.action==='formal'){barriers.push(body);return reply({schemaVersion:1,durable:true,status:'barrier-saved',attemptId:body.attemptId,eventId:body.eventId,claimHash:await studyHash(body)});}
   const saved=await runtime.repository.read(body.attempt.attemptId);assert.deepEqual(saved.submitted,body.attempt.submitted,'raw browser submission exists before native claim');
   const details=driver.runtime.practice.snapshot();assert.deepEqual(body.stepInput?.text,details?.calculation?.stepInput.text);
   claims.set(body.attempt.attemptId,structuredClone(body));
   return reply({schemaVersion:1,durable:true,attemptId:body.attempt.attemptId,answerRevision:body.attempt.submitted.answerRevision,captureId:body.captureId,claimHash:await nativeMathClaimHash(body)});
  }
  if(url.endsWith('/evaluate')){
   const claim=claims.get(body.attemptId);assert.ok(claim);assert.equal('answer' in body,false);assert.equal('support' in body,false);
   if(gate)await gate();
   if(!results.has(body.requestId)){
    const receipt={schemaVersion:1,durable:true,requestId:body.requestId,attemptId:body.attemptId,answerRevision:body.answerRevision,sourceVersion:body.sourceVersion};
    if(body.mode==='final')receipt.final={status:'correct',source:'deterministic',explanation:'Final answer matches original reference.'};
    else receipt.step={answerRevision:body.answerRevision,stepRevision:claim.stepInput.revision,stepId:f.support.step.stepId,sourceVersion:body.sourceVersion,status:'correct',source:semantic?'model':'deterministic',explanation:'Saved step matches frozen source.'};
    if(mutateResult)mutateResult(receipt);
    results.set(body.requestId,{...receipt,receiptHash:await studyHash(receipt)});
   }
   if(lose&&!wasLost){wasLost=true;throw Error('receipt lost');}
   return reply(results.get(body.requestId));
  }throw Error('unexpected route');
 }});
 const prepared=await nativeMathTask(scope,'first',undefined,client);
 const runtime=await createNonWordRuntime(scope,'calculation',{verifyFormalEvent:async eventId=>({eventId,coreHash:'e'.repeat(64),itemKey:scope.itemKey,contentHash:scope.contentHash,snapshotId:'local',reviewedAt:runtime.session.snapshot().formal.occurredAt,rating:'good'})});
 const driver=await attachNativeMathDriver({runtime,restore:()=>({}),fields:()=>({}),answer:()=>'',phase:()=> 'answering'},runtime,prepared,client);
 return {...f,scope,client,prepared,runtime,driver,calls,claims,results,barriers};
}
test('host freezes actual submitted raw answer and optional step before final; explicit step persists exact model diagnostic',async()=>{
 const h=await hostFixture({semantic:true}),p=h.driver.runtime.practice;
 await h.runtime.session.save('4',{},'answering');await p.saveStep('Intermediate value equals two');await h.runtime.session.submit('4');
 const result=await p.calculation.evaluate('final');assert.equal(result.final.status,'correct');assert.equal(result.step,undefined);
 assert.equal(h.results.size,1);assert.equal(p.snapshot().calculation.diagnostic,undefined);
 const diagnostic=await p.calculation.evaluate('step');assert.equal(diagnostic.step.source,'model');
 assert.deepEqual(p.snapshot().calculation.diagnostic,diagnostic.step);
 const claim=await h.prepared.cache.readClaim(h.runtime.session.snapshot().attemptId);assert.equal(claim.attempt.submitted.answer,'4');assert.equal(claim.stepInput.text,'Intermediate value equals two');
});
test('receipt loss reuses exact logical request and frozen claim across browser host reload',async()=>{
 const h=await hostFixture({lose:true}),p=h.driver.runtime.practice;
 await h.runtime.session.save('4',{},'answering');await h.runtime.session.submit('4');await assert.rejects(p.calculation.evaluate('final'),/receipt lost/);
 const saved=h.runtime.session.snapshot(),runtime=await createNonWordRuntime(h.scope,'calculation',{existing:saved});
 const prepared=await nativeMathTask(h.scope,'first',undefined,h.client);
 const driver=await attachNativeMathDriver({runtime,restore:()=>({}),fields:()=>({}),answer:()=>'',phase:()=> 'answering'},runtime,prepared,h.client);
 assert.equal((await driver.runtime.practice.calculation.evaluate('final')).final.status,'correct');
 const requests=h.calls.filter(c=>c.url.endsWith('/evaluate'));assert.equal(requests.length,2);assert.equal(requests[0].body.requestId,requests[1].body.requestId);assert.equal(h.results.size,1);
});
test('source-derived numeric support stays narrow and current metadata cannot grade an uncaptured draft',async()=>{
 const f=await fixture(),{learningSupport,...numeric}=f.item;assert.ok(learningSupport);
 assert.equal(resolveNativeMathSupport(numeric).mode,'numeric');assert.equal(resolveNativeMathSupport({...numeric,practice:{...numeric.practice,answer:'x+1'}}),null);
 const scope={workspaceId:'workspace',ownerId:f.scope.userId,libraryId:f.scope.libraryId,snapshotId:'local',itemKey:f.identity.itemKey,contentHash:f.identity.contentHash,groupId:'group',roundId:'round',cloud:false,nativeMathIdentity:f.identity,nativeMathPresentation:numeric};
 const prepared=await nativeMathTask(scope,'first');assert.equal(prepared.capture,null);
 const runtime=await createNonWordRuntime(scope,'calculation'),driver=await attachNativeMathDriver({runtime,restore:()=>({}),fields:()=>({}),answer:()=>'',phase:()=> 'answering'},runtime,prepared);
 await runtime.session.save('raw draft',{},'answering');await runtime.session.submit('raw draft');await assert.rejects(driver.runtime.practice.calculation.evaluate('final'),/capture-required/);
 assert.equal((await runtime.repository.read(runtime.session.snapshot().attemptId)).submitted.answer,'raw draft');
 const metadata=nativeScopeReference(scope,{...numeric.practice,localBindingHash:f.identity.localBindingHash});assert.deepEqual(metadata.nativeMathIdentity,f.identity);
 assert.deepEqual(nativeScopeReference({...scope,cloud:true},{...numeric.practice,localBindingHash:f.identity.localBindingHash}),{});
 assert.deepEqual(nativeScopeReference(scope,{...numeric.practice,word:'word',localBindingHash:f.identity.localBindingHash}),{});
});
test('cancellation and changed steps reject late feedback without locally persisting diagnosis',async()=>{
 let entered,release;const ready=new Promise(resolve=>{entered=resolve;}),wait=new Promise(resolve=>{release=resolve;});
 const h=await hostFixture({gate:async()=>{entered();await wait;}}),p=h.driver.runtime.practice;
 await h.runtime.session.save('4',{},'answering');await p.saveStep('2');await h.runtime.session.submit('4');
 const controller=new AbortController(),work=p.calculation.evaluate('step',controller.signal);await ready;controller.abort();await assert.rejects(work,/cancelled/);release();
 assert.equal(p.snapshot().calculation.diagnostic,undefined);
 await assert.rejects(p.saveStep('3'),/practice-evidence-conflict/);
 assert.equal(p.snapshot().calculation.diagnostic,undefined);
 assert.equal((await p.calculation.evaluate('step')).step.status,'correct');assert.equal(h.results.size,1);
 const requests=h.calls.filter(c=>c.url.endsWith('/evaluate'));assert.equal(requests.length,2);assert.equal(requests[0].body.requestId,requests[1].body.requestId);
});
test('known linked formal identity sends only a barrier and explicit step remains recoverable',async()=>{
 const h=await hostFixture(),p=h.driver.runtime.practice;
 await h.runtime.session.save('4',{},'answering');await p.saveStep('2');await h.runtime.session.submit('4');await p.calculation.evaluate('final');
 await h.runtime.session.assess({status:'correct',source:'deterministic',explanation:'checked',rating:'good'});
 await h.runtime.session.reserve('good');await h.runtime.session.link('e'.repeat(64));await h.driver.runtime.afterWrite();
 assert.equal(h.barriers.length,1);assert.equal(h.barriers[0].eventId,h.runtime.session.snapshot().formal.eventId);
 await assert.rejects(p.calculation.evaluate('final'),/formal-existing-result/);
 assert.equal((await p.calculation.evaluate('step')).step.status,'correct');
 assert.equal(h.calls.some(c=>c.url.includes('/events')),false);
});
test('wrong returned step ID is rejected before controlled diagnostic persistence',async()=>{
 const h=await hostFixture({mutateResult:r=>{if(r.step)r.step.stepId='different';}}),p=h.driver.runtime.practice;
 await h.runtime.session.save('4',{},'answering');await p.saveStep('2');await h.runtime.session.submit('4');
 await assert.rejects(p.calculation.evaluate('step'),/step-binding/);assert.equal(p.snapshot().calculation.diagnostic,undefined);
});
test('historical child preparation keeps original association and rejects foreign owner parents',async()=>{
 const h=await hostFixture();await h.runtime.session.submit('4');await h.driver.runtime.practice.calculation.evaluate('final');
 const parent=h.runtime.session.snapshot(),before=h.calls.filter(c=>c.url.endsWith('/source/capture')).length;
 const old=await nativeMathTask(h.scope,'remediation',parent.attemptId,h.client);
 assert.equal(old.capture.captureId,h.capture.captureId);assert.equal(h.calls.filter(c=>c.url.endsWith('/source/capture')).length,before);
 await assert.rejects(nativeMathTask({...h.scope,ownerId:'other-owner'},'remediation',parent.attemptId,h.client),/parent-binding/);
 const child=await createNonWordRuntime(h.scope,'calculation',{purpose:'remediation',parentAttemptId:parent.attemptId});
 const d=await attachNativeMathDriver({runtime:child,restore:()=>({}),fields:()=>({}),answer:()=>'',phase:()=> 'answering'},child,old,h.client);
 await child.session.submit('raw child');assert.equal((await old.cache.read(child.session.snapshot().binding,child.session.snapshot().attemptId)).captureId,h.capture.captureId);
 assert.equal(d.runtime.purpose,'remediation');
});
test('known durable unavailable step allows a fresh explicit retry while frozen input and resolved evidence stay fixed',async()=>{
 let ready=false;
 const h=await hostFixture({semantic:true,mutateResult:r=>{if(r.step&&!ready){r.step.status='undetermined';r.step.source='none';r.step.explanation='Provider unavailable, raw step retained.';r.capability={semanticStep:'pending',reason:'provider-unavailable'};}}}),p=h.driver.runtime.practice;
 await h.runtime.session.save('4',{},'answering');await p.saveStep('Intermediate value equals two');await h.runtime.session.submit('4');
 const pending=await p.calculation.evaluate('step');assert.equal(pending.step.status,'undetermined');assert.equal(h.results.size,1);
 const frozen=await h.prepared.cache.readClaim(h.runtime.session.snapshot().attemptId);
 ready=true;
 const runtime=await createNonWordRuntime(h.scope,'calculation',{existing:h.runtime.session.snapshot()}),prepared=await nativeMathTask(h.scope,'first',undefined,h.client);
 const driver=await attachNativeMathDriver({runtime,restore:()=>({}),fields:()=>({}),answer:()=>'',phase:()=> 'answering'},runtime,prepared,h.client),reloaded=driver.runtime.practice;
 const resolved=await reloaded.calculation.evaluate('step');assert.equal(resolved.step.status,'correct');assert.equal(resolved.step.source,'model');
 assert.equal(h.results.size,2);assert.deepEqual(await h.prepared.cache.readClaim(h.runtime.session.snapshot().attemptId),frozen);
 const requests=h.calls.filter(c=>c.url.endsWith('/evaluate'));assert.notEqual(requests[0].body.requestId,requests[1].body.requestId);
 const before=h.calls.length;assert.deepEqual((await reloaded.calculation.evaluate('step')).step,resolved.step);assert.equal(h.calls.length,before);
});
test('unknown lost semantic receipt retries exactly once without a new provider request',async()=>{
 const h=await hostFixture({semantic:true,lose:true}),p=h.driver.runtime.practice;
 await h.runtime.session.save('4',{},'answering');await p.saveStep('Intermediate value equals two');await h.runtime.session.submit('4');
 await assert.rejects(p.calculation.evaluate('step'),/receipt lost/);assert.equal(p.snapshot().calculation.diagnostic,undefined);
 const result=await p.calculation.evaluate('step');assert.equal(result.step.status,'correct');assert.equal(h.results.size,1);
 const requests=h.calls.filter(c=>c.url.endsWith('/evaluate'));assert.equal(requests.length,2);assert.equal(requests[0].body.requestId,requests[1].body.requestId);
});
