import assert from 'node:assert/strict';
import test from 'node:test';
import {dashboardEffect,dashboardFunction} from './fixtures/dashboard-functions.mjs';
import {loadAccountForPage} from '../app/account-study-load-state.ts';
import {createAccountSourceSession} from '../src/application/sources/index.ts';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
function harness(overrides={}){
  const requests=[],applied=[],timers=new Map();let nextTimer=0;
  const bindings={
    storageReady:true,sessionResolved:true,sessionUser:{userId:'test-user',displayName:'Preview',email:''},accountOptedOut:false,accountLoaded:null,accountReadPaused:false,
    workspaceId:'account:test-user',accountProbeRef:{current:''},accountModeEpoch:{current:7},accountApplyEpoch:{current:0},accountReadController:{current:null},loadAccountForPage,
    accountClient:{cached:async()=>null,load(){const request=Promise.withResolvers();requests.push(request);return request.promise;}},
    applyAccountLoaded:async(value,epoch)=>{applied.push({value,epoch});return true;},setAccountReadStatus(){},
    setAccountProbeRetry(){},
    window:{setTimeout(fn,delay){const id=++nextTimer;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);}},
    ...overrides,
  };
  bindings.accountSources=createAccountSourceSession({capture:()=>({key:bindings.workspaceId,owner:bindings.workspaceId,modeEpoch:bindings.accountModeEpoch.current,
    ready:bindings.storageReady&&bindings.sessionResolved,identity:bindings.sessionUser,local:bindings.accountOptedOut,paused:bindings.accountReadPaused,current:()=>true,
    studying:()=>false,mutation:()=>0,visible:()=>null,client:bindings.accountClient}),
    version:()=>({libraryId:'fixture',snapshotId:'fixture',revision:1,eventThrough:0,taskThrough:0,observedAt:'2026-09-01'}),
    prepare:async(frame,value)=>{await bindings.applyAccountLoaded(value,frame.modeEpoch);return[];},project:async()=>null,publish(){},receipts(){},status:bindings.setAccountReadStatus,clear(){},identityChanged(){},now:()=>new Date().toISOString(),abort:()=>new AbortController()});
  bindings.refreshAccountRead=dashboardFunction('refreshAccountRead',bindings);
  bindings.cancelAccountRead=bindings.accountSources.cancel;
  return {bindings,requests,applied,timers,run:()=>dashboardEffect('accountProbeRef.current===workspaceId',bindings)(),fire:async(delay=0)=>{const [id,timer]=[...timers].find(([,value])=>value.delay===delay);timers.delete(id);timer.fn();await settle();}};
}

test('account reload restarts a cancelled probe after Companion dependencies change',async()=>{
  const h=harness(),cancel=h.run();
  await h.fire();
  assert.equal(h.requests.length,1);
  cancel();
  const cancelReplacement=h.run();
  await h.fire();
  assert.equal(h.requests.length,2,'cancelled probe must not block the replacement request');
  h.requests[0].resolve({snapshot:'stale'});
  h.requests[1].resolve({snapshot:'current'});
  await settle();
  assert.deepEqual(h.applied,[{value:{snapshot:'current'},epoch:7}]);
  cancelReplacement();
  assert.equal(h.bindings.accountProbeRef.current,'');
});

test('account reload retries when applying the downloaded account cache fails',async()=>{
  const h=harness({applyAccountLoaded:async()=>{throw new Error('temporary-cache-failure');}}),cancel=h.run();
  await h.fire();
  h.requests[0].resolve({snapshot:'current'});
  await settle();
  assert.equal(h.bindings.accountProbeRef.current,'');
  assert.equal([...h.timers.values()][0]?.delay,30000);
  cancel();
  assert.equal(h.timers.size,0);
});

test('cancelled probes cannot reset another workspace or retry after unmount',async()=>{
  const h=harness(),cancel=h.run();
  await h.fire();
  h.bindings.accountProbeRef.current='user:another-user';
  cancel();
  h.requests[0].reject(new Error('late-network-error'));
  await settle();
  assert.equal(h.bindings.accountProbeRef.current,'user:another-user');
  assert.equal(h.applied.length,0);
  assert.equal(h.timers.size,0);
});

test('account reload respects explicit local mode and does not probe before login',()=>{
  for(const override of [{accountOptedOut:true},{accountReadPaused:true},{storageReady:false},{sessionUser:null}]){
    const h=harness(override);
    assert.equal(h.run(),undefined);
    assert.equal(h.requests.length,0);
  }
});
test('an already loaded cache still permits the next complete refresh',async()=>{
  const h=harness({accountLoaded:{snapshot:'cached'}}),cancel=h.run();await h.fire();assert.equal(h.requests.length,1);h.requests[0].resolve({snapshot:'latest'});await settle();assert.equal(h.applied[0].value.snapshot,'latest');cancel();
});
