import assert from 'node:assert/strict';import test from 'node:test';import {readFileSync} from 'node:fs';let api;
try{api=await import('../app/account-study-client.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
function response(body,status=200){return new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});}
const V=JSON.parse(readFileSync(new URL('./fixtures/account-study-v1.json',import.meta.url),'utf8')),PV=JSON.parse(readFileSync(new URL('./fixtures/account-planning-v1.json',import.meta.url),'utf8'));

test('long-term preference calls carry expected owner and library and validate returned state',async()=>{
  const calls=[],snapshot=JSON.parse(readFileSync(new URL('./fixtures/long-term-plan.json',import.meta.url),'utf8')).snapshot;
  const state={revision:1,enabled:true,snapshot,lastOperationId:'op1'};
  const client=api.createAccountStudyClient({companionUrl:'http://127.0.0.1:43121',expectedUserId:'owner-a',libraryId:'library-a',fetcher:async(url,init={})=>{
    calls.push({url:String(url),init});return response(init.method==='POST'?{status:'accepted',state}:state);
  }});
  assert.equal(typeof client.getLongTermPlanState,'function','Long-term account read must exist');
  assert.equal((await client.getLongTermPlanState()).revision,1);
  await client.mutateLongTermPlan({operationId:'op1',expectedRevision:0,enabled:true,snapshot});
  const query=new URL(calls[0].url,'https://example.test').searchParams;
  assert.equal(query.get('expectedUserId'),'owner-a');assert.equal(query.get('libraryId'),'library-a');
  const body=JSON.parse(calls[1].init.body);assert.equal(body.expectedUserId,'owner-a');assert.equal(body.libraryId,'library-a');
  const invalid=api.createAccountStudyClient({companionUrl:'http://127.0.0.1:43121',expectedUserId:'owner-a',libraryId:'library-a',fetcher:async()=>response({...state,revision:-1})});
  await assert.rejects(invalid.getLongTermPlanState(),/invalid-long-term/);
});
test('AI settings preserve the server availability gate instead of treating account configuration as service readiness',()=>{assert.equal(typeof api?.parseAccountAiSettings,'function','AI settings response parser must preserve server availability');assert.deepEqual(api.parseAccountAiSettings({serverAvailable:false,settings:{revision:4,enabled:true,configured:true}}),{serverAvailable:false,settings:{revision:4,enabled:true,configured:true}});assert.throws(()=>api.parseAccountAiSettings({settings:{revision:4,enabled:true,configured:true}}),/availability/);});
test('setup keeps machine secret local and requires explicit library replacement',async()=>{
  assert.equal(typeof api?.createAccountStudyClient,'function','Account client must exist');const calls=[];
  const fetcher=async(url,init={})=>{calls.push({url:String(url),init});
    if(String(url).includes('/v1/account-sync/prepare'))return response({grantId:'grant-one',libraryId:'library-new',tokenHash:'a'.repeat(64),label:'Computer'});
    if(String(url).includes('action=bootstrap'))return response({profile:{libraryId:'library-old',revision:2}});
    if(String(url).includes('/api/account-study'))return response({state:'pending'});
    throw new Error(String(url));};
  const client=api.createAccountStudyClient({companionUrl:'http://127.0.0.1:43121',sessionToken:'paired-session',fetcher});
  await assert.rejects(client.prepare('Computer'),error=>error?.code==='library-replacement-required');
  await client.prepare('Computer',{replaceLibrary:true});
  const registration=calls.find(call=>JSON.parse(call.init.body||'{}').action==='register-grant');assert.ok(registration);
  assert.equal(JSON.parse(registration.init.body).expectedProfileRevision,2);assert.equal(JSON.parse(registration.init.body).replaceLibrary,true);
  assert.ok(!calls.some(call=>JSON.stringify(call).includes('machine-secret')));assert.equal(calls[0].init.headers['X-Study-Loop-Session'],'paired-session');
});
test('complete snapshot and fenced records paginate before returning usable study data',async()=>{
  const calls=[];const fetcher=async(url)=>{const value=String(url);calls.push(value);
    if(value.includes('action=bootstrap'))return response({profile:{libraryId:'library-a',revision:1},snapshot:V.bundle.snapshot});
    if(value.includes('action=items'))return response({items:V.bundle.items,nextPosition:null});
    if(value.includes('action=planning-catalog'))return response(PV.catalog);
    if(value.includes('action=planning-facts'))return response(PV.facts);
    if(value.includes('action=records')&&!value.includes('through='))return response({records:V.records.slice(0,1).map((record,i)=>({sequence:i+1,record})),nextCursor:1,through:3});
    if(value.includes('action=records')&&value.includes('through=3'))return response({records:V.records.slice(1).map((record,i)=>({sequence:i+2,record})),nextCursor:null,through:3});
    if(value.includes('action=plan-operations'))return response({operations:[],nextCursor:null,through:0});
    if(value.includes('action=plan-executions'))return response({executions:[],nextCursor:null,through:0});
    if(value.includes('action=receipts'))return response({receipts:[],nextCursor:null,through:0});
    throw new Error(value);};
  const client=api.createAccountStudyClient({companionUrl:'http://127.0.0.1:43121',sessionToken:'token',fetcher});
  const loaded=await client.load();assert.equal(loaded.records.length,3);assert.equal(loaded.eventThrough,3);assert.equal(loaded.catalog.catalogHash,PV.catalog.catalogHash);
  assert.ok(calls.some(url=>url.includes('after=1')&&url.includes('through=3')));
});
test('plan mutations and AI use same-account cookies and never Companion session header',async()=>{
  const calls=[],fetcher=async(url,init={})=>{calls.push({url:String(url),init});return response({status:'accepted'});};
  const client=api.createAccountStudyClient({companionUrl:'http://127.0.0.1:43121',sessionToken:'token',fetcher});
  await client.mutatePlan({action:'cancel'});await client.recommendPlan({requestId:'request-one',day:'2026-09-01',request:{}});
  for(const call of calls){assert.equal(call.init.credentials,'same-origin');assert.equal(call.init.headers['X-Study-Loop-Session'],undefined);}
});
test('a scoped client sends an explicit owner contract on every cloud read and mutation',async()=>{
  const calls=[],fetcher=async(url,init={})=>{calls.push({url:new URL(String(url),'https://study.example.test'),init});return response({status:'accepted'});};
  const client=api.createAccountStudyClient({companionUrl:'http://127.0.0.1:43121',expectedUserId:'user-a',fetcher});
  await client.getPlanState('2026-09-05');await client.appendRecords([]);await client.mutatePlan({action:'cancel'});
  assert.equal(calls[0].url.searchParams.get('expectedUserId'),'user-a');
  for(const call of calls.slice(1))assert.equal(JSON.parse(call.init.body).expectedUserId,'user-a');
});
test('mutable content approvals are re-read at the same sequence and malformed statuses are rejected',async()=>{
  let status='pending';const fetcher=async()=>response({operations:[{sequence:1,operationId:'op',factsHash:'a'.repeat(64),candidateId:'candidate',contentHash:'b'.repeat(64),decision:'approved',status,receivedAt:'2026-09-01T00:00:00.000Z'}],through:1,nextCursor:null});
  const client=api.createAccountStudyClient({companionUrl:'http://127.0.0.1:43121',fetcher});
  assert.equal((await client.getContentDecisions()).operations[0].status,'pending');status='blocked';assert.equal((await client.getContentDecisions()).operations[0].status,'blocked');
  status='fabricated';await assert.rejects(client.getContentDecisions(),/content-decision/);
});
test('using the authenticated current library is an explicit read-only choice, never record copying',async()=>{
  let selected='library-b';const calls=[],fetcher=async(url,init={})=>{const target=new URL(String(url),'https://study.example.test');calls.push({target,init});
    return response(target.searchParams.get('action')==='bootstrap'?{profile:{libraryId:selected,revision:2},snapshot:null}:{});};
  const client=api.createAccountStudyClient({companionUrl:'http://127.0.0.1:43121',expectedUserId:'user-a',libraryId:'library-a',fetcher,cache:null});
  await assert.rejects(client.load(),/account-library-changed/);assert.equal(typeof client.adoptCurrentLibrary,'function');assert.equal(await client.adoptCurrentLibrary(),'library-b');
  await client.getPlanState('2026-09-05');assert.equal(calls.at(-1).target.searchParams.get('libraryId'),'library-b');assert.ok(calls.every(call=>!call.init.method));
  selected=null;await assert.rejects(client.adoptCurrentLibrary(),/not-configured/);
});
test('a delayed library choice cannot override a cache/lifecycle reset',async()=>{
  const gate=Promise.withResolvers(),calls=[];const fetcher=async(url)=>{calls.push(String(url));return String(url).includes('bootstrap')?gate.promise:response({});};
  const client=api.createAccountStudyClient({companionUrl:'http://127.0.0.1:43121',expectedUserId:'user-a',libraryId:'library-a',fetcher,cache:null});
  assert.equal(typeof client.adoptCurrentLibrary,'function');const adopting=client.adoptCurrentLibrary();await client.clearReadCache();gate.resolve(response({profile:{libraryId:'library-b'}}));
  await assert.rejects(adopting,{name:'AbortError'});await client.getPlanState('2026-09-05');assert.ok(calls.at(-1).includes('libraryId=library-a'));
});
