import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createPaperReadingSession} from '../src/application/paper-reading/session.ts';
import {createPaperReadingStore} from '../app/paper-reading/store.ts';
import {paperReadingTask} from '../src/domain/paper-reading/evidence.ts';
import {deferred,tick} from './helpers/causal-harness.mjs';
const scope={ownerId:'account:u',libraryId:'local:l'};
const unit={schemaVersion:1,unitId:'unit',title:'Paper',goal:'Explain mechanism',source:{...scope,materialFingerprint:'a'.repeat(64),sourceVersion:'b'.repeat(64),sectionId:'s',paragraphs:[{id:'p',rawEn:'ReLU avoids saturation for positive inputs.'}]}};
const task=()=>paperReadingTask({taskId:'task',revision:1,source:unit.source,goal:unit.goal,origin:'prepared',ability:'mechanism',question:'Why does ReLU help on positive inputs?',reference:[{point:'Avoid saturation.',paragraphId:'p',quote:'avoids saturation'}]});
function fixture(){globalThis.indexedDB=new IDBFactory();let serial=0;const store=createPaperReadingStore(),make=()=>createPaperReadingSession({unit,store,makeId:()=>`op${++serial}`,now:()=>new Date('2026-10-08T09:00:00Z')});return {store,make};}
test('local drafts save before continuation and refresh restores the same question and original answer',async()=>{
 const f=fixture(),session=f.make();await session.load();assert.equal(session.snapshot().workspace.task,null);
 await session.begin(task());await session.answer('I forgot');await session.submit();await session.flush();
 session.dispose();const restored=f.make();await restored.load();assert.equal(restored.snapshot().workspace.answer,'I forgot');
 assert.equal(restored.snapshot().workspace.attempts[0].submission.answer,'I forgot');
 assert.equal(restored.snapshot().workspace.attempts[0].evaluation.status,'pending');assert.equal(restored.snapshot().cloud,'device-only');
});
test('inline retry hides the reference and preserves the first failure evidence',async()=>{
 const f=fixture(),session=f.make();await session.load();await session.begin(task());await session.answer('I forgot');await session.submit();
 const first=session.snapshot().workspace.attempts[0];await session.reveal();await session.retry();
 const next=session.snapshot().workspace;assert.equal(next.referenceSeen,false);assert.equal(next.answer,'');
 assert.deepEqual(next.attempts[0],first);assert.equal(next.attempts[1].purpose,'remediation');
});
test('failed persistence retains typed input and blocks flush until the same save can be retried',async()=>{
 const f=fixture();let fail=true;const store={...f.store,mutate:async(...args)=>{if(fail&&args[1].kind==='draft')throw Error('quota');return f.store.mutate(...args);}};
 const session=createPaperReadingSession({unit,store,makeId:()=>crypto.randomUUID(),now:()=>new Date('2026-10-08T09:00:00Z')});await session.load();await session.begin(task());
 await assert.rejects(session.answer('keep this'),/quota/);assert.equal(session.snapshot().input,'keep this');await assert.rejects(session.flush(),/quota/);
 fail=false;await session.answer('keep this');await session.flush();assert.equal(session.snapshot().workspace.answer,'keep this');
});
test('a later queued successful draft clears the earlier failed save without clearing an unsaved latest input',async()=>{
 const f=fixture(),gate=deferred();const store={...f.store,mutate:async(...args)=>{if(args[1].kind==='draft'&&args[1].answer==='A'){await gate.promise;throw Error('quota');}return f.store.mutate(...args);}};
 const session=createPaperReadingSession({unit,store,makeId:()=>crypto.randomUUID(),now:()=>new Date('2026-10-08T09:00:00Z')});await session.load();await session.begin(task());
 const first=session.answer('A');const rejection=assert.rejects(first,/quota/);await tick();const latest=session.answer('AB');gate.resolve();await rejection;await latest;
 assert.equal((await f.store.read(scope,'unit')).answer,'AB');assert.equal(session.snapshot().error,'');await session.flush();
});
test('saving pause or reference metadata cannot clear a failed unsaved answer',async()=>{
 const f=fixture();const store={...f.store,mutate:async(...args)=>{if(args[1].kind==='draft')throw Error('quota');return f.store.mutate(...args);}};
 const session=createPaperReadingSession({unit,store,makeId:()=>crypto.randomUUID(),now:()=>new Date('2026-10-08T09:00:00Z')});await session.load();await session.begin(task());
 await assert.rejects(session.answer('unsaved answer'),/quota/);await session.pause(true,10);
 assert.equal((await f.store.read(scope,'unit')).answer,'');assert.equal(session.snapshot().input,'unsaved answer');assert.equal(session.snapshot().error,'quota');await assert.rejects(session.flush(),/quota/);
 await session.reveal();assert.equal(session.snapshot().error,'quota');await assert.rejects(session.flush(),/quota/);
});

test('bootstrap read failure does not trap navigation or replace stored evidence; explicit load can recover',async()=>{
 const f=fixture();let unavailable=true;
 const store={...f.store,read:async(...args)=>{if(unavailable)throw Error('paper-reading-load-unavailable');return f.store.read(...args);}};
 const session=createPaperReadingSession({unit,store,makeId:()=>crypto.randomUUID(),now:()=>new Date('2026-10-08T09:00:00Z')});
 await session.load();assert.equal(session.snapshot().workspace,null);assert.equal(session.snapshot().error,'');
 assert.match(session.snapshot().notice,/load-unavailable/);await session.flush();
 unavailable=false;await session.load();assert.ok(session.snapshot().workspace);assert.equal(session.snapshot().notice,'');
});

test('a valid 200-character legacy unit remains openable and its request identity is bounded and repeatable',async()=>{
 const f=fixture(),longUnit={...unit,unitId:'old/'.repeat(50)};
 const requests=[];const ai={prepare:async(_u,id)=>{requests.push(id);return task();},evaluate:async()=>({status:'pending',reason:'offline'})};
 const session=createPaperReadingSession({unit:longUnit,store:f.store,localAi:ai,makeId:()=>crypto.randomUUID(),now:()=>new Date('2026-10-08T09:00:00Z')});
 await session.load();assert.ok(session.snapshot().workspace);await session.begin();assert.equal(session.snapshot().workspace.task.question,task().question);
 assert.equal(requests.length,1);assert.ok(requests[0].length<=200);await session.begin();assert.equal(requests.length,1);assert.equal(session.snapshot().workspace.unit.unitId,longUnit.unitId);
});
