// Active-writer fixtures use today's clock: receipt SQL checks expiry against SQLite 'now'.
import assert from 'node:assert/strict';
import test from 'node:test';
import {openD1} from './helpers/sqlite-d1.mjs';
import {vocabularyInput} from './fixtures/task-plan-input.mjs';
import {generateTaskPlan} from '../app/task-plan-engine.ts';
import {sealStudyItem,sealStudySnapshot,studyHash} from '../app/account-study-content.ts';
import {wordBody,snapshotBody} from './fixtures/account-study-fixtures.mjs';
import {toCloudPlanningCatalog,toEnginePlanningCatalog,sealCloudTaskPlan,sealCloudPlanningFacts} from '../app/account-study-planning.ts';
import {AccountStudyStore} from '../db/account-study-store.ts';
import {AccountStudyAccessStore} from '../db/account-study-access-store.ts';
import {createHash} from 'node:crypto';
let Store;
try {({AccountStudyPlanStore:Store}=await import('../db/account-study-plan-store.ts'));}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
async function setup(t,userId='user-a'){
  assert.equal(typeof Store,'function','Shared plan CAS store must exist');const {sqlite,binding}=await openD1();t.after(()=>sqlite.close());
  const store=new Store(binding),scope={userId,libraryId:'library-a'};
  await binding.prepare('INSERT INTO learning_accounts(user_id) VALUES (?)').bind(userId).run();
  const input=vocabularyInput(20),items=await Promise.all(input.catalog.subjects[0].words.map(w=>sealStudyItem(wordBody({itemKey:w.itemKey,title:w.word,
    word:{...wordBody().word,word:w.word,example:`${w.word} appears.`}}))));
  const snapshot=await sealStudySnapshot(snapshotBody(items)),bundle={snapshot,items},study=new AccountStudyStore(binding);
  await study.beginSnapshot(scope,snapshot);for(let position=0;position<items.length;position+=20)await study.stageSnapshotItems(scope,snapshot.snapshotId,items.slice(position,position+20).map((item,index)=>({position:position+index,item})));
  await study.completeSnapshot(scope,snapshot.snapshotId,0);
  const {catalog}=await toCloudPlanningCatalog(input.catalog,bundle);await store.putCatalog(scope,catalog);
  const facts=await sealCloudPlanningFacts({schemaVersion:1,libraryId:'library-a',snapshotId:snapshot.snapshotId,catalogHash:catalog.catalogHash,observedAt:'2026-09-01T00:00:00.000Z',nativePlanRevision:0,sourceReviews:[],captureReviews:[],legacyEvents:[],legacyTaskEvents:[],contentCandidates:[],historyComplete:true});await store.putFacts(scope,facts);
  const engine=await toEnginePlanningCatalog(catalog),words=engine.subjects[0].words.map(w=>({lexemeKey:`en:${w.word}`,itemKeys:[w.itemKey],status:'unseen'}));
  const plan=await generateTaskPlan({day:'2026-08-31',catalog:engine,words,reviews:[],completions:[],previous:null});
  return {sqlite,binding,store,scope,catalog,facts,plan:await sealCloudTaskPlan(plan,catalog,{baseRevision:0,factsHash:facts.factsHash,eventThrough:0,taskThrough:0,nativeBaseRevision:0})};
}
test('catalog is scoped immutable and never contains local paths',async t=>{
  const {store,scope,catalog}=await setup(t);assert.deepEqual(await store.getCatalog(scope,catalog.snapshotId),catalog);
  assert.equal(await store.getCatalog({userId:'user-b',libraryId:'library-a'},catalog.snapshotId),null);
  const other={...catalog,libraryId:'other-library'};delete other.catalogHash;other.catalogHash=await studyHash(other);
  await assert.rejects(store.putCatalog(scope,other),/scope/);
  const changed=structuredClone(catalog);changed.catalogHash='f'.repeat(64);await assert.rejects(store.putCatalog(scope,changed),/integrity/);
});
test('save is revision-CAS and lost response retry is idempotent',async t=>{
  const {store,scope,plan}=await setup(t),input={action:'save',operationId:'operation-save-one',expectedRevision:0,plan};
  const first=await store.mutate(scope,input);assert.equal(first.state.revision,1);assert.equal(first.status,'accepted');
  const retry=await store.mutate(scope,input);assert.equal(retry.status,'duplicate');assert.equal(retry.state.revision,1);
  await assert.rejects(store.mutate(scope,{...input,plan:{...plan,cloudPlanHash:'f'.repeat(64)}}),/operation-conflict|integrity/);
});
test('concurrent different drafts cannot both win one expected revision',async t=>{
  const {store,scope,plan}=await setup(t);const another={...plan,baseRevision:0};
  const results=await Promise.all([store.mutate(scope,{action:'save',operationId:'operation-left',expectedRevision:0,plan}),
    store.mutate(scope,{action:'save',operationId:'operation-right',expectedRevision:0,plan:another})]);
  assert.deepEqual(results.map(r=>r.status).sort(),['accepted','stale']);assert.equal((await store.getState(scope,plan.day)).revision,1);
});
test('approve/reject/cancel keep draft and approved pointer distinct',async t=>{
  const {store,scope,plan}=await setup(t);await store.mutate(scope,{action:'save',operationId:'save-one',expectedRevision:0,plan});
  let result=await store.mutate(scope,{action:'approve',operationId:'approve-one',expectedRevision:1,day:plan.day,planHash:plan.cloudPlanHash,predecessorOperationId:null});
  assert.equal(result.state.approvedPlan.cloudPlanHash,plan.cloudPlanHash);assert.equal(result.state.decision,'approved');
  result=await store.mutate(scope,{action:'reject',operationId:'reject-one',expectedRevision:2,day:plan.day,planHash:plan.cloudPlanHash});
  assert.equal(result.state.approvedPlan.cloudPlanHash,plan.cloudPlanHash);assert.equal(result.state.currentPlan.cloudPlanHash,plan.cloudPlanHash);assert.equal(result.state.decision,'rejected');
  result=await store.mutate(scope,{action:'cancel',operationId:'cancel-one',expectedRevision:3,day:plan.day,targetOperationId:'approve-one'});
  assert.equal(result.state.currentPlan.cloudPlanHash,plan.cloudPlanHash);assert.equal(result.state.approvedPlan,null);assert.equal(result.state.approvedOperationId,null);assert.equal(result.state.decision,'cancelled');
});
test('approval requires current exact candidate and save requires matching base revision',async t=>{
  const {store,scope,plan}=await setup(t);
  const bad={...plan,baseRevision:2};delete bad.cloudPlanHash;bad.cloudPlanHash=await studyHash(bad);
  await assert.rejects(store.mutate(scope,{action:'save',operationId:'bad-base',expectedRevision:0,plan:bad}),/base-revision/);
  await assert.rejects(store.mutate(scope,{action:'approve',operationId:'approve-none',expectedRevision:0,day:plan.day,planHash:plan.cloudPlanHash,predecessorOperationId:null}),/current-plan/);
});
test('restore copies historical approved content into a new monotonic revision',async t=>{
  const {store,scope,plan}=await setup(t);await store.mutate(scope,{action:'save',operationId:'save-one',expectedRevision:0,plan});
  await store.mutate(scope,{action:'approve',operationId:'approve-one',expectedRevision:1,day:plan.day,planHash:plan.cloudPlanHash,predecessorOperationId:null});
  await store.mutate(scope,{action:'cancel',operationId:'cancel-one',expectedRevision:2,day:plan.day,targetOperationId:'approve-one'});
  const result=await store.mutate(scope,{action:'restore',operationId:'restore-one',expectedRevision:3,day:plan.day,targetOperationId:'approve-one',predecessorOperationId:null});
  assert.equal(result.state.revision,4);assert.equal(result.state.currentPlan.cloudPlanHash,plan.cloudPlanHash);assert.equal(result.state.approvedPlan.cloudPlanHash,plan.cloudPlanHash);
});
test('account/day ownership is server-selected, not mutation body data',async t=>{
  const {store,scope,plan}=await setup(t);await assert.rejects(store.mutate(scope,{action:'save',operationId:'owner-forge',expectedRevision:0,plan,userId:'user-b'}),/field/);
  assert.equal((await store.getState({userId:'user-b',libraryId:'library-a'},plan.day)).revision,0);
});
test('approved operations paginate and only active writer can attest local execution',async t=>{
  const {store,scope,plan,binding}=await setup(t);await store.mutate(scope,{action:'save',operationId:'exec-save',expectedRevision:0,plan});
  await store.mutate(scope,{action:'approve',operationId:'exec-approve',expectedRevision:1,day:plan.day,planHash:plan.cloudPlanHash,predecessorOperationId:null});
  const page=await store.listOperations(scope,0,1);assert.equal(page.operations[0].operationId,'exec-save');assert.ok(page.nextCursor);
  const last=await store.listOperations(scope,page.nextCursor,1,page.through);assert.equal(last.operations[0].operationId,'exec-approve');assert.equal(last.nextCursor,null);
  const receipt={schemaVersion:1,receiptId:'execution-receipt-one',operationId:'exec-approve',cloudPlanHash:plan.cloudPlanHash,status:'applied',
    proof:{cloudPlanHash:plan.cloudPlanHash,nativePlanHash:'e'.repeat(64),localRevision:1,proofHash:'f'.repeat(64),targetCount:1}};
  await assert.rejects(store.appendExecution(scope,receipt,'grant-one'),/writer/);
  const secret=Buffer.alloc(32,9).toString('base64url'),access=new AccountStudyAccessStore(binding);
  await access.register('user-a',{grantId:'grant-one',libraryId:'library-a',tokenHash:createHash('sha256').update(secret).digest('hex'),label:'Desktop',expectedProfileRevision:0,replaceLibrary:false});await access.activate(secret);
  assert.equal((await store.claimExecution(scope,'exec-approve','grant-one')).status,'accepted');
  await assert.rejects(store.mutate(scope,{action:'cancel',operationId:'cancel-claimed',expectedRevision:2,day:plan.day,targetOperationId:'exec-approve'}),/in-flight/);
  const accepted=await store.appendExecution(scope,receipt,'grant-one');assert.equal(accepted.status,'accepted');assert.equal(accepted.execution.receipt.proof.localRevision,1);
  await assert.rejects(store.mutate(scope,{action:'cancel',operationId:'cancel-completed',expectedRevision:2,day:plan.day,targetOperationId:'exec-approve'}),/in-flight/);
  assert.equal((await store.appendExecution(scope,receipt,'grant-one')).status,'duplicate');
  const sameProof=await store.appendExecution(scope,{...receipt,receiptId:'execution-receipt-same-proof'},'grant-one');assert.equal(sameProof.status,'duplicate');
  const changedProof=await store.appendExecution(scope,{...receipt,receiptId:'execution-receipt-conflict',proof:{...receipt.proof,nativePlanHash:'a'.repeat(64),proofHash:'b'.repeat(64)}},'grant-one');assert.equal(changedProof.status,'conflict');assert.equal(changedProof.execution.receipt.receiptId,'execution-receipt-one');
  assert.equal((await store.appendExecution(scope,{...receipt,receiptId:'execution-receipt-two',proof:{...receipt.proof,localRevision:3}},'grant-one')).status,'conflict');
});
