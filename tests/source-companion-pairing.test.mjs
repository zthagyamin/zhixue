import assert from 'node:assert/strict';
import test from 'node:test';
import {createCompanionSession} from '../src/application/sources/index.ts';
import {deferred,createHooks,loader} from './helpers/causal-harness.mjs';

function fixture(){
  let owner='A',endpoint='one',connection=null;
  const notices=[],busy=[],signals=[],calls={pair:0,health:0,source:0};
  const response=deferred(),entered=deferred();
  const ports={
    capture:()=>{const scope=owner,host=endpoint;return{key:scope+host,connection,user:{userId:scope},code:'synthetic',account:()=>false,current:()=>owner===scope&&endpoint===host};},
    pair:async(_frame,signal)=>{calls.pair++;signals.push(signal);entered.resolve();return response.promise;},
    health:async()=>{calls.health++;return{version:'synthetic',capabilities:[]};},
    source:async()=>{calls.source++;return{ok:true,httpStatus:200,payload:{status:'connected',subjects:[{}]}};},
    publish:notice=>{notices.push(notice);if(notice.kind==='paired')connection=notice.connection;},
    apply:()=>true,flushActivities:async()=>{},busy:(kind,value)=>busy.push([kind,value]),abort:()=>new AbortController(),
  };
  return{ports,calls,notices,busy,signals,response,entered,connection:()=>connection,
    changeOwner:()=>{owner='B';},changeEndpoint:()=>{endpoint='two';}};
}

test('duplicate pairing is locked synchronously before the first render or request',async()=>{
  const f=fixture(),session=createCompanionSession(f.ports),first=session.pair(),second=session.pair();
  const samePromise=first===second;
  await f.entered.promise;f.response.resolve({token:'synthetic'});await Promise.all([first,second]);
  assert.equal(samePromise,true);assert.equal(f.calls.pair,1);assert.equal(f.notices.filter(n=>n.kind==='paired').length,1);
});

test('a consumed pairing code with a delayed success survives detect, refresh and background poll',async()=>{
  const f=fixture(),session=createCompanionSession(f.ports),first=session.pair();
  await f.entered.promise; // The synthetic server has consumed the code; only its response is delayed.
  const second=session.pair(),detect=session.detect(),refresh=session.refresh(),poll=session.poll();
  const shared=[second,detect,refresh,poll].every(promise=>promise===first);
  const uninterrupted=!f.signals[0].aborted;
  f.response.resolve({token:'first-response'});
  assert.deepEqual(await Promise.all([first,second,detect,refresh,poll]),[true,true,true,true,true]);
  assert.equal(shared,true);assert.equal(uninterrupted,true);
  assert.deepEqual(f.calls,{pair:1,health:0,source:0});
  assert.equal(f.connection().token,'first-response');
  assert.deepEqual(f.notices.map(n=>n.kind),['pair-start','paired']);
  assert.deepEqual(f.busy,[['pair',true],['pair',false]]);
});

test('failed pairing releases its lock and can be retried',async()=>{
  const f=fixture(),session=createCompanionSession(f.ports),first=session.pair();await f.entered.promise;
  f.response.reject(Error('synthetic rejected code'));assert.equal(await first,false);
  f.ports.pair=async()=>{f.calls.pair++;return{token:'retry'};};
  assert.equal(await session.pair(),true);assert.equal(f.calls.pair,2);assert.equal(f.connection().token,'retry');
  assert.deepEqual(f.notices.map(n=>n.kind),['pair-start','error','pair-start','paired']);
  assert.deepEqual(f.busy,[['pair',true],['pair',false],['pair',true],['pair',false]]);
});

for(const change of ['changeOwner','changeEndpoint'])test(`${change} permits a new pairing and ignores the old success`,async()=>{
  const f=fixture(),session=createCompanionSession(f.ports),old=session.pair();await f.entered.promise;
  f[change]();f.ports.pair=async()=>{f.calls.pair++;return{token:'current-binding'};};
  assert.equal(await session.pair(),true);assert.equal(f.signals[0].aborted,true);
  f.response.resolve({token:'retired-binding'});assert.equal(await old,false);
  assert.equal(f.connection().token,'current-binding');assert.equal(f.notices.filter(n=>n.kind==='paired').length,1);
});

test('explicit cancellation and disposal still abort pairing and discard its late success',async()=>{
  for(const action of ['cancel','dispose']){
    const f=fixture(),session=createCompanionSession(f.ports),pending=session.pair();await f.entered.promise;
    session[action]();assert.equal(f.signals[0].aborted,true);f.response.resolve({token:'late'});
    assert.equal(await pending,false);assert.equal(f.connection(),null);assert.deepEqual(f.busy,[['pair',true],['pair',false]]);
    if(action==='dispose')assert.equal(await session.pair(),false);
  }
});

test('the live hook exposes pairing busy and prevents second operations before rerender',async()=>{
  const f=fixture(),hooks=createHooks(),use=loader(hooks.api)('src/features/sources/use-companion-source.ts').useCompanionSource;
  const options={...f.ports,scope:'A:one',connection:null,retry:0,retryMs:5000};
  hooks.mount(use,options);hooks.flush();const first=hooks.view().pair();await f.entered.promise;
  const detect=hooks.view().detect(),refresh=hooks.view().refresh(),second=hooks.view().pair();
  hooks.render(options);hooks.flush();const wasBusy=hooks.view().busy.pair;
  f.response.resolve({token:'hook'});await Promise.all([first,detect,refresh,second]);hooks.render(options);hooks.flush();
  assert.equal(wasBusy,true);assert.equal(hooks.view().busy.pair,false);assert.deepEqual(f.calls,{pair:1,health:0,source:0});
  assert.equal(f.connection().token,'hook');hooks.unmount();
});

test('a replaced hook binding or unmount aborts its pairing and cannot publish a stale connection',async()=>{
  for(const action of ['replace','unmount']){
    const f=fixture(),hooks=createHooks(),use=loader(hooks.api)('src/features/sources/use-companion-source.ts').useCompanionSource;
    const options={...f.ports,scope:'A:one',connection:null,retry:0,retryMs:5000};
    hooks.mount(use,options);hooks.flush();const pending=hooks.view().pair();await f.entered.promise;
    if(action==='replace'){hooks.render({...options,scope:'B:two'});hooks.flush();}else hooks.unmount();
    assert.equal(f.signals[0].aborted,true);f.response.resolve({token:'stale'});assert.equal(await pending,false);
    assert.equal(f.connection(),null);if(action==='replace')hooks.unmount();
  }
});
