import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures/native-math-fixtures.mjs';
import {readFileSync} from 'node:fs';
import {openD1} from './helpers/sqlite-d1.mjs';
import {D1PracticeEvidenceStore,createAccountPracticeEvidenceClient} from '../src/infrastructure/practice-evidence/index.ts';
import {D1LearningAttemptStore,createAccountAttemptClient} from '../src/infrastructure/learning-attempt/index.ts';
import {AccountStudyStore} from '../db/account-study-store.ts';
import {courseEvidenceOriginal} from '../src/application/course-study/index.ts';
import {sealStudyItem,sealStudySnapshot,parseStudyItem,parseStudySnapshot} from '../app/account-study-content.ts';
import {quizBody,snapshotBody} from './fixtures/account-study-fixtures.mjs';
import {accountFixture,auth} from './math-account-fixtures.mjs';
import {createAccountStudyApplication} from '../src/application/account-study/index.ts';
import {createPendingMathStepRuntime} from '../src/infrastructure/math-study/pending-step-runtime.ts';
import {studyHash} from '../src/domain/sync/index.ts';
import {nativeMathClaimHash} from '../src/domain/math-study/index.ts';
import {IDBFactory} from 'fake-indexeddb';
import {createLocalPracticeEvidenceRepository} from '../src/infrastructure/practice-evidence/local.ts';
import {createLocalAttemptRepository} from '../src/infrastructure/learning-attempt/index.ts';
globalThis.indexedDB=new IDBFactory();
async function setup(){
 const f=await fixture(),repo=createLocalAttemptRepository(f.scope);await repo.hydrate({...f.attempt,submitted:null});
 const evidence=createLocalPracticeEvidenceRepository({ownerId:f.scope.userId,libraryId:f.scope.libraryId},{readAttempt:id=>repo.read(id),resolveSource:async()=>({binding:f.binding,calculation:f.support})});
 await evidence.mutate({schemaVersion:1,attemptId:f.attempt.attemptId,binding:f.binding,operationId:'step',expectedRevision:0,updatedAt:f.attempt.updatedAt,kind:'step-input',text:'2'});
 const original={...f.attempt,revision:4,evaluation:{status:'resolved',rating:'good',correct:true,outcome:'correct',source:'deterministic',feedback:'correct',evaluationHash:'d'.repeat(64),referenceHash:f.binding.contentHash},formal:{status:'linked',rating:'good',eventId:'original-event',occurredAt:f.attempt.updatedAt,evaluationHash:'d'.repeat(64),coreHash:'e'.repeat(64),authoritativeRecord:null}};
 await repo.hydrate(original);await f.cache.save(f.capture);await f.cache.bindAttempt(original.attemptId,f.binding,f.capture.captureId);
 const options={workspaceId:'workspace',ownerId:f.scope.userId,libraryId:f.scope.libraryId,repository:repo,parseItem:async()=>{throw Error('not portable');},parseSnapshot:async()=>{throw Error('not portable');},nativeMathReference:row=>f.cache.read(row.binding,row.attemptId),evidence};
 return {...f,repo,evidence,original,options};
}
test('linked good original remains discoverable as pending step without read mutations',async()=>{
 const f=await setup(),before=await f.repo.read('original'),outbox=await f.evidence.pending();
 const runtime=createPendingMathStepRuntime(f.options),page=await runtime.list();assert.equal(page.complete,true);assert.equal(page.rows.length,1);assert.equal(page.rows[0].stepText,'2');assert.equal(page.rows[0].canEvaluate,true);
 assert.deepEqual(await f.repo.read('original'),before);assert.deepEqual(await f.evidence.pending(),outbox);
});
test('missing old source retains raw readonly step and blocks evaluation',async()=>{
 const f=await setup(),runtime=createPendingMathStepRuntime({...f.options,nativeMathReference:async()=>null});
 const page=await runtime.list();assert.equal(page.rows[0].stepText,'2');assert.equal(page.rows[0].canEvaluate,false);await assert.rejects(runtime.evaluate(page.rows[0]),/参考/);
});
test('bounded pagination finds old solved step and explicitly reports incomplete pages',async()=>{
 const f=await setup(),record=(await f.evidence.listSavedDrafts())[0];let pages=0;
 const cloud={list:async()=>[],read:async()=>f.original,referenceBundle:async()=>null};
 const runtime=createPendingMathStepRuntime({...f.options,cloud,evidenceCloud:{read:async()=>record,listPage:async()=>{pages++;return {records:[record],nextCursor:'original',complete:false};}},maxPages:1});
 const page=await runtime.list();assert.equal(pages,1);assert.equal(page.complete,false);assert.match(page.notice,/未完整/);assert.equal(page.rows.length,1);
});

function mockTransport(f,{gate,cancel,wrongRevision}={}){
 const calls=[],claims=new Map(),barriers=[];
 const transport={supported:()=>true,capture:async()=>f.capture,readSource:async()=>f.capture,
  claim:async claim=>{claims.set(claim.attempt.attemptId,structuredClone(claim));return {schemaVersion:1,durable:true,attemptId:claim.attempt.attemptId,answerRevision:claim.attempt.submitted.answerRevision,captureId:claim.captureId,claimHash:await nativeMathClaimHash(claim)};},
  recover:async()=>{throw Error('native-math-attempt-not-found');},
  formal:async body=>{barriers.push(body);return {schemaVersion:1,durable:true,status:'barrier-saved',attemptId:body.attemptId,eventId:body.eventId,claimHash:await studyHash(body)};},
  evaluate:async request=>{calls.push(request);if(gate)await gate();if(cancel)cancel();const receipt={schemaVersion:1,durable:true,...request};delete receipt.mode;delete receipt.stepRevision;
   receipt.step={answerRevision:request.answerRevision,stepRevision:wrongRevision?99:request.stepRevision,stepId:f.support.step.stepId,sourceVersion:request.sourceVersion,status:'correct',source:'deterministic',explanation:'Saved value equals the immutable original intermediate value.'};
   return {...receipt,receiptHash:await studyHash(receipt)};
  }};
 return {transport,calls,claims,barriers};
}
test('actual existing NativeMath driver resolves saved step without changing final/core or creating attempts',async()=>{
 const f=await setup(),m=mockTransport(f),runtime=createPendingMathStepRuntime({...f.options,nativeMath:m.transport});
 const row=(await runtime.list()).rows[0],before=await f.repo.read('original'),count=(await f.repo.list()).length;
 const diagnostic=await runtime.evaluate(row);assert.equal(diagnostic.status,'correct');assert.equal(m.calls.length,1);assert.equal(m.calls[0].mode,'step');
 assert.deepEqual(await f.repo.read('original'),before);assert.equal((await f.repo.list()).length,count);
 assert.equal(m.barriers.length,1);assert.equal(m.barriers[0].eventId,before.formal.eventId);assert.equal(m.barriers[0].coreHash,before.formal.coreHash);
 assert.deepEqual((await runtime.list()).rows,[]);assert.equal(await runtime.evaluate(row),null);assert.equal(m.calls.length,1);
});
test('aborted or revision mismatched NativeMath response never persists a diagnostic',async()=>{
 for(const kind of ['cancel','revision']){
  const f=await setup(),controller=new AbortController(),m=mockTransport(f,kind==='cancel'?{cancel:()=>controller.abort()}:{wrongRevision:true});
  const runtime=createPendingMathStepRuntime({...f.options,nativeMath:m.transport}),row=(await runtime.list()).rows[0],before=await f.repo.read('original');
  await assert.rejects(runtime.evaluate(row,controller.signal));assert.equal((await f.evidence.listSavedDrafts())[0].calculation.diagnostic,undefined);assert.deepEqual(await f.repo.read('original'),before);
 }
});
test('wrong original binding and diagnostic revision are never eligible for a model call',async()=>{
 const f=await setup(),record=(await f.evidence.listSavedDrafts())[0];
 const records=[{...record,binding:{...record.binding,groupId:'wrong'}},{...record,calculation:{...record.calculation,diagnostic:{answerRevision:99,stepRevision:1,stepId:f.support.step.stepId,sourceVersion:f.binding.contentHash,status:'undetermined',source:'none',explanation:'Unknown'}}}];
 for(const [index,r] of records.entries()){
  const runtime=createPendingMathStepRuntime({...f.options,evidence:{listSavedDrafts:async()=>[r],pending:async()=>[],status:async()=>null}}),page=await runtime.list();
  if(index===0){assert.equal(page.rows.length,0);assert.equal(page.complete,false);}else{assert.equal(page.rows[0].canEvaluate,false);assert.match(page.rows[0].notice,/版本不匹配/);}
 }
});

test('actual account second-device restores original/evidence before explicit semantic step; old final and event count remain unchanged',async t=>{
 const f=accountFixture('calculation'),db=await openD1();t.after(()=>db.sqlite.close());
 if(!db.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='practice_evidence_v1'").get())db.sqlite.exec(readFileSync(new URL('../drizzle/0023_practice_evidence_v1.sql',import.meta.url),'utf8'));
 db.sqlite.exec("INSERT INTO learning_accounts(user_id) VALUES ('owner')");
 const scope={userId:'owner',libraryId:'library'},study=new AccountStudyStore(db.binding);
 const body=quizBody({schemaVersion:2,learningSupport:f.item.learningSupport});body.practice={...body.practice,...f.item.practice,domain:'synthetic',sourceLabel:'Frozen original'};delete body.practice.options;
 const item=await sealStudyItem(body),snapshot=await sealStudySnapshot(snapshotBody([item],{libraryId:scope.libraryId}));await study.putSnapshot(scope,{snapshot,items:[item]},0);
 f.a.binding={...f.a.binding,snapshotId:snapshot.snapshotId,itemKey:item.itemKey,contentHash:item.contentHash};f.item=item;
 const attempts=new D1LearningAttemptStore(db.binding),original=courseEvidenceOriginal(study,attempts),store=new D1PracticeEvidenceStore(db.binding,original);
 const put=()=>db.sqlite.prepare('INSERT OR REPLACE INTO learning_attempts_v1(user_id,library_id,attempt_id,group_id,revision,attempt_json,updated_at) VALUES (?,?,?,?,?,?,?)').run(scope.userId,scope.libraryId,f.a.attemptId,f.a.binding.groupId,f.a.revision,JSON.stringify(f.a),f.a.updatedAt);
 const submitted=f.a.submitted;f.a.submitted=null;put();await store.mutate(scope,{schemaVersion:1,attemptId:f.a.attemptId,binding:f.a.binding,operationId:'step',expectedRevision:0,updatedAt:f.a.updatedAt,kind:'step-input',text:'Multiply rate by elapsed time'});f.a.submitted=submitted;
 f.a.evaluation={status:'resolved',rating:'good',correct:true,outcome:'correct',source:'deterministic',feedback:'Final correct',evaluationHash:'d'.repeat(64),referenceHash:item.contentHash};
 f.a.formal={eventId:'old-official',occurredAt:f.a.updatedAt,evaluationHash:f.a.evaluation.evaluationHash,rating:'good',status:'linked',coreHash:'e'.repeat(64),authoritativeRecord:null};put();
 const firstEvidence=await store.read(scope,'attempt');
 for(let index=0;index<200;index++){
  const id='a'+String(index).padStart(3,'0'),saved={...structuredClone(f.a),attemptId:id},details={...structuredClone(firstEvidence),attemptId:id};details.calculation.stepInput.text='';
  db.sqlite.prepare('INSERT INTO learning_attempts_v1(user_id,library_id,attempt_id,group_id,revision,attempt_json,updated_at) VALUES (?,?,?,?,?,?,?)').run(scope.userId,scope.libraryId,id,saved.binding.groupId,saved.revision,JSON.stringify(saved),saved.updatedAt);
  db.sqlite.prepare('INSERT INTO practice_evidence_v1(user_id,library_id,attempt_id,revision,evidence_json,updated_at) VALUES (?,?,?,?,?,?)').run(scope.userId,scope.libraryId,id,details.revision,JSON.stringify(details),details.updatedAt);
 }
 const newBody=structuredClone(body);newBody.practice.prompt='NEW CURRENT HEAD';newBody.practice.answer='999';
 const newer=await sealStudyItem(newBody),newSnapshot=await sealStudySnapshot(snapshotBody([newer],{libraryId:scope.libraryId,snapshotId:'new-head',revision:2}));await study.putSnapshot(scope,{snapshot:newSnapshot,items:[newer]},1);

 f.deps.getStudyStore=async()=>study;f.deps.getAttemptStore=async()=>attempts;f.deps.getPracticeEvidenceStore=async service=>new D1PracticeEvidenceStore(db.binding,original,{service});
 const model=f.model;f.model=async(...args)=>{const value=await model(...args);value.output.diagnostic.sourceVersion=item.contentHash;return value;};
 const app=createAccountStudyApplication(f.deps),actions=[];
 const fetcher=async(_url,init)=>{const request=JSON.parse(init.body);actions.push(request.action);try{const result=await app.post(request,auth,init.signal??new AbortController().signal);return {ok:true,status:200,json:async()=>result.value};}catch(error){return {ok:false,status:400,json:async()=>({error:error.message})};}};
 const oldFetch=globalThis.fetch;globalThis.fetch=fetcher;t.after(()=>{globalThis.fetch=oldFetch;});
 const before=db.sqlite.prepare("SELECT attempt_json FROM learning_attempts_v1 WHERE attempt_id='attempt'").get().attempt_json;
 const repository=createLocalAttemptRepository(scope),evidence=createLocalPracticeEvidenceRepository({ownerId:'owner',libraryId:'library'},{readAttempt:id=>repository.read(id)});
 const pending=createPendingMathStepRuntime({workspaceId:'second-device',ownerId:'owner',libraryId:'library',repository,evidence,
  cloud:createAccountAttemptClient({ownerId:'owner',libraryId:'library',fetcher}),evidenceCloud:createAccountPracticeEvidenceClient({ownerId:'owner',libraryId:'library',fetcher}),parseItem:parseStudyItem,parseSnapshot:parseStudySnapshot});
 assert.equal(await repository.read('attempt'),null);
 const page=await pending.list();assert.equal(page.complete,true);assert.equal(page.rows.length,1);assert.equal(page.rows[0].canEvaluate,true);assert.equal(page.rows[0].original.snapshot.snapshotId,snapshot.snapshotId);assert.notEqual(page.rows[0].original.item.contentHash,newer.contentHash);assert.equal(actions.filter(action=>action==='practice-evidence-list').length,2);assert.equal(f.calls,0);
 assert.equal(await repository.read('attempt'),null);assert.deepEqual(await evidence.listSavedDrafts(),[]);assert.equal(actions.includes('attempt-mutate'),false);
 const result=await pending.evaluate(page.rows[0]);assert.equal(result.status,'correct');assert.equal(result.source,'model');assert.equal(f.calls,1);
 assert.deepEqual((await repository.read('attempt')).submitted,f.a.submitted);assert.deepEqual((await evidence.listSavedDrafts())[0].calculation.diagnostic,result);
 assert.equal(db.sqlite.prepare("SELECT attempt_json FROM learning_attempts_v1 WHERE attempt_id='attempt'").get().attempt_json,before);assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM learning_attempts_v1').get().n,201);
 assert.deepEqual((await pending.list()).rows,[]);assert.equal(await pending.evaluate(page.rows[0]),null);assert.equal(f.calls,1);
});

test('owner switch during delayed native step rejects feedback before diagnosis persistence',async()=>{
 const f=await setup();let current=true,release;const gate=new Promise(resolve=>{release=resolve;});
 const m=mockTransport(f,{gate:()=>gate}),runtime=createPendingMathStepRuntime({...f.options,current:()=>current,nativeMath:m.transport}),row=(await runtime.list()).rows[0];
 const pending=runtime.evaluate(row);while(!m.calls.length)await new Promise(resolve=>setTimeout(resolve,0));current=false;release();
 await assert.rejects(pending,/切换/);assert.equal((await f.evidence.listSavedDrafts())[0].calculation.diagnostic,undefined);assert.deepEqual(await f.repo.read('original'),f.original);
});
test('two IndexedDB peers cannot overwrite a completed source-bound diagnosis with late response',async()=>{
 const f=await setup();let release;const gate=new Promise(resolve=>{release=resolve;});
 const m=mockTransport(f,{gate:()=>gate}),runtime=createPendingMathStepRuntime({...f.options,nativeMath:m.transport}),row=(await runtime.list()).rows[0];
 const pending=runtime.evaluate(row);while(!m.calls.length)await new Promise(resolve=>setTimeout(resolve,0));
 const peer=createLocalPracticeEvidenceRepository({ownerId:f.scope.userId,libraryId:f.scope.libraryId},{readAttempt:id=>f.repo.read(id),resolveSource:async()=>({binding:f.binding,calculation:f.support})});
 const diagnostic={answerRevision:1,stepRevision:1,stepId:f.support.step.stepId,sourceVersion:f.binding.contentHash,status:'correct',source:'deterministic',explanation:'Other device completed original step'};
 await peer.mutate({schemaVersion:1,attemptId:'original',binding:f.binding,operationId:'peer-complete',expectedRevision:row.evidence.revision,updatedAt:f.attempt.updatedAt,kind:'step-diagnostic',diagnostic});release();
 await assert.rejects(pending,/conflict/);assert.deepEqual((await f.evidence.listSavedDrafts())[0].calculation.diagnostic,diagnostic);assert.deepEqual(await f.repo.read('original'),f.original);
});

test('corrupt diagnosis preserves only validated owned raw step as disabled display, strict read unchanged',async()=>{
 const f=await setup(),db=await new Promise((resolve,reject)=>{const r=indexedDB.open('zhixue-practice-evidence-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const key=[f.scope.userId,f.scope.libraryId,'original'];let stored;
 await new Promise((resolve,reject)=>{const tx=db.transaction('records','readwrite'),s=tx.objectStore('records'),r=s.get(key);r.onsuccess=()=>{stored=r.result;stored.record.calculation.diagnostic={answerRevision:1,stepRevision:99,stepId:f.support.step.stepId,sourceVersion:f.binding.contentHash,status:'correct',source:'deterministic',explanation:'Corrupt revision'};s.put(stored);};tx.oncomplete=resolve;tx.onabort=reject;});
 const before=structuredClone(stored),runtime=createPendingMathStepRuntime(f.options),page=await runtime.list();
 assert.equal(page.rows.length,1);assert.equal(page.rows[0].stepText,'2');assert.equal(page.rows[0].canEvaluate,false);assert.match(page.rows[0].notice,/损坏/);await assert.rejects(runtime.evaluate(page.rows[0]),/损坏/);
 const strict=createLocalPracticeEvidenceRepository({ownerId:f.scope.userId,libraryId:f.scope.libraryId},{readAttempt:id=>f.repo.read(id),resolveSource:async()=>({binding:f.binding,calculation:f.support})});
 await assert.rejects(strict.read('original'),/step-revision/);assert.deepEqual(await strict.listSavedDrafts(),[]);
 const raw=await new Promise((resolve,reject)=>{const r=db.transaction('records').objectStore('records').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=reject;});assert.deepEqual(raw,before);
 // Stripping diagnosis may not rescue an unrelated malformed field or foreign binding.
 await new Promise((resolve,reject)=>{const tx=db.transaction('records','readwrite');const bad=structuredClone(raw);bad.record.calculation.stepInput.text=123;tx.objectStore('records').put(bad);tx.oncomplete=resolve;tx.onabort=reject;});
 assert.deepEqual(await strict.listSavedStepDrafts(),[]);db.close();
});
