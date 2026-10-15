import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {openD1} from './helpers/sqlite-d1.mjs';
import {AccountStudyAccessStore} from '../db/account-study-access-store.ts';
import {AccountStudyStore} from '../db/account-study-store.ts';
import {createAccountStudyHandlers} from '../app/account-study-api.ts';
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';
import {wordBody,snapshotBody} from './fixtures/account-study-fixtures.mjs';

const matrix=readFileSync(new URL('../docs/contracts/account-action-matrix.md',import.meta.url),'utf8');
const rows=[...matrix.matchAll(/^\| ([GP])\d+ ([a-z][a-z0-9-]+) \|/gm)].map(match=>({method:match[1]==='G'?'GET':'POST',action:match[2]}));
assert.equal(rows.length,60);
assert.equal(new Set(rows.map(row=>row.action)).size,60);
const origin='https://permission-fixture.example.test';
const actors=[{user:'matrix-user-a',library:'matrix-library-a',secret:Buffer.alloc(32,1).toString('base64url')},
  {user:'matrix-user-b',library:'matrix-library-b',secret:Buffer.alloc(32,2).toString('base64url')}];

function request(row,{expectedUserId,libraryId,secret,originValue=origin}={}) {
  const url=new URL('/api/account-study',origin),values={action:row.action};
  if(expectedUserId!==undefined)values.expectedUserId=expectedUserId;
  if(libraryId!==undefined)values.libraryId=libraryId;
  if(row.method==='GET') {
    Object.assign(values,{snapshotId:'synthetic-snapshot',catalogHash:'a'.repeat(64),day:'2026-10-09'});
    for(const [key,value] of Object.entries(values))url.searchParams.set(key,value);
  }
  const headers={'Content-Type':'application/json'};
  if(originValue!==undefined)headers.Origin=originValue;
  if(secret)headers.Authorization=`Bearer ${secret}`;
  return new Request(url,{method:row.method,headers,...(row.method==='POST'?{body:JSON.stringify(values)}:{})});
}

async function fixture(t,{activate=true}={}) {
  const {sqlite,binding}=await openD1();let closed=false;
  const close=()=>{if(!closed){closed=true;sqlite.close();}};t.after(close);
  let now=new Date();
  const access=new AccountStudyAccessStore(binding,()=>new Date(now)),study=new AccountStudyStore(binding),effects=[];
  for(const actor of actors) {
    await access.register(actor.user,{grantId:`grant-${actor.user}`,libraryId:actor.library,
      tokenHash:createHash('sha256').update(actor.secret).digest('hex'),label:'Synthetic fixture only',expectedProfileRevision:0,replaceLibrary:false});
    if(activate)await access.activate(actor.secret);
    const items=[await sealStudyItem(wordBody({title:`private-${actor.user}`}))];
    const snapshot=await sealStudySnapshot(snapshotBody(items,{libraryId:actor.library,snapshotId:`snapshot-${actor.user}`}));
    await study.putSnapshot({userId:actor.user,libraryId:actor.library},{snapshot,items},0);
  }
  const guardedStore=name=>new Proxy({}, {get(_target,method){
    if(method==='then')return undefined;
    return (...args)=>{effects.push({name,method:String(method),args});throw Error('unexpected-sensitive-operation');};
  }});
  const provider=name=>async()=>{effects.push({name,method:'provider-acquisition'});throw Error('unexpected-model-acquisition');};
  const handlers=user=>createAccountStudyHandlers({enabled:true,getBrowserUser:async()=>user?{userId:user}:null,
    getAccessStore:async()=>access,getStudyStore:async()=>study,getReceiptStore:async()=>guardedStore('receipt'),
    getPlanStore:async()=>guardedStore('plan'),getLongTermStore:async()=>guardedStore('long-term'),
    getAiStore:async()=>guardedStore('ai'),getContentDecisionStore:async()=>guardedStore('decision'),
    getAttemptStore:async()=>guardedStore('attempt'),getCourseEvidenceStore:async()=>guardedStore('course'),
    getPracticeEvidenceStore:async()=>guardedStore('practice'),getPaperReadingStore:async()=>guardedStore('paper'),
    getMathMappingStore:async()=>guardedStore('math-mapping'),getPlanAi:provider('plan-ai'),
    getQuestionAi:provider('question-ai'),getChatAi:provider('chat-ai'),getAiModels:provider('model-list'),
    getCourseAi:provider('course-ai'),getPracticeAi:provider('practice-ai'),getPaperReadingProvider:provider('paper-ai')});
  const databaseImage=()=>JSON.stringify(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>({name,rows:sqlite.prepare(`SELECT * FROM "${name.replaceAll('"','""')}"`).all()})));
  return {access,study,sqlite,effects,handlers,databaseImage,close,
    advanceClock:milliseconds=>{now=new Date(now.getTime()+milliseconds);}};
}

test('all declared account entries reject anonymous callers before consuming bodies or changing data',async t=>{
  const f=await fixture(t),before=f.databaseImage(),handler=f.handlers(null);
  for(const row of rows) {
    const req=request(row),response=await handler[row.method](req);
    assert.equal(response.status,401,`${row.method} ${row.action}`);
    assert.equal(req.bodyUsed,false,row.action);
  }
  assert.deepEqual(f.effects,[]);assert.equal(f.databaseImage(),before);
});

test('all entries reject another expected account for browser and real active-grant A/B fixtures',async t=>{
  const f=await fixture(t),before=f.databaseImage();
  for(const actor of actors)for(const kind of ['browser','device'])for(const row of rows) {
    const handler=f.handlers(kind==='browser'?actor.user:null);
    const req=request(row,{expectedUserId:actor===actors[0]?actors[1].user:actors[0].user,secret:kind==='device'?actor.secret:undefined});
    assert.equal((await handler[row.method](req)).status,403,`${kind} ${actor.user} ${row.action}`);
  }
  assert.deepEqual(f.effects,[]);assert.equal(f.databaseImage(),before);
});

test('browser/grant account mixing is rejected on every entry without consuming the submitted answer',async t=>{
  const f=await fixture(t),before=f.databaseImage();
  for(const actor of actors)for(const row of rows) {
    const other=actor===actors[0]?actors[1]:actors[0],req=request(row,{secret:other.secret});
    assert.equal((await f.handlers(actor.user)[row.method](req)).status,403,row.action);
    assert.equal(req.bodyUsed,false,row.action);
  }
  assert.deepEqual(f.effects,[]);assert.equal(f.databaseImage(),before);
});

test('browser mutation entries refuse wrong Origin before input consumption and persistence',async t=>{
  const f=await fixture(t),before=f.databaseImage();
  for(const actor of actors)for(const row of rows.filter(row=>row.method==='POST')) {
    const req=request(row,{originValue:'https://other-fixture.invalid'});
    assert.equal((await f.handlers(actor.user).POST(req)).status,403,row.action);
    assert.equal(req.bodyUsed,false,row.action);
  }
  assert.deepEqual(f.effects,[]);assert.equal(f.databaseImage(),before);
});

test('library-scoped read entries deny another library while bootstrap remains bound to the own profile',async t=>{
  const f=await fixture(t),before=f.databaseImage();
  const reads=rows.filter(row=>row.method==='GET'&&!['grant-info','bootstrap'].includes(row.action));
  assert.equal(reads.length,15);
  for(const actor of actors)for(const kind of ['browser','device']) {
    const other=actor===actors[0]?actors[1]:actors[0],handler=f.handlers(kind==='browser'?actor.user:null);
    for(const row of reads) {
      const req=request(row,{libraryId:other.library,secret:kind==='device'?actor.secret:undefined});
      assert.equal((await handler.GET(req)).status,403,`${kind} ${row.action}`);
    }
    const bootstrap=await handler.GET(request({method:'GET',action:'bootstrap'},{libraryId:other.library,secret:kind==='device'?actor.secret:undefined}));
    assert.equal(bootstrap.status,200);
    const value=await bootstrap.json();assert.equal(value.profile.libraryId,actor.library);
    assert.equal(value.snapshot.libraryId,actor.library);assert.equal(value.snapshot.snapshotId,`snapshot-${actor.user}`);
  }
  assert.deepEqual(f.effects,[]);assert.equal(f.databaseImage(),before);
});

test('pending grants deny every learning entry while retaining grant inspection and activation',async t=>{
  const f=await fixture(t,{activate:false}),before=f.databaseImage(),handler=f.handlers(null);
  const protectedRows=rows.filter(row=>!['grant-info','activate-grant'].includes(row.action));
  assert.equal(protectedRows.length,58);
  for(const actor of actors)for(const row of protectedRows) {
    const response=await handler[row.method](request(row,{secret:actor.secret}));
    assert.equal(response.status,403,`${actor.user} pending ${row.action}`);
  }
  assert.deepEqual(f.effects,[]);assert.equal(f.databaseImage(),before);
  for(const actor of actors) {
    const info=await handler.GET(request({method:'GET',action:'grant-info'},{secret:actor.secret}));
    assert.equal(info.status,200);
    const principal=await info.json();
    assert.equal(principal.state,'pending');assert.equal(principal.userId,actor.user);
    assert.equal(principal.libraryId,actor.library);
  }
  assert.equal(f.databaseImage(),before);
  for(const actor of actors) {
    const activation=await handler.POST(request({method:'POST',action:'activate-grant'},{secret:actor.secret}));
    assert.equal(activation.status,200);
    assert.equal((await activation.json()).state,'active');
    assert.equal((await f.access.profile(actor.user)).libraryId,actor.library);
    assert.equal((await f.access.authenticate(actor.secret)).state,'active');
  }
  assert.deepEqual(f.effects,[]);
  const learningImage=image=>JSON.parse(image).filter(({name})=>!['account_study_grants','account_study_profiles'].includes(name));
  assert.deepEqual(learningImage(f.databaseImage()),learningImage(before));
});

test('expired grants are rejected on all account entries before body consumption or writes',async t=>{
  const f=await fixture(t);f.advanceClock(31*24*60*60*1000);
  const before=f.databaseImage(),handler=f.handlers(null);
  for(const actor of actors)for(const row of rows) {
    const req=request(row,{secret:actor.secret});
    assert.equal((await handler[row.method](req)).status,401,`${actor.user} expired ${row.action}`);
    assert.equal(req.bodyUsed,false,row.action);
  }
  assert.deepEqual(f.effects,[]);assert.equal(f.databaseImage(),before);
});

test('revoked grants are rejected on all account entries before body consumption or writes',async t=>{
  const f=await fixture(t);
  for(const actor of actors)assert.equal(await f.access.revoke(actor.user,`grant-${actor.user}`),true);
  const before=f.databaseImage(),handler=f.handlers(null);
  for(const actor of actors)for(const row of rows) {
    const req=request(row,{secret:actor.secret});
    assert.equal((await handler[row.method](req)).status,401,`${actor.user} revoked ${row.action}`);
    assert.equal(req.bodyUsed,false,row.action);
  }
  assert.deepEqual(f.effects,[]);assert.equal(f.databaseImage(),before);
});

const grantChanges={
  revoked:async(f,actor)=>{assert.equal(await f.access.revoke(actor.user,`grant-${actor.user}`),true);},
  expired:async f=>{f.advanceClock(31*24*60*60*1000);},
  'replacement-library':async(f,actor)=>{
    const secret=Buffer.alloc(32,3).toString('base64url');
    await f.access.register(actor.user,{grantId:`replacement-${actor.user}`,libraryId:`replacement-${actor.library}`,
      tokenHash:createHash('sha256').update(secret).digest('hex'),label:'Synthetic replacement only',
      expectedProfileRevision:1,replaceLibrary:true});
    await f.access.activate(secret);
  },
};

for(const [changeName,change] of Object.entries(grantChanges))test(`all POST entries revalidate ${changeName} grants after streamed body reading`,async t=>{
  const writes=rows.filter(row=>row.method==='POST');assert.equal(writes.length,43);
  for(const actor of actors)for(const row of writes) {
    const f=await fixture(t);
    try {
      const authenticate=f.access.authenticate.bind(f.access);let authenticated=false,afterChange,revalidatedAfterChange=false;
      f.access.authenticate=async secret=>{const principal=await authenticate(secret);authenticated=true;
        if(afterChange!==undefined)revalidatedAfterChange=true;return principal;};
      const stream=new ReadableStream({async pull(controller){
        assert.equal(authenticated,true,'authorization must precede consuming the supplied answer');
        await change(f,actor);afterChange=f.databaseImage();
        controller.enqueue(new TextEncoder().encode(JSON.stringify({action:row.action})));controller.close();
      }},{highWaterMark:0});
      const req=new Request(new URL('/api/account-study',origin),{method:'POST',duplex:'half',body:stream,
        headers:{'Content-Type':'application/json',Authorization:`Bearer ${actor.secret}`,Origin:origin}});
      const response=await f.handlers(null).POST(req);
      assert.equal(response.status,403,`${actor.user} ${changeName} ${row.action}`);
      assert.equal((await response.json()).error,'study-writer-required',`${row.action} must fail at qualification revalidation`);
      assert.equal(revalidatedAfterChange,true,`${row.action} must query authorization after the body changed it`);
      assert.equal(req.bodyUsed,true);assert.equal(typeof afterChange,'string');
      assert.deepEqual(f.effects,[]);assert.equal(f.databaseImage(),afterChange);
    } finally {f.close();}
  }
});

test('an unchanged active grant retains successful idempotent activation through a streamed request',async t=>{
  const f=await fixture(t),before=f.databaseImage();
  for(const actor of actors) {
    const stream=new ReadableStream({pull(controller){
      controller.enqueue(new TextEncoder().encode(JSON.stringify({action:'activate-grant'})));controller.close();
    }},{highWaterMark:0});
    const req=new Request(new URL('/api/account-study',origin),{method:'POST',duplex:'half',body:stream,
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${actor.secret}`,Origin:origin}});
    const response=await f.handlers(null).POST(req);assert.equal(response.status,200);
    const principal=await response.json();assert.equal(principal.state,'active');
    assert.equal(principal.userId,actor.user);assert.equal(principal.libraryId,actor.library);
    assert.equal(req.bodyUsed,true);
  }
  assert.deepEqual(f.effects,[]);assert.equal(f.databaseImage(),before);
});
