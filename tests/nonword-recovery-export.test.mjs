import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {createNonWordRuntime} from '../src/infrastructure/nonword-study/index.ts';
import {exportStudyRecovery,hasPendingStudyRecovery} from '../app/study-recovery-export.ts';
import {recoveryPending} from '../src/application/sources/index.ts';
import {createSourceMaintenance,createSignOut} from '../src/application/sources/index.ts';
import {settingsPendingSummary} from '../app/study-settings-model.ts';
import {readFileSync} from 'node:fs';
import {createNativeCourseSourceCache,createCourseRequestJournal,createLocalCourseEvidenceRepository} from '../src/infrastructure/course-study/index.ts';
import {createNativeMathSourceCache} from '../src/infrastructure/math-study/index.ts';
import {courseTaskHash,resolveCourseTask,applyCourseEvidenceMutation} from '../src/domain/course-study/index.ts';
import {studyHash} from '../src/domain/sync/index.ts';
import {fixture as mathSource} from './fixtures/native-math-fixtures.mjs';
import {readTrialMaterialBackup} from '../app/trial-material-backup-model.ts';
import {collectNonwordRecovery,nonwordMissingDependencies} from '../src/infrastructure/nonword-recovery/index.ts';
import {applyAttemptMutation} from '../src/domain/learning-attempt/index.ts';
import {attemptFingerprint} from '../src/infrastructure/learning-attempt/index.ts';
import {courseEvidenceFingerprint} from '../src/infrastructure/course-study/index.ts';
import {sealStudyItem} from '../app/account-study-content.ts';
import {quizBody} from './fixtures/account-study-fixtures.mjs';

async function saved(owner='a',library='library-a',answer='SAVED ORIGINAL'){
 const runtime=await createNonWordRuntime({workspaceId:'account:'+owner,ownerId:owner,libraryId:library,snapshotId:'snapshot',itemKey:'question',contentHash:'a'.repeat(64),groupId:'group',roundId:'round',cloud:false},'recall');
 await runtime.session.submit(answer);return runtime;
}
function reset(){globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;}

test('V2 recovery includes the actual saved pending first answer and its original queued operations',async()=>{
 reset();const runtime=await saved(),original=runtime.session.snapshot(),queue=await runtime.repository.pending();
 const pack=await exportStudyRecovery('account:a');
 assert.equal(JSON.stringify(pack.payload).includes(original.submitted.answer),true,'durably saved answer must be in the downloadable payload');
 assert.equal(pack.schemaVersion,2);assert.equal(pack.format,'zhixue-study-recovery-v2');
 for(const row of queue)assert.equal(JSON.stringify(pack.payload).includes(row.mutation.operationId),true);
 assert.equal(hasPendingStudyRecovery(pack),true);assert.equal(recoveryPending(pack),true);
 assert.deepEqual(await runtime.repository.read(original.attemptId),original);assert.deepEqual(await runtime.repository.pending(),queue);
});

test('recovery captures every owned library but never another owner, without creating formal results',async()=>{
 reset();const one=await saved('a','library-a','OWNER A LIBRARY A'),two=await saved('a','library-b','OWNER A LIBRARY B'),other=await saved('b','library-a','OTHER OWNER SECRET');
 const pack=await exportStudyRecovery('account:a'),text=JSON.stringify(pack.payload);
 assert.equal(text.includes(one.session.snapshot().submitted.answer),true);assert.equal(text.includes(two.session.snapshot().submitted.answer),true);
 assert.equal(text.includes(other.session.snapshot().submitted.answer),false);
 for(const runtime of [one,two,other])assert.equal(runtime.session.snapshot().formal,null);
});

test('a nonword answer change during capture prevents a complete recovery receipt',async()=>{
 reset();const runtime=await saved();const {collectStudyRecovery}=await import('../app/study-recovery-export.ts');let captures=0;
 const pack=await exportStudyRecovery('account:a',{collect:async()=>{await runtime.session.updateView({activeSeconds:++captures});return collectStudyRecovery('account:a');}});
 assert.equal(pack.complete,false);assert.equal(pack.consistency,'changed-during-read');assert.ok(captures>=2);
});

test('signed-in native owner namespace and native source/claim associations are captured unchanged',async()=>{
 reset();const userId='account:a',libraryId='local-vault:'+'a'.repeat(64);
 const supports=JSON.parse(readFileSync(new URL('./fixtures/course-task-support-v2.json',import.meta.url),'utf8'));
 const support=structuredClone(supports.cases.find(row=>row.valid&&row.mode==='recall').support);
 const item={schemaVersion:2,kind:'practice',eventKind:'due',itemKey:'practice:course',contentHash:'b'.repeat(64),learningSupport:support,practice:{domain:'course',questionType:'recall',prompt:support.task.prompt}};
 const identity={schemaVersion:1,libraryId,itemKey:item.itemKey,contentHash:item.contentHash,localBindingHash:'c'.repeat(64)};
 const body={schemaVersion:1,identity,item,taskHash:await courseTaskHash(resolveCourseTask(item))},capture={...body,captureId:await studyHash(body)};
 const runtime=await createNonWordRuntime({workspaceId:userId,ownerId:userId,libraryId,snapshotId:'local',itemKey:item.itemKey,contentHash:item.contentHash,groupId:'course-group',roundId:'round',cloud:false},'recall');
 await runtime.session.submit('NATIVE SOURCE FIRST ANSWER');const courseCache=createNativeCourseSourceCache({userId,libraryId}),original=runtime.session.snapshot();
 await courseCache.save(capture);await courseCache.bindAttempt(original.attemptId,original.binding,capture.captureId);
 const m=await mathSource(),math=await createNonWordRuntime({workspaceId:userId,ownerId:userId,libraryId,snapshotId:'local',itemKey:m.item.itemKey,contentHash:m.item.contentHash,groupId:'math-group',roundId:'round',cloud:false},'calculation');
 await math.session.submit('4');const raw=math.session.snapshot(),mathCache=createNativeMathSourceCache({userId,libraryId});
 await mathCache.save(m.capture);await mathCache.bindAttempt(raw.attemptId,raw.binding,m.capture.captureId);
 const claim={...m.claim,attempt:raw};await mathCache.saveClaim(claim);
 const journal=createCourseRequestJournal({userId,libraryId});await journal.request('synthetic-pending-request',()=> 'original-request-identity');
 const pack=await exportStudyRecovery('account:a'),payload=JSON.stringify(pack.payload.nonword);
 assert.equal(payload.includes(original.submitted.answer),true);assert.equal(payload.includes(capture.captureId),true);assert.equal(payload.includes(m.capture.captureId),true);assert.equal(payload.includes('original-request-identity'),true);
 assert.deepEqual(pack.payload.nonword.databases.find(value=>value.kind==='native-math').stores.claims[0].claim,claim);
 assert.deepEqual(await courseCache.read(original.binding,original.attemptId),capture);assert.deepEqual(await mathCache.readClaim(raw.attemptId),claim);
 assert.equal(JSON.stringify(await exportStudyRecovery('account:b')).includes(original.submitted.answer),false);
});

test('saved nonword work is visible to settings, signout warning and cache-clear guards',async()=>{
 reset();await saved();const pack=await exportStudyRecovery('account:a');
 assert.ok(settingsPendingSummary(pack).total>0);
 const frame={owner:'account:a',ready:true,current:()=>true,pending:()=>false,buffers:()=>false,version:()=>0},confirmations=[];let clears=0;
 const signout=createSignOut({capture:()=>frame,prepareNavigation:()=>()=>true,confirm:message=>{confirmations.push(message);return true;},export:async()=>pack,clearViews:async()=>{clears++;},retire(){},captureConnection:()=>({revoke:async()=>{},clear(){}}),redirect(){}});
 await signout.run();assert.equal(confirmations.some(message=>message.includes('待同步、待写回或待恢复')),true);assert.equal(clears,0);
 const maintenance=createSourceMaintenance({capture:()=>frame,confirm:()=>true,export:async()=>pack,download(){},clearLibrary:async()=>{clears++;},clearRead:async()=>{clears++;},clearWorkspace:async()=>{clears++;},cancelRead(){},pauseRead(){},message(){}});
 assert.equal((await maintenance.clearCache(true)).status,'blocked');assert.equal(clears,0);
});

test('V2 material extraction remains exact-owner and exact-library and rejects unknown versions',async()=>{
 reset();const pack=await exportStudyRecovery('account:a');
 const body={subject:'Course',title:'Material',questions:[{id:'q',prompt:'Why?',answer:'Reference',filename:'source.md',section:null,kind:'qa'}]};
 const id='trial-'+Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(body)))).toString('hex'),entry={id,...body};
 const {saveTrialMaterial}=await import('../app/saved-note-trials.ts');await saveTrialMaterial('account:a','library-a',body.subject,body.title,body.questions);
 const updated=await exportStudyRecovery('account:a');assert.deepEqual(await readTrialMaterialBackup(updated,'account:a','library-a'),[entry]);
 await assert.rejects(readTrialMaterialBackup(updated,'account:b','library-a'));await assert.rejects(readTrialMaterialBackup({...pack,schemaVersion:3},'account:a','library-a'));
 await assert.rejects(readTrialMaterialBackup({...updated,schemaVersion:1},'account:a','library-a'));
});

async function changeStore(name,store,key,alter){
 const db=await new Promise((resolve,reject)=>{const request=indexedDB.open(name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
 try{await new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite'),records=tx.objectStore(store),read=records.get(key);read.onsuccess=()=>{const next=alter(read.result);if(next===null)records.delete(key);else records.put(next);};tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});}finally{db.close();}
}
test('invalid persisted scope or operation hash prevents a misleading successful recovery file',async()=>{
 reset();const runtime=await saved(),attempt=runtime.session.snapshot(),queued=(await runtime.repository.pending())[0];
 await changeStore('zhixue-learning-attempts-v1','outbox',queued.key,row=>({...row,fingerprint:'f'.repeat(64)}));
 await assert.rejects(exportStudyRecovery('account:a'),/operation/);
 reset();const second=await saved(),row=second.session.snapshot();
 await changeStore('zhixue-learning-attempts-v1','attempts',['a','library-a',row.attemptId],raw=>({...raw,attempt:{...raw.attempt,binding:{...raw.attempt.binding,ownerId:'b'}}}));
 await assert.rejects(exportStudyRecovery('account:a'),/binding/);assert.equal(attempt.submitted.answer,'SAVED ORIGINAL');
});

test('missing queued aggregate dependencies make the package partial without discarding surviving work',async()=>{
 reset();await saved();const slice=await collectNonwordRecovery('account:a'),copy=structuredClone(slice),database=copy.databases.find(row=>row.kind==='attempts');database.stores.attempts=[];
 assert.ok(nonwordMissingDependencies(copy,[]).some(value=>value.startsWith('nonword-operation:')));
 assert.equal(database.stores.outbox.length>0,true);
});

test('export does not initialize missing databases and rejects an existing unsupported schema',async()=>{
 reset();const before=await indexedDB.databases();await exportStudyRecovery('account:a');
 const created=(await indexedDB.databases()).filter(row=>row.name.startsWith('zhixue-learning-attempts')||row.name.startsWith('zhixue-native-')||row.name==='zhixue-course-evidence-v1'||row.name==='zhixue-practice-evidence-v1');
 assert.equal(before.length,0);assert.deepEqual(created,[]);
 await new Promise((resolve,reject)=>{const request=indexedDB.open('zhixue-learning-attempts-v1',2);request.onsuccess=()=>{request.result.close();resolve();};request.onerror=()=>reject(request.error);});
 await assert.rejects(exportStudyRecovery('account:a'),/storage-version/);
});

test('a legitimate ahead-of-local cloud acknowledgement cannot prevent export of local descendants',async()=>{
 reset();const runtime=await saved(),original=runtime.session.snapshot(),first=(await runtime.repository.pending()).find(row=>row.mutation.expectedRevision===0);
 let remote=applyAttemptMutation(null,first.mutation,first.fingerprint).attempt;
 for(let index=1;index<=3;index++){const mutation={...first.mutation,operationId:'remote-operation-'+index,expectedRevision:remote.revision,answer:'REMOTE ANSWER '+index};remote=applyAttemptMutation(remote,mutation,await attemptFingerprint(mutation)).attempt;}
 await runtime.repository.ack(first.mutation.operationId,{status:'duplicate',durable:true,operationId:first.mutation.operationId,revision:remote.revision,attempt:remote});
 const pack=await exportStudyRecovery('account:a'),rows=pack.payload.nonword.databases.find(database=>database.kind==='attempts').stores.attempts;
 const row=rows.find(row=>row.key[2]===original.attemptId);
 assert.equal(row.cloudRevision>row.attempt.revision,true);assert.deepEqual(row.attempt,original);assert.equal(pack.pending.nonword.length>0,true);
});

test('every native capture requires its original identity pointer before a complete export claim',async()=>{
 reset();const m=await mathSource(),cache=createNativeMathSourceCache({userId:'a',libraryId:m.scope.libraryId});await cache.save(m.capture);
 const slice=await collectNonwordRecovery('account:a'),database=slice.databases.find(value=>value.kind==='native-math');
 await changeStore('zhixue-native-math-sources-v1','identities',database.stores.identities[0].key,()=>null);
 assert.equal(await cache.byIdentity(m.identity),null);
 const pack=await exportStudyRecovery('account:a');assert.equal(pack.complete,false);assert.ok(pack.missingDependencies.some(value=>value.startsWith('nonword-source-identity:')));
 assert.equal(pack.payload.nonword.databases.find(value=>value.kind==='native-math').stores.captures.length,1);
});

test('valid queued course evidence uses its own operation receipt format and remains exportable',async()=>{
 reset();const supports=JSON.parse(readFileSync(new URL('./fixtures/course-task-support-v2.json',import.meta.url),'utf8'));
 const support=structuredClone(supports.cases.find(row=>row.valid&&row.mode==='recall').support);
 const body=quizBody({schemaVersion:2,learningSupport:support});body.practice={itemId:'question',abilityId:'concept',domain:'course',questionType:'recall',prompt:support.task.prompt,sourceLabel:'Synthetic course'};
 const item=await sealStudyItem(body),scope={userId:'a',libraryId:'library-a'};
 const runtime=await createNonWordRuntime({workspaceId:'account:a',ownerId:'a',libraryId:'library-a',snapshotId:'snapshot',itemKey:item.itemKey,contentHash:item.contentHash,groupId:'group',roundId:'round',cloud:false},'recall');await runtime.session.submit('ORIGINAL COURSE ANSWER');
 const original=runtime.session.snapshot();
 const repository=createLocalCourseEvidenceRepository(scope,{cloud:true,readAttempt:id=>runtime.repository.read(id),readItem:async()=>item});
 const task=resolveCourseTask(item),mutation={schemaVersion:1,operationId:'course-bind',attemptId:original.attemptId,binding:original.binding,expectedRevision:0,updatedAt:original.updatedAt,kind:'bind',taskId:task.taskId,taskHash:await courseTaskHash(task),parentAttemptId:null,parentEvidenceHash:null};
 assert.equal((await repository.mutate(mutation)).status,'accepted');
 const pack=await exportStudyRecovery('account:a');assert.equal(pack.complete,true);assert.deepEqual(pack.missingDependencies,[]);
 assert.equal(JSON.stringify(pack.payload).includes('course-bind'),true);
 let remote=null;
 for(let index=0;index<2;index++){const changed={...mutation,operationId:'remote-bind-'+index,expectedRevision:index};remote=applyCourseEvidenceMutation(remote,changed,await courseEvidenceFingerprint(changed)).evidence;}
 let calls=0;await repository.synchronize({read:async()=>remote,mutate:async sent=>{if(++calls>1)throw Error('synthetic offline after rebase');return {schemaVersion:1,status:'conflict',durable:false,operationId:sent.operationId,revision:remote.revision,evidence:remote};}});
 const queue=await repository.pending();assert.equal(queue[0].mutation.expectedRevision,2);
 const rebased=await exportStudyRecovery('account:a');assert.equal(rebased.complete,true);assert.deepEqual(rebased.missingDependencies,[]);
 const slice=structuredClone(rebased.payload.nonword);slice.databases.find(value=>value.kind==='attempts').stores.attempts=[];
 assert.ok(nonwordMissingDependencies(slice,[]).some(value=>value.startsWith('nonword-evidence-original:')));
});

test('unsupported key layout cannot silently omit owned persisted records',async()=>{
 reset();await new Promise((resolve,reject)=>{const request=indexedDB.open('zhixue-learning-attempts-v1',1);request.onupgradeneeded=()=>{for(const store of ['attempts','outbox','references'])request.result.createObjectStore(store);};request.onsuccess=()=>{request.result.close();resolve();};request.onerror=()=>reject(request.error);});
 await assert.rejects(exportStudyRecovery('account:a'),/storage-schema/);
});
