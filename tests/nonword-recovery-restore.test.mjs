import test from 'node:test';import assert from 'node:assert/strict';
import {IDBFactory,IDBKeyRange,IDBObjectStore} from 'fake-indexeddb';
import {createNonWordRuntime} from '../src/infrastructure/nonword-study/index.ts';
import {exportStudyRecovery} from '../app/study-recovery-export.ts';
import {previewNonwordRestore,restoreNonwordBackup,readRecoveryArchives} from '../src/infrastructure/nonword-recovery/index.ts';
import {createLocalAttemptRepository} from '../src/infrastructure/learning-attempt/index.ts';
import {attemptFingerprint} from '../src/infrastructure/learning-attempt/index.ts';
import {hashLocalJson} from '../app/local-json-integrity.ts';
import {restoreRecoveryDatabase} from '../src/infrastructure/nonword-recovery/restore-store.ts';
import {saveRecoveryArchive} from '../src/infrastructure/nonword-recovery/archive.ts';
const owner='account:a',scope={workspaceId:owner,ownerId:'a',libraryId:'library',snapshotId:'original-snapshot',itemKey:'question',contentHash:'a'.repeat(64),groupId:'group',roundId:'round',cloud:false};
const options={current:()=>true};
function reset(){globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;}
async function original(){reset();const runtime=await createNonWordRuntime(scope,'recall');await runtime.session.submit('IMMUTABLE FIRST ANSWER');return {pack:await exportStudyRecovery(owner),attempt:runtime.session.snapshot(),queue:await runtime.repository.pending()};}

test('restore preserves pending answer, original logical identity and operation IDs, then the actual runtime resumes',async()=>{
 const f=await original();reset();const preview=await previewNonwordRestore(owner,f.pack,options);assert.ok(preview.restorable>0);
 const restored=await restoreNonwordBackup(owner,f.pack,preview.previewHash,options);assert.equal(restored.restored,preview.restorable);
 const resumed=await createNonWordRuntime(scope,'recall');assert.deepEqual(resumed.session.snapshot(),f.attempt);assert.deepEqual(await resumed.repository.pending(),f.queue);
 assert.equal(resumed.session.snapshot().formal,null);const again=await previewNonwordRestore(owner,f.pack,options);const receipt=await restoreNonwordBackup(owner,f.pack,again.previewHash,options);
 assert.equal(receipt.restored,0);assert.equal((await readRecoveryArchives(owner)).length,1);
});
test('another account and changed preview cannot write any imported answer',async()=>{
 const f=await original();reset();await assert.rejects(previewNonwordRestore('account:b',f.pack,options));
 const preview=await previewNonwordRestore(owner,f.pack,options);const current=await createNonWordRuntime(scope,'recall');await current.session.submit('LOCAL DIFFERENT ANSWER');
 await assert.rejects(restoreNonwordBackup(owner,f.pack,preview.previewHash,options),/重新预览/);assert.equal((await current.repository.read(f.attempt.attemptId)).submitted.answer,'LOCAL DIFFERENT ANSWER');
});
test('conflicts preserve both copies and never attach the imported outbox to a different local answer',async()=>{
 const f=await original();reset();const runtime=await createNonWordRuntime(scope,'recall');await runtime.session.submit('LOCAL DIFFERENT ANSWER');const before=await runtime.repository.pending();
 const preview=await previewNonwordRestore(owner,f.pack,options);assert.ok(preview.conflicts>0);await restoreNonwordBackup(owner,f.pack,preview.previewHash,options);
 assert.deepEqual(await runtime.repository.pending(),before);assert.equal((await runtime.repository.read(f.attempt.attemptId)).submitted.answer,'LOCAL DIFFERENT ANSWER');
 assert.equal(JSON.stringify(await readRecoveryArchives(owner)).includes(f.attempt.submitted.answer),true);
});
test('source switch before commit keeps the destination empty and the old backup readable',async()=>{
 const f=await original();reset();let current=true;const guarded={current:()=>current},preview=await previewNonwordRestore(owner,f.pack,guarded);current=false;
 await assert.rejects(restoreNonwordBackup(owner,f.pack,preview.previewHash,guarded),/stale/);assert.deepEqual(await createLocalAttemptRepository({userId:'a',libraryId:'library'}).list(),[]);
});

test('a changed queued answer cannot replace the original answer through restored synchronization',async()=>{
 const f=await original(),tampered=structuredClone(f.pack),database=tampered.payload.nonword.databases.find(row=>row.kind==='attempts');
 const changed=database.stores.outbox.find(row=>row.mutation.kind==='checkpoint'&&row.mutation.answer);
 changed.mutation.answer='WRONG QUEUED ANSWER';changed.fingerprint=await attemptFingerprint(changed.mutation);tampered.payloadHash=await hashLocalJson(tampered.payload);reset();
 const preview=await previewNonwordRestore(owner,tampered,options);assert.ok(preview.review>0);await restoreNonwordBackup(owner,tampered,preview.previewHash,options);
 const repository=createLocalAttemptRepository({userId:'a',libraryId:'library'});assert.equal(await repository.read(f.attempt.attemptId),null);assert.deepEqual(await repository.pending(),[]);
 assert.equal(JSON.stringify(await readRecoveryArchives(owner)).includes('IMMUTABLE FIRST ANSWER'),true);
});

test('outbox keys must match the actual ack lookup length',async()=>{
 const f=await original(),tampered=structuredClone(f.pack);tampered.payload.nonword.databases.find(row=>row.kind==='attempts').stores.outbox[0].key.push('EXTRA');tampered.payloadHash=await hashLocalJson(tampered.payload);reset();
 await assert.rejects(previewNonwordRestore(owner,tampered,options),/row-key/);
});

test('a conflicting parent cannot adopt a restored child from the other original answer',async()=>{
 const f=await original(),first=await createNonWordRuntime(scope,'recall'),child=await createNonWordRuntime(scope,'recall',{purpose:'remediation',parentAttemptId:first.session.snapshot().attemptId,instanceId:'child'});await child.session.submit('CHILD OF ORIGINAL');
 const pack=await exportStudyRecovery(owner),childId=child.session.snapshot().attemptId;reset();const parent=await createNonWordRuntime(scope,'recall');await parent.session.submit('DIFFERENT PARENT');
 const preview=await previewNonwordRestore(owner,pack,options);await restoreNonwordBackup(owner,pack,preview.previewHash,options);assert.equal(await parent.repository.read(childId),null);
 assert.equal((await parent.repository.read(f.attempt.attemptId)).submitted.answer,'DIFFERENT PARENT');
});

test('late invalidation at add success aborts the database transaction before committing records',async()=>{
 const f=await original(),database=f.pack.payload.nonword.databases.find(row=>row.kind==='attempts');reset();let current=true;
 const originalAdd=IDBObjectStore.prototype.add;
 IDBObjectStore.prototype.add=function(...args){const request=originalAdd.apply(this,args);request.addEventListener('success',()=>{current=false;},{once:true});return request;};
 try{await assert.rejects(restoreRecoveryDatabase(database,()=>current),/stale/);}finally{IDBObjectStore.prototype.add=originalAdd;}
 assert.deepEqual(await createLocalAttemptRepository({userId:'a',libraryId:'library'}).list(),[]);
});

test('archive capacity is checked before commit so the previous archives remain readable',async()=>{
 const f=await original(),source=f.pack.payload.nonword;reset();await saveRecoveryArchive(owner,source,()=>true);
 const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('zhixue-nonword-recovery-archives-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
 const copies=[];for(let index=0;index<499;index++){const copy=structuredClone(source);copy.databases.find(row=>row.kind==='attempts').stores.attempts[0].attempt.updatedAt=new Date(Date.UTC(2026,0,1,0,0,index)).toISOString();const sourceHash=await attemptFingerprint(copy);copies.push({schemaVersion:1,key:[owner,sourceHash],source:copy,sourceHash,pendingReview:true});}
 await new Promise((resolve,reject)=>{const tx=db.transaction('packages','readwrite');for(const copy of copies)tx.objectStore('packages').add(copy);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
 const extra=structuredClone(source);extra.databases.find(row=>row.kind==='attempts').stores.attempts[0].attempt.updatedAt='2027-01-01T00:00:00Z';
 await assert.rejects(saveRecoveryArchive(owner,extra,()=>true),/archive-limit/);assert.equal((await readRecoveryArchives(owner)).length,500);
});

test('old evaluation and formal pointers remain readonly evidence without destination core authority',async()=>{
 const f=await original(),runtime=await createNonWordRuntime(scope,'recall');await runtime.session.assess({status:'correct',source:'model',rating:'good',explanation:'OLD SUGGESTION'});await runtime.session.reserve('good');
 const pack=await exportStudyRecovery(owner),attempt=runtime.session.snapshot();reset();
 const preview=await previewNonwordRestore(owner,pack,{...options,verifyRow:async()=>true});await restoreNonwordBackup(owner,pack,preview.previewHash,{...options,verifyRow:async()=>true});
 assert.equal(await createLocalAttemptRepository({userId:'a',libraryId:'library'}).read(attempt.attemptId),null);
 assert.equal(JSON.stringify(await readRecoveryArchives(owner)).includes('OLD SUGGESTION'),true);assert.equal(f.attempt.formal,null);
});

test('forwarded archives survive another restore/export cycle without turning into active grades',async()=>{
 const f=await original(),runtime=await createNonWordRuntime(scope,'recall');await runtime.session.assess({status:'incorrect',source:'deterministic',rating:'again',explanation:'Retained old diagnosis'});
 const firstPack=await exportStudyRecovery(owner);reset();const preview=await previewNonwordRestore(owner,firstPack,options);await restoreNonwordBackup(owner,firstPack,preview.previewHash,options);
 const next=await exportStudyRecovery(owner);assert.ok(next.pending.nonword.some(value=>value.startsWith('archive:')));assert.equal(JSON.stringify(next.payload.nonwordArchives).includes('Retained old diagnosis'),true);
 reset();const second=await previewNonwordRestore(owner,next,options);await restoreNonwordBackup(owner,next,second.previewHash,options);
 assert.equal(JSON.stringify(await readRecoveryArchives(owner)).includes('Retained old diagnosis'),true);assert.equal(await createLocalAttemptRepository({userId:'a',libraryId:'library'}).read(f.attempt.attemptId),null);
});
