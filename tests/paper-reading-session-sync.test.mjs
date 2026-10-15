import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createPaperReadingSession,createPaperReadingService} from '../src/application/paper-reading/index.ts';
import {createPaperReadingLocalStore,createPaperReadingIndexedDbPort} from '../src/infrastructure/paper-reading/index.ts';
import {paperReadingTask} from '../src/domain/paper-reading/evidence.ts';
import {tick,waitForObservation,deferred} from './helpers/causal-harness.mjs';
const scope={ownerId:'account:u',libraryId:'account:l'};
const unit={schemaVersion:1,unitId:'unit',title:'Paper',goal:'Explain mechanism',source:{...scope,materialFingerprint:'a'.repeat(64),sourceVersion:'b'.repeat(64),sectionId:'s',paragraphs:[{id:'p',rawEn:'ReLU avoids saturation for positive inputs.'}]}};
function store(){
 const factory=new IDBFactory();globalThis.indexedDB??=factory;
 const open=()=>new Promise((resolve,reject)=>{const request=factory.open('reader',1);request.onupgradeneeded=()=>request.result.createObjectStore('workspace-records',{keyPath:'id'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 return createPaperReadingLocalStore(createPaperReadingIndexedDbPort(open));
}
function fixture({holdEvaluation,loseEvaluationReceipt=false}={}){
 const cloud=store();let serial=0,preparations=0,evaluations=0;
 const cached=new Map(),requestIds=[];
 const ai={prepare:async()=>{preparations++;return paperReadingTask({taskId:'task',revision:1,source:unit.source,goal:unit.goal,origin:'ai',ability:'mechanism',question:'Why does ReLU help on positive inputs?',reference:[{point:'Avoid saturation.',paragraphId:'p',quote:'avoids saturation'}]});},
  evaluate:async(_task,_answer,id)=>{requestIds.push(id);if(cached.has(id))return cached.get(id);evaluations++;if(holdEvaluation)await holdEvaluation.promise;
   const result={status:'resolved',outcome:'incorrect',matched:[],issues:['No mechanism supplied.'],explanation:'Explain saturation.'};cached.set(id,result);
   if(loseEvaluationReceipt)throw Error('paper-ai-receipt-unknown');return result;}};
 const service=createPaperReadingService({scope,store:cloud,ai});
 function client(local=store()){
  let online=true;const ensure=()=>{if(!online)throw Error('offline');};
  const remote={read:async id=>{ensure();return cloud.read(scope,id);},mutate:async mutation=>{ensure();return cloud.mutate(scope,mutation);},
   begin:async(...args)=>{ensure();return service.begin(...args);},evaluate:async(...args)=>{ensure();return service.evaluate(...args);}};
  const session=createPaperReadingSession({unit,store:local,remote,makeId:()=>`op-${++serial}`,now:()=>new Date('2026-10-08T09:00:00Z')});
  return {session,local,setOnline:value=>{online=value;}};
 }
 return {client,cloud,requestIds,counts:()=>({preparations,evaluations})};
}
test('offline submission remains pending across refresh then synchronizes and resumes the same attempt',async()=>{
 const f=fixture(),first=f.client();await first.session.load();await first.session.synchronize();await first.session.begin();
 assert.equal(f.counts().preparations,1);first.setOnline(false);await first.session.answer('offline original');await first.session.submit();
 await waitForObservation(tick,()=>!first.session.snapshot().busy);await first.session.flush();assert.equal(first.session.snapshot().workspace.attempts[0].evaluation.status,'pending');
 first.session.dispose();const restored=f.client(first.local);restored.setOnline(false);await restored.session.load();
 assert.equal(restored.session.snapshot().input,'offline original');assert.equal(restored.session.snapshot().workspace.attempts[0].submission.answer,'offline original');
 restored.setOnline(true);await restored.session.synchronize();assert.equal(restored.session.snapshot().cloud,'acked');
 await restored.session.evaluate();assert.equal(restored.session.snapshot().workspace.attempts[0].evaluation.outcome,'incorrect');
 assert.equal(f.counts().preparations,1);assert.equal(f.counts().evaluations,1);
 restored.session.dispose();
});
test('a competing account first answer never overwrites the offline original',async()=>{
 const f=fixture(),a=f.client(),b=f.client();await a.session.load();await a.session.synchronize();await a.session.begin();
 await b.session.load();await b.session.synchronize();a.setOnline(false);
 await a.session.answer('original A');await a.session.submit();await waitForObservation(tick,()=>!a.session.snapshot().busy);
 await b.session.answer('original B');await b.session.submit();await waitForObservation(tick,()=>!b.session.snapshot().busy);
 a.setOnline(true);await a.session.synchronize();
 assert.equal(a.session.snapshot().cloud,'conflict');assert.equal(a.session.snapshot().workspace.attempts[0].submission.answer,'original A');
 assert.equal((await f.cloud.read(scope,'unit')).attempts[0].submission.answer,'original B');a.session.dispose();b.session.dispose();
});
test('reference and retry cannot fork an in-flight account model result while reliable continuation remains available',async()=>{
 const gate=deferred(),f=fixture({holdEvaluation:gate}),a=f.client();await a.session.load();await a.session.synchronize();await a.session.begin();
 await a.session.answer('saved original');await a.session.submit();await waitForObservation(tick,()=>f.counts().evaluations===1);
 await assert.rejects(a.session.reveal(),/model-busy/);await assert.rejects(a.session.retry(),/model-busy/);await a.session.flush();
 gate.resolve();await waitForObservation(tick,()=>!a.session.snapshot().busy);
 assert.equal(a.session.snapshot().cloud,'acked');assert.equal(a.session.snapshot().workspace.attempts[0].evaluation.status,'resolved');a.session.dispose();
});
test('unrelated reference revisions cannot change the recovery model request identity',async()=>{
 const f=fixture({loseEvaluationReceipt:true}),a=f.client();await a.session.load();await a.session.synchronize();await a.session.begin();
 await a.session.answer('saved original');await a.session.submit();await waitForObservation(tick,()=>!a.session.snapshot().busy);
 assert.equal(a.session.snapshot().workspace.attempts[0].evaluation.status,'pending');await a.session.reveal();await a.session.evaluate();
 assert.equal(f.counts().evaluations,1);assert.equal(f.requestIds.length,2);assert.equal(f.requestIds[0],f.requestIds[1]);
 assert.equal(a.session.snapshot().workspace.attempts[0].evaluation.status,'resolved');a.session.dispose();
});
