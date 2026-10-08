import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createHooks,loader,tick} from './helpers/causal-harness.mjs';
const raw=JSON.parse(readFileSync(new URL('./fixtures/long-term-plan.json',import.meta.url),'utf8')),snapshot=raw.snapshot??raw;
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function mount(overrides={}){
 const hooks=createHooks(),timers=new Map(),effects=[];let sequence=0;
 const api={...hooks.api,useEffect(effect,deps){effects.push(effect);return hooks.api.useEffect(effect,deps);}};
 const load=loader(api,{}, {setTimeout:fn=>{const id=++sequence;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)});
 const useAutomaticPlanning=load('src/features/planning/use-automatic-planning.ts').useAutomaticPlanning;
 const prepared=[],props={input:{scope:'A',mode:'native',day:snapshot.spec.startDate,sourceStamp:'stable-facts',trigger:'ready',ready:true,
  state:{revision:1,enabled:true,snapshot,lastOperationId:'op'}},editing:false,historyReady:true,blocked:false,canContinue:()=>true,
  ports:{isCurrent:()=>true,loadSource:async()=>({todayLocked:false}),preview:input=>structuredClone(input.previous),save:()=>assert.fail('unchanged goal'),
   prepareDaily:async input=>{prepared.push(input.scope);return true;},refreshGoals:()=>assert.fail('ready day'),now:()=> '2026-09-17T12:00:00.000Z',...overrides}};
 const render=()=>{hooks.render(props);hooks.flush();};hooks.mount(value=>{useAutomaticPlanning(value);return null;},props);hooks.flush();
 const runTimers=()=>{const callbacks=[...timers.values()];timers.clear();callbacks.forEach(fn=>fn());};
 return {hooks,props,prepared,render,runTimers,effects,timers};
}
test('real planning hook runs the new scope while an old source read remains pending',async()=>{
 const gate=deferred(),f=mount({loadSource:async input=>{if(input.scope==='A')await gate.promise;return {todayLocked:false};}});
 f.runTimers();await tick();f.props.input={...f.props.input,scope:'B'};f.render();f.runTimers();await tick();
 assert.deepEqual(f.prepared,['B']);gate.resolve();await tick();assert.deepEqual(f.prepared,['B']);f.hooks.unmount();
});
test('native daily readiness caused by our own preparation does not cancel the operation',async()=>{
 let accepted=0;const f=mount({prepareDaily:async(_request,_state,isCurrent)=>{
  f.props.input={...f.props.input,ready:false,trigger:'own-reader-busy'};f.render();
  assert.equal(isCurrent(),true);accepted++;return true;
 }});f.runTimers();await tick();assert.equal(accepted,1);f.hooks.unmount();
});
test('opening then closing an editor cannot revive the old source request',async()=>{
 const gate=deferred(),f=mount({loadSource:async()=>{await gate.promise;return {todayLocked:false};}});
 f.runTimers();await tick();f.props.editing=true;f.render();f.props.editing=false;f.render();
 gate.resolve();await tick();assert.deepEqual(f.prepared,[]);
 f.runTimers();await tick();assert.deepEqual(f.prepared,['A']);f.hooks.unmount();
});
test('effect cleanup and replay allocate a live coordinator instead of reusing a disposed one',async()=>{
 const f=mount();f.hooks.unmount();const cleanups=f.effects.map(effect=>effect());f.runTimers();await tick();
 assert.deepEqual(f.prepared,['A']);for(const cleanup of cleanups.reverse())cleanup?.();assert.equal(f.timers.size,0);
});
