import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {openD1} from './helpers/sqlite-d1.mjs';
import {AccountStudyStore} from '../db/account-study-store.ts';
import {sealStudyItem,sealStudySnapshot,parseStudyItem,parseStudySnapshot} from '../app/account-study-content.ts';
import {quizBody,wordBody,snapshotBody} from './fixtures/account-study-fixtures.mjs';
import {D1LearningAttemptStore,createLocalAttemptRepository,createAccountAttemptClient,evaluationFingerprint} from '../src/infrastructure/learning-attempt/index.ts';
import {createAccountStudyApplication} from '../src/application/account-study/index.ts';
import {createAccountStudyHttpHandlers} from '../src/infrastructure/account-study/http.ts';
import {createNonWordPendingRuntime} from '../src/infrastructure/nonword-study/pending-runtime.ts';
globalThis.indexedDB=new IDBFactory();
let serial=0;
async function setup(t){
  const db=await openD1();t.after(()=>db.sqlite.close());const ownerId=`pending-owner-${serial++}`,libraryId='library-a',scope={userId:ownerId,libraryId};
  db.sqlite.prepare('INSERT INTO learning_accounts(user_id) VALUES (?)').run(ownerId);
  const study=new AccountStudyStore(db.binding),store=new D1LearningAttemptStore(db.binding),item=await sealStudyItem(quizBody()),other=await sealStudyItem(quizBody({itemKey:'second',practice:{...quizBody().practice,itemId:'second'}}));
  const snapshot=await sealStudySnapshot(snapshotBody([item,other]));await study.putSnapshot(scope,{snapshot,items:[item,other]},0);
  const binding={ownerId,libraryId,snapshotId:snapshot.snapshotId,itemKey:item.itemKey,contentHash:item.contentHash,groupId:'original-group',roundId:'old-round'};
  const base={schemaVersion:1,attemptId:'old-first',operationId:'draft',binding,expectedRevision:0,updatedAt:'2026-09-01T00:01:00.000Z'};
  const first=await store.mutate(scope,{...base,kind:'checkpoint',answer:'RAW ORIGINAL WORK',parentAttemptId:null,checkpoint:{mode:'quiz',purpose:'first',phase:'answering',position:0,traversed:false}});
  const row=(await store.mutate(scope,{...base,operationId:'submit',kind:'submit',expectedRevision:first.revision,answerRevision:first.attempt.answerRevision,assistance:'unknown'})).attempt;
  const repo=createLocalAttemptRepository(scope);await repo.hydrate(row);
  const reads=[],deps={enabled:true,getBrowserUser:async()=>({userId:ownerId}),getAccessStore:async()=>({profile:async()=>({libraryId,revision:1})}),getAttemptStore:async()=>store,
    getStudyStore:async()=>({getSnapshotItem:(...args)=>study.getSnapshotItem(...args),getSnapshot:(owner,id)=>{reads.push(id);return study.getSnapshot(owner,id);}})};
  const handlers=createAccountStudyHttpHandlers(deps),actions=[];
  const cloud=createAccountAttemptClient({ownerId,libraryId,fetcher:async(url,init)=>{actions.push(JSON.parse(init.body).action);return handlers.POST(new Request(new URL(url,'https://pending.invalid'),{...init,headers:{...init.headers,Origin:'https://pending.invalid'}}));}});
  const newer=await sealStudyItem(quizBody({practice:{...quizBody().practice,prompt:'NEW HEAD QUESTION',answer:1}}));
  await study.putSnapshot(scope,{snapshot:await sealStudySnapshot(snapshotBody([newer],{snapshotId:'new-head',revision:2})),items:[newer]},1);
  const create=extra=>createNonWordPendingRuntime({ownerId,libraryId,repository:repo,cloud,parseItem:parseStudyItem,parseSnapshot:parseStudySnapshot,...extra});
  return {...db,scope,ownerId,libraryId,study,store,item,snapshot,newer,row,repo,cloud,reads,deps,actions,create};
}
test('attempt-reference adds the full original snapshot header after the active head changed',async t=>{
  const f=await setup(t),app=createAccountStudyApplication(f.deps),reply=await app.post({action:'attempt-reference',attemptId:f.row.attemptId,libraryId:f.libraryId},{principal:{kind:'browser',userId:f.ownerId}},new AbortController().signal);
  assert.equal(reply.value.snapshot.snapshotId,f.snapshot.snapshotId);assert.equal(reply.value.snapshot.snapshotHash,f.snapshot.snapshotHash);assert.equal(reply.value.snapshot.items.length,2);
  assert.equal(reply.value.item.contentHash,f.item.contentHash);assert.notEqual(reply.value.item.contentHash,f.newer.contentHash);assert.deepEqual(f.reads,[f.snapshot.snapshotId]);
});
test('new referenceBundle and the unchanged old reference both use the original published member',async t=>{
  const f=await setup(t),bundle=await f.cloud.referenceBundle(f.row.attemptId);assert.equal(bundle.snapshot.snapshotId,f.snapshot.snapshotId);assert.equal(bundle.item.contentHash,f.item.contentHash);
  assert.deepEqual(await f.cloud.reference(f.row.attemptId),f.item);
});
test('pending runtime lists across day/source versions and loads only its bound original without mutations',async t=>{
  const f=await setup(t),before=await f.repo.read(f.row.attemptId),outbox=await f.repo.pending(),rows=f.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').all();
  const runtime=f.create();assert.deepEqual((await runtime.list()).map(row=>row.attemptId),[f.row.attemptId]);const original=await runtime.loadOriginal(f.row.attemptId);
  assert.equal(original.attempt.submitted.answer,'RAW ORIGINAL WORK');assert.equal(original.item.contentHash,f.item.contentHash);assert.equal(original.snapshot.snapshotId,f.snapshot.snapshotId);assert.equal(original.resumable,true);
  await runtime.list();await runtime.loadOriginal(f.row.attemptId);assert.deepEqual(await f.repo.read(f.row.attemptId),before);assert.deepEqual(await f.repo.pending(),outbox);assert.deepEqual(f.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').all(),rows);
  assert.equal(f.actions.includes('attempt-mutate'),false);assert.ok(f.reads.every(id=>id===f.snapshot.snapshotId));
});

test('old paused first drafts and guided parents remain discoverable across the learning-day boundary',async t=>{
  const f=await setup(t),draft=await f.store.read(f.scope,f.row.attemptId);
  const add=async(id,answer,checkpoint,parentAttemptId=null)=>f.store.mutate(f.scope,{schemaVersion:1,kind:'checkpoint',attemptId:id,operationId:`save-${id}`,binding:draft.binding,expectedRevision:0,updatedAt:'2026-10-05T19:59:00.000Z',answer,parentAttemptId,checkpoint:{mode:'quiz',purpose:'first',phase:'answering',position:0,traversed:false,...checkpoint}});
  await add('old-typed','Unsubmitted first answer.',{});
  await add('old-paused','',{view:{purpose:'first',lessonStep:'independent',paused:true,referenceSeen:false}});
  await add('guided-parent','',{intent:'lesson',view:{purpose:'guided',instanceId:'old-guided-instance',lessonStep:'guided',paused:true,referenceSeen:true}});
  await add('empty-unpaused','',{});await add('guide-only','Guided answer.',{purpose:'guided'});await add('child-draft','Child answer.',{purpose:'remediation'},f.row.attemptId);await add('nw-round:old-anchor','',{mode:'lesson',purpose:'guided'});
  const empty=()=>Promise.resolve(null),runtime=f.create({repository:{list:async()=>[],read:empty}}),before=f.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').all();
  assert.deepEqual((await runtime.list()).map(row=>row.attemptId).sort(),['guided-parent','old-first','old-paused','old-typed']);
  const original=await runtime.loadOriginal('guided-parent');assert.equal(original.attempt.submitted,null);assert.equal(original.attempt.checkpoint.view.instanceId,'old-guided-instance');assert.equal(original.snapshot.snapshotId,f.snapshot.snapshotId);assert.equal(original.resumable,true);
  assert.deepEqual(f.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').all(),before);assert.equal(f.actions.includes('attempt-mutate'),false);
});
test('known conflict and local outbox preserve the local original instead of a newer remote response',async t=>{
  const f=await setup(t),local=structuredClone(f.row),remote=structuredClone(f.row);remote.revision+=5;remote.submitted.answer='MUST NOT REPLACE RAW';
  let mutations=0;const repository={list:async()=>[local,local],read:async()=>local,status:async()=> 'cloud-conflict',pending:async()=>[{mutation:{attemptId:local.attemptId}}],reference:async()=>f.item,mutate:async()=>mutations++};
  const runtime=f.create({repository,cloud:{...f.cloud,list:async()=>[remote,remote],read:async()=>remote,mutate:async()=>mutations++}});
  assert.deepEqual((await runtime.list()).map(row=>row.submitted.answer),['RAW ORIGINAL WORK']);const loaded=await runtime.loadOriginal(local.attemptId);
  assert.equal(loaded.attempt.submitted.answer,'RAW ORIGINAL WORK');assert.equal(loaded.resumable,false);assert.equal(loaded.capability,'conflict');assert.equal(mutations,0);
});

test('latest publication reads reject known conflicts and never use a cached queue row as a durable readback',async t=>{
  const f=await setup(t),remote=structuredClone(f.row);remote.submitted.answer='OTHER DEVICE ANSWER';remote.revision++;
  const conflict=f.create({cloud:{...f.cloud,read:async()=>remote}});assert.equal((await conflict.loadOriginal(f.row.attemptId)).capability,'conflict');await assert.rejects(conflict.readLatest(f.row.attemptId),/冲突/);
  const missing=f.create({repository:{list:async()=>[f.row],read:async()=>null,pending:async()=>[]},cloud:{...f.cloud,read:async()=>null}});await missing.list();assert.equal((await missing.loadOriginal(f.row.attemptId)).attempt.attemptId,f.row.attemptId);await assert.rejects(missing.readLatest(f.row.attemptId),/unavailable/);
});
test('first pending, unlinked and unfinished rows survive; guides, children, anchors, words and linked rows do not',async t=>{
  const f=await setup(t),word=await sealStudyItem(wordBody()),rows=[];
  function add(id,change){const row=structuredClone(f.row);row.attemptId=id;Object.assign(row,change);rows.push(row);return row;}
  add('pending',{});const evaluation={status:'resolved',rating:'good',correct:true,outcome:'correct',source:'deterministic',feedback:'Existing result.',referenceHash:f.item.contentHash};evaluation.evaluationHash=await evaluationFingerprint(evaluation);
  add('unlinked',{evaluation,formal:null});add('linked',{evaluation,formal:{status:'linked'}});add('draft',{submitted:null});add('guide',{checkpoint:{...f.row.checkpoint,purpose:'guided'}});
  add('child',{parentAttemptId:'pending',checkpoint:{...f.row.checkpoint,purpose:'remediation'}});add('nw-round:anchor',{checkpoint:{...f.row.checkpoint,mode:'lesson',purpose:'guided'}});
  add('word',{binding:{...f.row.binding,itemKey:word.itemKey,contentHash:word.contentHash},checkpoint:{...f.row.checkpoint,mode:'flashcard'}});
  add('foreign-owner',{binding:{...f.row.binding,ownerId:'another'}});add('foreign-library',{binding:{...f.row.binding,libraryId:'another'}});
  const runtime=f.create({cloud:null,repository:{list:async()=>rows,read:async id=>rows.find(row=>row.attemptId===id)??null,pending:async()=>[],reference:async id=>id==='word'?word:f.item}});
  assert.deepEqual((await runtime.list()).map(row=>row.attemptId).sort(),['draft','pending','unlinked']);await assert.rejects(runtime.loadOriginal('foreign-owner'),/scope/);
});
test('a cached native original stays displayable offline; an uncached original preserves raw work without a substitute',async t=>{
  const f=await setup(t);await f.repo.rememberReference(f.row.attemptId,f.item);
  const native=f.create({cloud:null}),known=await native.loadOriginal(f.row.attemptId);assert.equal(known.item.contentHash,f.item.contentHash);assert.equal(known.resumable,true);
  const offline=f.create({repository:{list:()=>f.repo.list(),read:id=>f.repo.read(id),pending:()=>f.repo.pending(),reference:async()=>null},cloud:{list:async()=>{throw Error('offline');},read:async()=>{throw Error('offline');},referenceBundle:async()=>{throw Error('offline');}}});
  assert.equal((await offline.list())[0].submitted.answer,'RAW ORIGINAL WORK');const unknown=await offline.loadOriginal(f.row.attemptId);assert.equal(unknown.attempt.submitted.answer,'RAW ORIGINAL WORK');assert.equal(unknown.item,null);assert.equal(unknown.resumable,false);
});
test('old servers lacking snapshot headers retain item-only capability and cannot borrow a current head',async t=>{
  const f=await setup(t),old=createAccountAttemptClient({ownerId:f.ownerId,libraryId:f.libraryId,fetcher:async(_url,init)=>{
    const action=JSON.parse(init.body).action;return new Response(JSON.stringify(action==='attempt-reference'?{item:f.item}:action==='attempt-list'?{attempts:[f.row]}:{attempt:f.row}),{status:200,headers:{'Content-Type':'application/json'}});
  }});
  assert.deepEqual(await old.reference(f.row.attemptId),f.item);const runtime=f.create({cloud:old}),loaded=await runtime.loadOriginal(f.row.attemptId);
  assert.equal(loaded.item.contentHash,f.item.contentHash);assert.equal(loaded.snapshot,undefined);assert.equal(loaded.capability,'item-only');assert.equal(loaded.resumable,false);assert.equal(loaded.attempt.submitted.answer,'RAW ORIGINAL WORK');
});
for(const mismatch of ['item-hash','snapshot-id','library','member','snapshot-hash'])test(`substituted ${mismatch} cannot replace the pending original`,async t=>{
  const f=await setup(t);let item=f.item,snapshot=f.snapshot;
  if(mismatch==='item-hash')item=f.newer;
  if(mismatch==='snapshot-id')snapshot=await sealStudySnapshot(snapshotBody([f.item],{snapshotId:'different-original'}));
  if(mismatch==='library')snapshot=await sealStudySnapshot(snapshotBody([f.item],{libraryId:'foreign-library'}));
  if(mismatch==='member')snapshot=await sealStudySnapshot(snapshotBody([f.newer]));
  if(mismatch==='snapshot-hash')snapshot={...f.snapshot,revision:2};
  const cloud={...f.cloud,referenceBundle:async()=>({item,snapshot})},loaded=await f.create({cloud}).loadOriginal(f.row.attemptId);
  assert.equal(loaded.attempt.submitted.answer,'RAW ORIGINAL WORK');assert.equal(loaded.item,null);assert.equal(loaded.resumable,false);assert.equal(loaded.capability,'reference-unavailable');
});
test('unsupported cloud actions keep local owned raw answers and an explicit capability limitation',async t=>{
  const f=await setup(t),old=createAccountAttemptClient({ownerId:f.ownerId,libraryId:f.libraryId,fetcher:async()=>new Response(JSON.stringify({error:'unsupported-action'}),{status:409,headers:{'Content-Type':'application/json'}})});
  const runtime=f.create({cloud:old});assert.equal((await runtime.list())[0].submitted.answer,'RAW ORIGINAL WORK');const loaded=await runtime.loadOriginal(f.row.attemptId);
  assert.equal(loaded.attempt.submitted.answer,'RAW ORIGINAL WORK');assert.equal(loaded.resumable,false);assert.match(loaded.notice,/不支持|未提供/);
});
test('an outbox alone prevents a remote linked result from hiding the local pending answer',async t=>{
  const f=await setup(t),local=structuredClone(f.row),remote=structuredClone(f.row);remote.revision+=4;remote.evaluation={status:'resolved'};remote.formal={status:'linked'};
  const repository={list:async()=>[local],read:async()=>local,status:async()=> 'device-only',pending:async()=>[{mutation:{attemptId:local.attemptId}}],reference:async()=>null};
  const runtime=f.create({repository,cloud:{...f.cloud,list:async()=>[remote],read:async()=>remote}});
  assert.equal((await runtime.list())[0].evaluation.status,'pending');assert.equal((await runtime.loadOriginal(local.attemptId)).attempt.submitted.answer,'RAW ORIGINAL WORK');
});
test('a verified source that is a word is excluded even when it is available only from the cloud',async t=>{
  const f=await setup(t),item=await sealStudyItem(wordBody()),snapshot=await sealStudySnapshot(snapshotBody([item]));
  const row={...f.row,attemptId:'word-only',binding:{...f.row.binding,itemKey:item.itemKey,contentHash:item.contentHash},checkpoint:{...f.row.checkpoint,mode:'flashcard'}};
  const runtime=f.create({repository:{list:async()=>[],read:async()=>null},cloud:{list:async()=>[row],read:async()=>row,referenceBundle:async()=>({item,snapshot})}});
  assert.deepEqual(await runtime.list(),[]);const original=await runtime.loadOriginal(row.attemptId);assert.equal(original.capability,'not-nonword');assert.equal(original.resumable,false);assert.equal(original.item,null);
});
test('malformed remote list rows cannot discard local owned work',async t=>{
  const f=await setup(t),runtime=f.create({cloud:{...f.cloud,list:async()=>[null,{}, {schemaVersion:1},f.row]}});
  assert.deepEqual((await runtime.list()).map(row=>row.attemptId),[f.row.attemptId]);
  const broken=f.create({cloud:{...f.cloud,list:async()=>({wrong:'shape'})}});assert.equal((await broken.list())[0].submitted.answer,'RAW ORIGINAL WORK');
});
test('only an external verified status reconciliation clears a previously known conflict',async t=>{
  const f=await setup(t);let status='cloud-conflict';const repository={list:async()=>[f.row],read:async()=>f.row,status:async()=>status,pending:async()=>[],reference:async()=>null};
  const runtime=f.create({repository});assert.equal((await runtime.loadOriginal(f.row.attemptId)).capability,'conflict');status='cloud-acked';
  assert.equal((await runtime.loadOriginal(f.row.attemptId)).resumable,true);assert.equal(f.row.submitted.answer,'RAW ORIGINAL WORK');
});
test('a real IndexedDB outbox remains byte-for-byte pending during repeated read-only recovery',async t=>{
  const f=await setup(t);
  await f.repo.mutate({schemaVersion:1,attemptId:f.row.attemptId,operationId:'local-pending',binding:f.row.binding,expectedRevision:f.row.revision,updatedAt:'2026-10-06T00:00:00.000Z',
    kind:'evaluate',answerRevision:f.row.answerRevision,evaluation:{status:'pending',reason:'offline'}});
  const before=await f.repo.pending(),original=await f.repo.read(f.row.attemptId),runtime=f.create();assert.equal(before.length,1);
  await runtime.list();await runtime.loadOriginal(f.row.attemptId);await runtime.list();
  assert.deepEqual(await f.repo.pending(),before);assert.deepEqual(await f.repo.read(f.row.attemptId),original);
  assert.equal((await f.store.read(f.scope,f.row.attemptId)).revision,f.row.revision);assert.equal(f.actions.includes('attempt-mutate'),false);
});
test('a verified word stays outside the nonword queue even when its existing outbox has a known conflict',async t=>{
  const f=await setup(t),item=await sealStudyItem(wordBody()),row={...f.row,attemptId:'word-conflict',binding:{...f.row.binding,itemKey:item.itemKey,contentHash:item.contentHash},checkpoint:{...f.row.checkpoint,mode:'flashcard'}};
  const runtime=f.create({cloud:null,repository:{list:async()=>[row],read:async()=>row,status:async()=> 'cloud-conflict',pending:async()=>[{mutation:{attemptId:row.attemptId}}],reference:async()=>item}});
  assert.deepEqual(await runtime.list(),[]);assert.equal((await runtime.loadOriginal(row.attemptId)).capability,'not-nonword');assert.equal(row.submitted.answer,'RAW ORIGINAL WORK');
});
