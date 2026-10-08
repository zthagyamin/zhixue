import test from 'node:test';
import assert from 'node:assert/strict';
import {applyPracticeEvidenceMutation} from '../src/domain/practice-evidence/index.ts';
import {createLocalPracticeEvidenceRepository} from '../src/infrastructure/practice-evidence/index.ts';
import {report} from './fixtures/practice-evidence-fixtures.mjs';
import {fixture} from './fixtures/practice-evidence-local-fixtures.mjs';
import {indexedDB} from 'fake-indexeddb';
import {resolvePracticeEvidenceAuthority} from '../src/application/practice-evidence/index.ts';
globalThis.indexedDB=indexedDB;
test('lost receipt retries exact operation and preserves first report; unsupported/incompatible explicit',async()=>{
 const f=fixture(),m=f.m('code-report',{report:report()});await f.repo.mutate(m);
 let cloud=null,calls=0;const port={mutate:async op=>{const result=await applyPracticeEvidenceMutation(cloud,op,{attempt:f.a});cloud=result.record;if(++calls===1) throw Error('receipt lost');return {...result,durable:true};}};
 assert.equal((await f.repo.sync(port)).pending,1);assert.equal((await f.repo.sync(port)).acked,1);assert.equal((await f.repo.pending()).length,0);assert.equal(await f.repo.status('attempt'),'cloud-acked');
 await f.repo.mutate(f.m('code-report',{report:report(2)},1,'new'));
 assert.equal((await f.repo.sync({mutate:async()=>({status:'unsupported'})})).unsupported,true);assert.equal(await f.repo.status('attempt'),'cloud-unsupported');
 assert.equal((await f.repo.sync({mutate:async()=>({status:'incompatible'})})).incompatible,true);assert.equal((await f.repo.pending()).length,1);
 assert.equal((await f.repo.read('attempt')).execution.first.runId,1);
});
test('hydration keeps divergent pending work and first history; bad receipts remain conflicts',async()=>{
 const f=fixture(),m=f.m('code-report',{report:report()});await f.repo.mutate(m);
 const remote=(await applyPracticeEvidenceMutation(null,{...m,operationId:'remote',report:report(3)},{attempt:f.a})).record;
 assert.equal(await f.repo.hydrate(remote),false);assert.equal((await f.repo.read('attempt')).execution.first.runId,1);
 assert.equal((await f.repo.sync({mutate:async()=>({status:'accepted',durable:true,operationId:'wrong',revision:1,record:remote})})).conflict,true);
 assert.equal((await f.repo.pending()).length,1);assert.equal(await f.repo.status('attempt'),'cloud-conflict');
 const clean=createLocalPracticeEvidenceRepository(f.scope,f.attempts);
 await assert.rejects(clean.hydrate({...remote,binding:{...remote.binding,ownerId:'other'}}),/scope/);
 const g=fixture();const adjusted={...remote,binding:g.a.binding};assert.equal((await g.repo.refresh({list:async()=>[adjusted]})).restored,1);assert.equal((await g.repo.read('attempt')).revision,1);
});
test('unknown capabilities and HTTP conflicts retain outbox with explicit state',async()=>{
 const f=fixture();await f.repo.mutate(f.m('code-report',{report:report()}));
 assert.equal((await f.repo.sync({mutate:async()=>({status:'accepted',schemaVersion:99})})).incompatible,true);
 assert.equal(await f.repo.status('attempt'),'cloud-incompatible');
 assert.equal((await f.repo.sync({mutate:async()=>{throw Object.assign(Error('conflict'),{status:409});}})).conflict,true);
 assert.equal((await f.repo.pending()).length,1);
});
async function pointerThenReport() {
 const f=fixture(),child={...structuredClone(f.a),attemptId:'child',parentAttemptId:'attempt'};
 const attempts={...f.attempts,readAttempt:async id=>id==='child'?structuredClone(child):f.attempts.readAttempt(id)};
 const repo=createLocalPracticeEvidenceRepository(f.scope,attempts),pointer=f.m('execution-pointer',{prepared:{instanceId:'instance',attemptId:'child'}},0,'pointer'),first=f.m('code-report',{report:report(7),output:'immutable first output'},1,'first-report');
 await repo.mutate(pointer);await repo.mutate(first);
 return {...f,attempts,repo,pointer,first};
}
function actualCloud(f,transform=value=>value) {
 let record=null;
 return {state:()=>record,mutate:async mutation=>{
  const authority=await resolvePracticeEvidenceAuthority(f.scope,f.attempts,mutation,undefined,record),receipt=await applyPracticeEvidenceMutation(record,mutation,authority);record=receipt.record;
  return transform({...receipt,durable:true},mutation);
 }};
}
test('pointer-only acknowledged prefix drains before a later local first report without rolling it back',async()=>{
 const f=await pointerThenReport(),cloud=actualCloud(f),before=await f.repo.read('attempt');
 const result=await f.repo.sync(cloud);assert.equal(result.acked,2);assert.equal(result.pending,0);assert.equal(result.conflict,false);
 assert.equal(cloud.state().revision,2);assert.equal((await f.repo.read('attempt')).revision,2);assert.deepEqual(await f.repo.read('attempt'),before);
 assert.equal(await f.repo.status('attempt'),'cloud-acked');
});
test('pointer prefix lost receipt replays exactly and then acknowledges report introduction',async()=>{
 const f=await pointerThenReport();let lost=false;const calls=[];
 const cloud=actualCloud(f,(receipt,mutation)=>{calls.push(structuredClone(mutation));if(!lost){lost=true;throw Error('pointer receipt lost');}return receipt;});
 const one=await f.repo.sync(cloud);assert.equal(one.acked,0);assert.equal(one.pending,2);assert.equal(one.conflict,false);
 const refreshed=createLocalPracticeEvidenceRepository(f.scope,f.attempts),two=await refreshed.sync(cloud);assert.equal(two.acked,2);assert.equal(two.pending,0);assert.equal(two.conflict,false);assert.deepEqual(calls[0],calls[1]);
 assert.equal((await refreshed.read('attempt')).execution.firstOutput,'immutable first output');assert.equal((await refreshed.read('attempt')).revision,2);
});
test('acknowledged prefix cannot fabricate, change or omit required first evidence',async()=>{
 for(const kind of ['premature-first','changed-first','changed-output','missing-required-first']) {
  const f=await pointerThenReport(),before=await f.repo.read('attempt');
  const cloud=actualCloud(f,(receipt,mutation)=>{
   if(kind==='premature-first'&&mutation.kind==='execution-pointer') return {...receipt,record:{...receipt.record,execution:{...receipt.record.execution,first:report(7),latest:report(7),firstOutput:'immutable first output',latestOutput:'immutable first output'}}};
   if(mutation.kind!=='code-report') return receipt;
   const changed=structuredClone(receipt);
   if(kind==='changed-first') changed.record.execution.first=report(99);
   if(kind==='changed-output') changed.record.execution.firstOutput='tampered first output';
   if(kind==='missing-required-first') {delete changed.record.execution.first;delete changed.record.execution.latest;delete changed.record.execution.firstOutput;delete changed.record.execution.latestOutput;}
   return changed;
  });
  const result=await f.repo.sync(cloud);assert.equal(result.conflict,true,kind);assert.equal(result.acked,kind==='premature-first'?0:1,kind);assert.equal(result.pending,kind==='premature-first'?2:1,kind);
  assert.deepEqual(await f.repo.read('attempt'),before);assert.equal(await f.repo.status('attempt'),'cloud-conflict');
 }
});
async function removeIntroductionMetadata(f) {
 const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('zhixue-practice-evidence-v1',1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 try {await new Promise((resolve,reject)=>{
  const tx=db.transaction('records','readwrite'),store=tx.objectStore('records'),request=store.get([f.scope.ownerId,f.scope.libraryId,'attempt']);
  request.onsuccess=()=>{const row=request.result;delete row.firstReportOperation;store.put(row);};tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error);
 });}finally{db.close();}
}
test('legacy local row can establish introduction only from complete matching pending history',async()=>{
 const f=await pointerThenReport();await removeIntroductionMetadata(f);
 const result=await createLocalPracticeEvidenceRepository(f.scope,f.attempts).sync(actualCloud(f));assert.equal(result.acked,2);assert.equal(result.pending,0);assert.equal(result.conflict,false);
});
test('later identical pending report cannot excuse missing first evidence in an already acknowledged prefix',async()=>{
 for(const legacy of [false,true]) {
  const f=await pointerThenReport();let stripFirst=false;
  const cloud=actualCloud(f,(receipt,mutation)=>{
   if(!stripFirst||mutation.kind!=='execution-pointer')return receipt;
   const bad=structuredClone(receipt);delete bad.record.execution.first;delete bad.record.execution.latest;delete bad.record.execution.firstOutput;delete bad.record.execution.latestOutput;return bad;
  });
  assert.equal((await f.repo.sync(cloud)).pending,0);
  if(legacy)await removeIntroductionMetadata(f);
  await f.repo.mutate(f.m('execution-pointer',{prepared:{instanceId:'new-instance',attemptId:'child'}},2,'new-pointer'));
  await f.repo.mutate(f.m('code-report',{report:report(7),output:'immutable first output'},3,'identical-later-report'));
  stripFirst=true;
  const before=await f.repo.read('attempt'),result=await f.repo.sync(cloud);assert.equal(result.acked,0);assert.equal(result.pending,2);assert.equal(result.conflict,true);assert.deepEqual(await f.repo.read('attempt'),before);
 }
});
test('exact acknowledged operation and earlier prefix fingerprints remain mandatory',async()=>{
 const f=await pointerThenReport(),before=await f.repo.read('attempt');
 const cloud=actualCloud(f,(receipt,mutation)=>{
  if(mutation.kind!=='code-report')return receipt;
  const bad=structuredClone(receipt);bad.record.operations[0].fingerprint='b'.repeat(64);return bad;
 });
 const result=await f.repo.sync(cloud);assert.equal(result.acked,1);assert.equal(result.pending,1);assert.equal(result.conflict,true);assert.deepEqual(await f.repo.read('attempt'),before);
});
