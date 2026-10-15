import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {openD1} from './helpers/sqlite-d1.mjs';
import {AccountStudyAccessStore} from '../db/account-study-access-store.ts';
import {AccountStudyStore} from '../db/account-study-store.ts';
import {D1LearningAttemptStore} from '../src/infrastructure/learning-attempt/index.ts';
import {createAccountStudyHttpHandlers} from '../src/infrastructure/account-study/http.ts';
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';
import {quizBody,snapshotBody} from './fixtures/account-study-fixtures.mjs';

const origin='https://study.example.test',scope={userId:'user-a',libraryId:'library-a'};
const secret=Buffer.alloc(32,37).toString('base64url');
const registration=(token=secret,overrides={})=>({grantId:'reply-writer',libraryId:scope.libraryId,
 tokenHash:createHash('sha256').update(token).digest('hex'),label:'Synthetic reply boundary',expectedProfileRevision:0,replaceLibrary:false,...overrides});
async function setup(t,{pending=false,clock}={}){
 const db=await openD1();t.after(()=>db.sqlite.close());
 const access=new AccountStudyAccessStore(db.binding,clock),study=new AccountStudyStore(db.binding),store=new D1LearningAttemptStore(db.binding);
 await access.register(scope.userId,registration());if(!pending)await access.activate(secret);
 const item=await sealStudyItem(quizBody()),snapshot=await sealStudySnapshot(snapshotBody([item]));
 await study.putSnapshot(scope,{snapshot,items:[item]},0);
 const checkpoint={schemaVersion:1,attemptId:'reply-attempt',operationId:'reply-checkpoint',
  binding:{ownerId:scope.userId,libraryId:scope.libraryId,snapshotId:snapshot.snapshotId,itemKey:item.itemKey,contentHash:item.contentHash,groupId:'group-a',roundId:'round-a'},
  expectedRevision:0,updatedAt:'2026-09-01T00:01:00.000Z',kind:'checkpoint',answer:'Synthetic private answer',parentAttemptId:null,
  checkpoint:{phase:'answering',position:0,traversed:false,mode:'quiz'}};
 const handlers=createAccountStudyHttpHandlers({enabled:true,getBrowserUser:async()=>null,
  getAccessStore:async()=>access,getStudyStore:async()=>study,getAttemptStore:async()=>store});
 const request=(action,body={})=>new Request(origin+'/api/account-study',{method:'POST',
  headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify({action,...body})});
 const rows=()=>db.sqlite.prepare('SELECT * FROM learning_attempts_v1').all();
 const change=async kind=>{
  if(kind==='revoke')await access.revoke(scope.userId,'reply-writer');
  if(kind==='expire')db.sqlite.prepare("UPDATE account_study_grants SET expires_at='2000-01-01T00:00:00.000Z' WHERE grant_id='reply-writer'").run();
  if(kind==='replace-library'){
   const replacement=Buffer.alloc(32,41).toString('base64url'),profile=await access.profile(scope.userId);
   await access.register(scope.userId,registration(replacement,{grantId:'reply-replacement',libraryId:'library-b',expectedProfileRevision:profile.revision,replaceLibrary:true}));
   await access.activate(replacement);
  }
 };
 return{...db,access,study,store,checkpoint,handlers,request,rows,change};
}

for(const mode of ['duplicate','conflict'])for(const change of ['revoke','expire','replace-library']){
 test(`device ${mode} reply rejects ${change} after its stored answer is read`,async t=>{
  const f=await setup(t);assert.equal((await f.store.mutate(scope,f.checkpoint)).durable,true);
  const before=f.rows(),read=f.store.read.bind(f.store);let reached=false;
  f.store.read=async(...args)=>{const row=await read(...args);if(!reached){reached=true;await f.change(change);}return row;};
  const mutation=mode==='duplicate'?f.checkpoint:{...f.checkpoint,answer:'Different synthetic answer'};
  const response=await f.handlers.POST(f.request('attempt-mutate',{mutation}));
  assert.equal(reached,true);assert.equal(response.status,403);
  assert.deepEqual(await response.json(),{error:'study-writer-required'});
  assert.equal(response.headers.get('Cache-Control'),'no-store');assert.deepEqual(f.rows(),before);
 });
}

for(const mode of ['post-read','get-bootstrap'])for(const change of ['revoke','expire','replace-library']){
 test(`device ${mode} rejects ${change} during the actual read`,async t=>{
  const f=await setup(t);await f.store.mutate(scope,f.checkpoint);const before=f.rows();let reached=false;
  const target=mode==='post-read'?f.store:f.study,method=mode==='post-read'?'read':'getSnapshot',original=target[method].bind(target);
  target[method]=async(...args)=>{const row=await original(...args);if(!reached){reached=true;await f.change(change);}return row;};
  const response=mode==='post-read'?await f.handlers.POST(f.request('attempt-read',{attemptId:f.checkpoint.attemptId})):
   await f.handlers.GET(new Request(origin+'/api/account-study?action=bootstrap',{headers:{Authorization:`Bearer ${secret}`}}));
  assert.equal(reached,true);assert.equal(response.status,403);assert.deepEqual(await response.json(),{error:'study-writer-required'});
  assert.equal(response.headers.get('Cache-Control'),'no-store');assert.deepEqual(f.rows(),before);
 });
}

test('a write completed before revocation keeps its saved draft but withholds the obsolete device reply',async t=>{
 const f=await setup(t),mutate=f.store.mutate.bind(f.store);let durable;
 f.store.mutate=async(...args)=>{const receipt=await mutate(...args);durable=receipt.durable;await f.change('revoke');return receipt;};
 const response=await f.handlers.POST(f.request('attempt-mutate',{mutation:f.checkpoint}));
 assert.equal(durable,true);assert.equal(response.status,403);assert.deepEqual(await response.json(),{error:'study-writer-required'});
 const stored=await f.store.read(scope,f.checkpoint.attemptId);assert.equal(stored.answer,f.checkpoint.answer);
 assert.equal(stored.revision,1);assert.equal(f.sqlite.prepare('SELECT count(*) n FROM account_study_records').get().n,0);
});

for(const change of ['revoke','expire','replace-library'])test(`activation reply rejects ${change} after the real activation`,async t=>{
 const f=await setup(t,{pending:true}),activate=f.access.activate.bind(f.access),before=f.rows();let reached=false;
 f.access.activate=async(...args)=>{const activated=await activate(...args);if(!reached){reached=true;await f.change(change);}return activated;};
 const response=await f.handlers.POST(f.request('activate-grant'));
 assert.equal(reached,true);assert.equal(response.status,403);assert.deepEqual(await response.json(),{error:'study-writer-required'});
 assert.deepEqual(f.rows(),before);
});

test('pending grant-info, activation, active retry and unchanged device receipt recovery remain valid',async t=>{
 const f=await setup(t,{pending:true});
 const info=await f.handlers.GET(new Request(origin+'/api/account-study?action=grant-info',{headers:{Authorization:`Bearer ${secret}`}}));
 assert.equal(info.status,200);assert.equal((await info.json()).state,'pending');
 for(let i=0;i<2;i++){
  const response=await f.handlers.POST(f.request('activate-grant'));assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.state,'active');assert.equal(result.grantId,'reply-writer');
 }
 for(const status of ['accepted','duplicate']){
  const response=await f.handlers.POST(f.request('attempt-mutate',{mutation:f.checkpoint}));assert.equal(response.status,200);
  const result=await response.json();assert.equal(result.status,status);assert.equal(result.durable,true);assert.equal(result.attempt.answer,f.checkpoint.answer);
 }
 const conflict=await f.handlers.POST(f.request('attempt-mutate',{mutation:{...f.checkpoint,answer:'Different synthetic answer'}}));
 assert.equal(conflict.status,200);assert.equal((await conflict.json()).status,'conflict');assert.equal(f.rows().length,1);
});

for(const mode of ['post-read','get-bootstrap'])for(const change of ['revoke','expire','replace-library']){
 test(`final device authentication rejects ${change} at its profile query for ${mode}`,async t=>{
  const f=await setup(t);await f.store.mutate(scope,f.checkpoint);const before=f.rows();
  let replyReady=false,finalAuth=false,reached=false;
  const target=mode==='post-read'?f.store:f.study,method=mode==='post-read'?'read':'getSnapshot',read=target[method].bind(target);
  target[method]=async(...args)=>{const value=await read(...args);replyReady=true;return value;};
  const authenticate=f.access.authenticate.bind(f.access);
  f.access.authenticate=async(...args)=>{const previous=finalAuth;finalAuth=replyReady;
   try{return await authenticate(...args);}finally{finalAuth=previous;}};
  const prepare=f.binding.prepare.bind(f.binding);
  const wrap=statement=>new Proxy(statement,{get(target,key){
   if(key==='bind')return(...args)=>wrap(target.bind(...args));
   if(key==='first')return async(...args)=>{
    if(finalAuth&&!reached&&target.query.includes('account_study_profiles')){reached=true;await f.change(change);}
    return target.first(...args);
   };
   return Reflect.get(target,key);
  }});
  f.binding.prepare=query=>wrap(prepare(query));
  const response=mode==='post-read'?await f.handlers.POST(f.request('attempt-read',{attemptId:f.checkpoint.attemptId})):
   await f.handlers.GET(new Request(origin+'/api/account-study?action=bootstrap',{headers:{Authorization:`Bearer ${secret}`}}));
  assert.equal(reached,true);assert.equal(response.status,403);assert.deepEqual(await response.json(),{error:'study-writer-required'});
  assert.deepEqual(f.rows(),before);
 });
}

test('authentication checks expiry with the current clock after its database read completes',async t=>{
 let now=new Date(),reached=false;
 const f=await setup(t,{clock:()=>now}),prepare=f.binding.prepare.bind(f.binding);
 const wrap=statement=>new Proxy(statement,{get(target,key){
  if(key==='bind')return(...args)=>wrap(target.bind(...args));
  if(key==='first')return async(...args)=>{const value=await target.first(...args);
   if(!reached&&target.query.includes('account_study_profiles')){reached=true;now=new Date(now.getTime()+31*24*60*60*1000);}
   return value;
  };
  return Reflect.get(target,key);
 }});
 f.binding.prepare=query=>wrap(prepare(query));
 assert.equal(await f.access.authenticate(secret),null);assert.equal(reached,true);
});
