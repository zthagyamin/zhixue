import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {openD1} from './helpers/sqlite-d1.mjs';
import {AccountStudyAccessStore} from '../db/account-study-access-store.ts';
import {AccountStudyStore} from '../db/account-study-store.ts';
import {AccountStudyPlanStore} from '../db/account-study-plan-store.ts';
import {createAccountStudyHandlers} from '../app/account-study-api.ts';
import {sealStudySnapshot,sealStudyItem} from '../app/account-study-content.ts';
import {sealStudyRecord} from '../app/account-study-record.ts';
import {toCloudPlanningCatalog,sealCloudPlanningFacts} from '../app/account-study-planning.ts';
import {snapshotBody,wordBody,recordBody} from './fixtures/account-study-fixtures.mjs';
import {vocabularyInput} from './fixtures/task-plan-input.mjs';
import {attempt} from './fixtures/task-event-fixtures.mjs';

const syntheticSecret=Buffer.alloc(32,19).toString('base64url');
async function fixture(t){
 const base=await storageFixture(t),{access,study}=base;
 let observed;const authenticated=new Promise(resolve=>{observed=resolve;});
 const traced={authenticate:async secret=>{const principal=await access.authenticate(secret);observed();return principal;},
  profile:access.profile.bind(access),register:access.register.bind(access),activate:access.activate.bind(access),revoke:access.revoke.bind(access)};
 const unused=async()=>{throw Error('unused fixture dependency');};
 const handlers=createAccountStudyHandlers({enabled:true,getBrowserUser:async()=>null,getAccessStore:async()=>traced,getStudyStore:async()=>study,
  getReceiptStore:unused,getPlanStore:unused,getAiStore:unused,getContentDecisionStore:unused,
  getPlanAi:unused,getQuestionAi:unused,getPlanAiTrace:()=>({}),getQuestionAiTrace:()=>({})});
 const snapshot=await sealStudySnapshot(snapshotBody([]));let release;
 const body=new ReadableStream({start(controller){release=()=>{controller.enqueue(new TextEncoder().encode(JSON.stringify({action:'begin-snapshot',snapshot})));controller.close();};}},{highWaterMark:0});
 const request=new Request('https://study.example.test/api/account-study',{method:'POST',headers:{Authorization:`Bearer ${syntheticSecret}`,'Content-Type':'application/json'},body,duplex:'half'});
 return{...base,snapshot,authenticated,release:()=>release(),pending:handlers.POST(request)};
}

async function storageFixture(t){
 const {sqlite,binding}=await openD1();t.after(()=>sqlite.close());
 const access=new AccountStudyAccessStore(binding),study=new AccountStudyStore(binding);
 await access.register('user-a',{grantId:'grant-a',libraryId:'library-a',tokenHash:createHash('sha256').update(syntheticSecret).digest('hex'),
  label:'Synthetic fixture',expectedProfileRevision:0,replaceLibrary:false});
 await access.activate(syntheticSecret);
 return{sqlite,binding,access,study,plans:new AccountStudyPlanStore(binding),scope:{userId:'user-a',libraryId:'library-a'}};
}

async function changeQualification(f,change){
 if(change==='revoke')await f.access.revoke('user-a','grant-a');
 if(change==='expire')f.sqlite.prepare("UPDATE account_study_grants SET expires_at='2000-01-01T00:00:00.000Z' WHERE grant_id='grant-a'").run();
 if(change==='replace-library'){
  const replacement=Buffer.alloc(32,23).toString('base64url');
  await f.access.register('user-a',{grantId:'grant-b',libraryId:'library-b',tokenHash:createHash('sha256').update(replacement).digest('hex'),
   label:'Synthetic replacement',expectedProfileRevision:1,replaceLibrary:true});
  await f.access.activate(replacement);
 }
}

function storedLearningState(sqlite){
 const tables=['account_study_snapshots','account_study_heads','account_study_manifest_pages','account_study_item_versions',
  'account_study_snapshot_members','account_study_records','account_study_planning_catalogs','account_study_planning_facts'];
 return Object.fromEntries(tables.map(table=>[table,sqlite.prepare(`SELECT * FROM ${table}`).all()]));
}

async function prepareMutation(f,kind){
 const input=vocabularyInput(1),word=input.catalog.subjects[0].words[0];
 const item=await sealStudyItem(wordBody({itemKey:word.itemKey,title:word.word,word:{...wordBody().word,word:word.word}}));
 const snapshot=await sealStudySnapshot(snapshotBody([item]));
 await f.study.beginSnapshot(f.scope,snapshot,'grant-a');
 if(kind==='stage')return()=>f.study.stageSnapshotItems(f.scope,snapshot.snapshotId,[{position:0,item}],'grant-a');
 await f.study.stageSnapshotItems(f.scope,snapshot.snapshotId,[{position:0,item}],'grant-a');
 if(kind==='complete')return()=>f.study.completeSnapshot(f.scope,snapshot.snapshotId,0,'grant-a');
 await f.study.completeSnapshot(f.scope,snapshot.snapshotId,0,'grant-a');
 if(kind==='record'){
  const record=await sealStudyRecord(await recordBody({contentHash:item.contentHash,event:await attempt('event-write-qualification','2026-09-01T00:01:00Z',0,1,true,{item:{kind:'word',key:item.itemKey}})}));
  return()=>f.study.appendRecord(f.scope,record,'grant-a');
 }
 const {catalog}=await toCloudPlanningCatalog(input.catalog,{snapshot,items:[item]});
 if(kind==='catalog')return()=>f.plans.putCatalog(f.scope,catalog,'grant-a');
 await f.plans.putCatalog(f.scope,catalog,'grant-a');
 const facts=await sealCloudPlanningFacts({schemaVersion:1,libraryId:'library-a',snapshotId:snapshot.snapshotId,catalogHash:catalog.catalogHash,
  observedAt:'2026-09-01T00:00:00.000Z',nativePlanRevision:0,sourceReviews:[],captureReviews:[],legacyEvents:[],legacyTaskEvents:[],contentCandidates:[],historyComplete:true});
 return()=>f.plans.putFacts(f.scope,facts,'grant-a');
}

for(const kind of ['stage','complete','record','catalog','facts']){
 for(const change of ['revoke','expire','replace-library']){
  test(`${kind} write preserves all learning rows when ${change} occurs at its committing operation`,async t=>{
   const f=await storageFixture(t),run=await prepareMutation(f,kind),before=storedLearningState(f.sqlite);
   let armed=true;const batch=f.binding.batch.bind(f.binding),prepare=f.binding.prepare.bind(f.binding);
   const intervene=async()=>{if(armed){armed=false;await changeQualification(f,change);}};
   f.binding.batch=async statements=>{await intervene();return batch(statements);};
   const wrap=statement=>new Proxy(statement,{get(target,key){
    if(key==='bind')return(...args)=>wrap(target.bind(...args));
    if((key==='run'||key==='all')&&/^(INSERT|UPDATE)/.test(target.query))return async(...args)=>{await intervene();return target[key](...args);};
    return Reflect.get(target,key);
   }});
   f.binding.prepare=query=>wrap(prepare(query));
   await assert.rejects(run(),/study-writer-required/);
   assert.equal(armed,false,'must reach the committing write, not fail only an earlier check');
   assert.deepEqual(storedLearningState(f.sqlite),before);
  });
 }
}

for(const change of ['revoke','expire','replace-library']){
 test(`device write refuses ${change} after initial authentication and before its body is released`,async t=>{
  const f=await fixture(t);await f.authenticated;
  await changeQualification(f,change);
  f.release();const response=await f.pending;
  t.diagnostic(JSON.stringify({change,status:response.status,
   snapshots:f.sqlite.prepare('SELECT count(*) AS n FROM account_study_snapshots').get().n,
   heads:f.sqlite.prepare('SELECT count(*) AS n FROM account_study_heads').get().n}));
  assert.equal(response.status,403);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM account_study_snapshots').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM account_study_heads').get().n,0);
 });
 test(`device commit refuses ${change} after request validation and immediately before the database batch`,async t=>{
  const f=await fixture(t);await f.authenticated;
  const batch=f.binding.batch.bind(f.binding);let armed=true;
  f.binding.batch=async statements=>{
   if(armed){armed=false;await changeQualification(f,change);}
   return batch(statements);
  };
  f.release();const response=await f.pending;
  const snapshots=f.sqlite.prepare('SELECT count(*) AS n FROM account_study_snapshots').get().n;
  const heads=f.sqlite.prepare('SELECT count(*) AS n FROM account_study_heads').get().n;
  t.diagnostic(JSON.stringify({window:'commit',change,status:response.status,snapshots,heads}));
  assert.equal(response.status,403);assert.equal(snapshots,0);assert.equal(heads,0);
 });
}
