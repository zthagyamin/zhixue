import assert from 'node:assert/strict';
import test from 'node:test';
let api;try{api=await import('../app/account-study-load-state.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const identity={userId:'user-a',displayName:'Preview',email:''};
test('session failures and malformed identity are never a resolved guest account',async()=>{
  assert.equal(typeof api?.readStudyIdentity,'function');
  await assert.rejects(api.readStudyIdentity(new Response(JSON.stringify({authenticated:false,user:null}),{status:503})),/identity/);
  await assert.rejects(api.readStudyIdentity(Response.json({authenticated:true,user:null})),/identity/);
  assert.equal(await api.readStudyIdentity(Response.json({authenticated:false,user:null})),null);
  assert.deepEqual(await api.readStudyIdentity(Response.json({authenticated:true,user:identity})),identity);
});
test('identity and explicit local preference gate both private cache and network reads',async()=>{
  assert.equal(typeof api?.loadAccountForPage,'function');let reads=0;const client={cached:async()=>{reads++;},load:async()=>{reads++;}};
  for(const input of [{identity:null,local:false},{identity,local:true}]){const status=[];await api.loadAccountForPage({...input,client,onStatus:value=>status.push(value),apply:()=>{throw new Error('No private source allowed');}});assert.equal(reads,0);assert.ok(status.length);}
});
test('a complete cached source is labelled as cached before remote refresh and retained on failure',async()=>{
  const cached={bundle:{snapshot:{libraryId:'library-a'}}},states=[],applied=[];
  const result=await api.loadAccountForPage({identity,local:false,client:{cached:async()=>cached,load:async()=>{throw new Error('offline');}},onStatus:value=>states.push(value),apply:async(value,freshness)=>{applied.push([value,freshness]);return true;}});
  assert.equal(result,null);assert.deepEqual(applied,[[cached,'cache']]);assert.ok(states.some(value=>value.phase==='cached'));assert.equal(states.at(-1).phase,'failed');assert.equal(states.at(-1).hasCache,true);
  assert.match(api.accountLoadLabel(states.at(-1)),/缓存/);
});
test('fresh data held behind an active question never claims the question has changed',async()=>{
  const states=[];await api.loadAccountForPage({identity,local:false,client:{cached:async()=>null,load:async()=>({})},onStatus:value=>states.push(value),apply:async()=>false});
  assert.equal(states.at(-1).phase,'ready');assert.equal(states.at(-1).deferred,true);assert.match(api.accountLoadDetail(states.at(-1)),/当前练习/);
});
test('account mismatch invalidates identity rather than silently using stale private cache',async()=>{
  let changed=0;const states=[];await api.loadAccountForPage({identity,local:false,client:{cached:async()=>null,load:async()=>{throw new Error('account-mismatch');}},onStatus:value=>states.push(value),apply:async()=>true,onIdentityChanged:()=>changed++});
  assert.equal(changed,1);assert.equal(states.at(-1).phase,'identity-changed');
});
test('cancelled page loads do not publish a late source or an error message',async()=>{
  const abort=new AbortController(),states=[];let applied=0;
  await api.loadAccountForPage({identity,local:false,signal:abort.signal,client:{cached:async()=>{abort.abort();return{};},load:async()=>{throw new Error('Must not fetch');}},onStatus:value=>states.push(value),apply:async()=>{applied++;return true;}});
  assert.equal(applied,0);assert.ok(!states.some(value=>value.phase==='failed'));
});
test('an account that has published nothing yet is a normal starting point, not a read failure',async()=>{
  // The live walkthrough met a bare "账号资料读取失败" line on a brand-new workspace. Both codes below
  // describe "there is nothing here yet" (no published bank, or the service is off in this
  // deployment), so neither may be presented as a failure.
  for(const code of ['study-library-not-configured','account-study-disabled']){
    const states=[];
    const result=await api.loadAccountForPage({identity,local:false,client:{cached:async()=>null,load:async()=>{throw new Error(code);}},onStatus:value=>states.push(value),apply:async()=>true});
    assert.equal(result,null);
    assert.equal(states.at(-1).phase,'not-connected',code);
    assert.equal(states.at(-1).hasCache,false);
    assert.doesNotMatch(api.accountLoadLabel(states.at(-1)),/失败/,code);
    if(code==='study-library-not-configured'){
      assert.equal(states.at(-1).message,undefined);assert.match(api.accountLoadDetail(states.at(-1)),/正常的初始状态/,code);
    }else{
      assert.match(api.accountLoadDetail(states.at(-1)),/站点.*未启用/);assert.doesNotMatch(api.accountLoadDetail(states.at(-1)),/这个账号还没有发布/);
    }
  }
});
test('genuine service and network failures keep the failure wording',async()=>{
  for(const code of ['study-service-unavailable','Failed to fetch','account-response-invalid']){
    const states=[];
    await api.loadAccountForPage({identity,local:false,client:{cached:async()=>null,load:async()=>{throw new Error(code);}},onStatus:value=>states.push(value),apply:async()=>true});
    assert.equal(states.at(-1).phase,'failed',code);
    assert.match(api.accountLoadLabel(states.at(-1)),/失败/,code);
  }
});

test('disabling the service after a complete cache exists does not masquerade as a new account',async()=>{
  const cached={bundle:{snapshot:{libraryId:'library-a'}}},states=[],applied=[];
  await api.loadAccountForPage({identity,local:false,client:{cached:async()=>cached,load:async()=>{throw new Error('account-study-disabled');}},onStatus:value=>states.push(value),apply:async value=>{applied.push(value);return true;}});
  const final=states.at(-1);assert.deepEqual(applied,[cached]);assert.equal(final.phase,'failed');assert.equal(final.hasCache,true);
  assert.match(api.accountLoadLabel(final),/完整缓存/);assert.match(api.accountLoadDetail(final),/服务.*未启用/);assert.doesNotMatch(api.accountLoadDetail(final),/初始状态|还没有发布/);
});

test('an unavailable deployment without cache does not claim that the user never published a library',async()=>{
  const states=[];await api.loadAccountForPage({identity,local:false,client:{cached:async()=>null,load:async()=>{throw new Error('account-study-disabled');}},onStatus:value=>states.push(value),apply:async()=>true});
  assert.equal(states.at(-1).phase,'not-connected');assert.match(api.accountLoadDetail(states.at(-1)),/站点.*未启用/);
  assert.doesNotMatch(api.accountLoadDetail(states.at(-1)),/这个账号还没有发布|正常的初始状态/);
});

test('account-bank notices do not assert the state of the independent local Companion',()=>{
  const state={phase:'not-connected'};assert.match(api.accountLoadLabel(state),/账号题库/);assert.match(api.accountLoadLabel(state),/尚未连接/);
  assert.doesNotMatch(api.accountLoadLabel(state),/体验模式|尚未连接本机资料/);
});
