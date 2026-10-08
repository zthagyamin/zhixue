import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createAutomaticPlanningCoordinator} from '../src/application/planning/index.ts';
const raw=JSON.parse(readFileSync(new URL('./fixtures/long-term-plan.json',import.meta.url),'utf8'));
const snapshot=raw.snapshot??raw;
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const input=(scope='A',revision=1)=>({scope,mode:'native',day:snapshot.spec.startDate,sourceStamp:'facts',trigger:'view',ready:true,state:{revision,enabled:true,snapshot:structuredClone(snapshot),lastOperationId:'op-'+revision}});
function setup(extra={}){
 const saved=[],prepared=[],reads=[];let current='A',allowed=true;
 const coordinator=createAutomaticPlanningCoordinator({
  isCurrent:request=>allowed&&request.scope===current,
  loadSource:async request=>{reads.push(request.scope);return {todayLocked:false};},
  preview:request=>structuredClone(request.previous),
  save:async(request,mutation)=>{saved.push(request.scope);return {...request.state,...mutation,revision:request.state.revision+1};},
  prepareDaily:async(request,state)=>{prepared.push([request.scope,state.revision]);return true;},
  refreshGoals:async()=>{},now:()=> '2026-09-17T12:00:00.000Z',...extra,
 });
 return {coordinator,saved,prepared,reads,setScope:value=>current=value,setAllowed:value=>allowed=value};
}
test('a blocked old scope cannot swallow automatic preparation of a new scope',async()=>{
 const gate=deferred(),entered=deferred(),f=setup({loadSource:async request=>{f.reads.push(request.scope);if(request.scope==='A'){entered.resolve();await gate.promise;}return {todayLocked:false};}});
 const a=f.coordinator.request(input());await entered.promise;f.setScope('B');
 assert.equal((await f.coordinator.request(input('B'))).status,'prepared');
 assert.equal((await a).status,'stale');gate.resolve();
 assert.deepEqual(f.prepared,[['B',1]]);assert.deepEqual(f.reads,['A','B']);
});
test('a newer revision in the same range is retained and processed after current work',async()=>{
 const gate=deferred(),entered=deferred(),f=setup({loadSource:async()=>{entered.resolve();await gate.promise;return {todayLocked:false};},
  prepareDaily:async(request,state)=>{f.prepared.push([request.scope,state.revision]);return state.revision===2;}});
 const first=f.coordinator.request(input());await entered.promise;const newer=f.coordinator.request(input('A',2));gate.resolve();
 assert.equal((await first).status,'deferred');assert.equal((await newer).status,'prepared');assert.deepEqual(f.prepared,[['A',1],['A',2]]);
});
test('identical requests share preparation and completed work is not repeated',async()=>{
 const gate=deferred(),f=setup({loadSource:async()=>{await gate.promise;return {todayLocked:false};}});
 const a=f.coordinator.request(input()),b=f.coordinator.request(input());gate.resolve();
 await Promise.all([a,b]);assert.equal(f.prepared.length,1);assert.equal((await f.coordinator.request(input())).status,'unchanged');
});
test('manual editing during a read prevents writes without consuming the future retry',async()=>{
 const gate=deferred(),entered=deferred(),f=setup({loadSource:async()=>{entered.resolve();await gate.promise;return {todayLocked:false};}});
 const pending=f.coordinator.request(input());await entered.promise;f.setAllowed(false);gate.resolve();assert.equal((await pending).status,'stale');
 assert.deepEqual(f.saved,[]);assert.deepEqual(f.prepared,[]);f.setAllowed(true);assert.equal((await f.coordinator.request(input())).status,'prepared');
});
test('goal reconciliation is durably saved before its revision prepares the day',async()=>{
 const order=[],f=setup({preview:request=>({...request.previous,warnings:[...request.previous.warnings,'synthetic-change']}),
  save:async(request,mutation)=>{order.push('save');return {...request.state,snapshot:mutation.snapshot,revision:2};},
  prepareDaily:async(_request,state)=>{order.push('daily:'+state.revision);return true;}});
 assert.equal((await f.coordinator.request(input())).status,'prepared');assert.deepEqual(order,['save','daily:2']);
 assert.equal((await f.coordinator.request(input('A',2))).status,'unchanged');
});
test('paused or unready plans perform no automatic work',async()=>{
 const f=setup();assert.equal((await f.coordinator.request({...input(),ready:false})).status,'deferred');
 const paused=input();paused.state.enabled=false;assert.equal((await f.coordinator.request(paused)).status,'deferred');
 assert.deepEqual(f.reads,[]);assert.deepEqual(f.prepared,[]);
});
