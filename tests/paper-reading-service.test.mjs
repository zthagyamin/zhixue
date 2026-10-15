import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createPaperReadingService} from '../src/application/paper-reading/service.ts';
import {createPaperReadingStore} from '../app/paper-reading/store.ts';
import {paperReadingTask} from '../src/domain/paper-reading/evidence.ts';
import {deferred} from './helpers/causal-harness.mjs';
const scope={ownerId:'account:u',libraryId:'account:l'};
const unit={schemaVersion:1,unitId:'unit',title:'Paper',goal:'Explain mechanism',source:{...scope,materialFingerprint:'a'.repeat(64),sourceVersion:'b'.repeat(64),sectionId:'s',paragraphs:[{id:'p',rawEn:'ReLU avoids saturation for positive inputs.',pageNumber:1}]}};
const task=()=>paperReadingTask({taskId:'task',revision:1,source:unit.source,goal:unit.goal,origin:'ai',ability:'mechanism',question:'Why does ReLU avoid saturation on positive inputs?',reference:[{point:'Avoid saturation.',paragraphId:'p',quote:'avoids saturation'}]});
function fixture(ai){globalThis.indexedDB=new IDBFactory();const store=createPaperReadingStore(),service=createPaperReadingService({scope,store,ai});return {store,service};}
test('opening a unit never invokes AI; explicit begin prepares once and restores after refresh',async()=>{
 let calls=0;const f=fixture({prepare:async()=>{calls++;return task();}});await f.service.open(unit);assert.equal(calls,0);
 await f.service.begin('unit','prepare1',new AbortController().signal);assert.equal(calls,1);
 const refreshed=createPaperReadingService({scope,store:f.store,ai:{prepare:async()=>{calls++;return task();}}});
 assert.equal((await refreshed.begin('unit','prepare2',new AbortController().signal)).task.question,task().question);assert.equal(calls,1);
});
test('valid prepared questions precede AI and wrong source never becomes an answerable task',async()=>{
 let calls=0;const f=fixture({prepare:async()=>{calls++;return task();}});await f.service.open(unit);
 await f.service.begin('unit','prepare',new AbortController().signal,{...task(),origin:'prepared'});assert.equal(calls,0);
 const foreign={...task(),source:{...unit.source,sourceVersion:'c'.repeat(64)}};
 const g=fixture({prepare:async()=>foreign});await g.service.open(unit);await assert.rejects(g.service.begin('unit','p',new AbortController().signal),/binding/);
 assert.equal((await g.store.read(scope,'unit')).task,null);
});
test('grading reads saved answer and reference; unavailable AI retains a recoverable pending first answer',async()=>{
 let captured;const f=fixture({prepare:async()=>task(),evaluate:async(saved,answer)=>{captured={saved,answer};throw Error('offline');}});
 await f.service.open(unit);let state=await f.service.begin('unit','p',new AbortController().signal);
 state=await f.service.mutate({schemaVersion:1,operationId:'s',unitId:'unit',expectedRevision:state.revision,kind:'submit',answer:'I forgot',submittedAt:'2026-10-08T08:00:00Z',referenceSeen:false});
 const pending=await f.service.evaluate('unit',state.activeAttemptId,'evaluate',new AbortController().signal);
 assert.equal(captured.answer,'I forgot');assert.deepEqual(captured.saved.reference,task().reference);
 assert.equal(pending.attempts[0].evaluation.status,'pending');assert.equal(pending.attempts[0].submission.answer,'I forgot');
});
test('cancelled late model response cannot install a task',async()=>{
 const reply=deferred(),f=fixture({prepare:()=>reply.promise});await f.service.open(unit);
 const controller=new AbortController(),pending=f.service.begin('unit','p',controller.signal);
 controller.abort();reply.resolve(task());await assert.rejects(pending,/cancel|abort/i);
 assert.equal((await f.store.read(scope,'unit')).task,null);
});
test('saving failure blocks progression and no AI request is made',async()=>{
 let calls=0;const service=createPaperReadingService({scope,store:{read:async()=>null,mutate:async()=>{throw Error('quota');}},ai:{prepare:async()=>{calls++;return task();}}});
 await assert.rejects(service.open(unit),/quota/);assert.equal(calls,0);
});
