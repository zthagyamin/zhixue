import assert from 'node:assert/strict';
import test from 'node:test';
import {createLegacyPlanActions} from '../src/application/planning/index.ts';
import {deferred} from './helpers/causal-harness.mjs';
function fixture(){
 const candidate={day:'2026-09-17',planHash:'candidate',items:[]},messages=[],published=[],loading=[];
 const frame={scope:'owner-A',day:candidate.day,sourceStamp:'facts',enabled:true,historyReady:true,storageReady:true,hasContent:true,
  candidate,authority:{revision:1,candidate:null,history:[]},mode:'deterministic',online:true,operator:'test',transport:null};
 const transport={getCurrentPlan:async()=>frame.authority,applyPlan:async()=>({status:'ok',revision:{revision:2}}),rejectPlan:async()=>({status:'ok'}),restorePlan:async()=>({status:'ok',revision:{revision:2}})};
 frame.transport=transport;
 const ports={readFrame:()=>frame,isCurrent:()=>true,readInput:()=>assert.fail('unexpected generation'),replaceCandidate:(before,after)=>{if(frame.candidate===before)frame.candidate=after;},
  publishAuthority:value=>{frame.authority=value;published.push(value);},message:value=>messages.push(value),loading:value=>loading.push(value),resetSelection(){}};
 const actions=createLegacyPlanActions(ports);return {frame,candidate,ports,transport,actions,messages,published,loading};
}
test('legacy generation refuses unknown history before loading input or changing busy state',async()=>{
 const f=fixture();f.frame.historyReady=false;await f.actions.generate();assert.deepEqual(f.loading,[]);assert.match(f.messages.at(-1),/历史|核对/);assert.equal(f.frame.candidate,f.candidate);
});
test('legacy approval uses the shown revision and preserves a newer candidate',async()=>{
 const f=fixture(),gate=deferred();let sent;f.transport.applyPlan=async(...args)=>{sent=args;await gate.promise;return {status:'ok',revision:{revision:2}};};
 const pending=f.actions.approve(),next={...f.candidate,planHash:'newer'};f.frame.candidate=next;gate.resolve();await pending;
 assert.deepEqual(sent,[f.candidate,1,'test']);assert.equal(f.frame.candidate,next);assert.equal(f.frame.authority.candidate,f.candidate);assert.equal(f.frame.authority.revision,2);
});
test('late old authority reads cannot undo a newer accepted approval',async()=>{
 const f=fixture(),gate=deferred();let reads=0;f.transport.getCurrentPlan=async()=>++reads===1?gate.promise:{revision:2,candidate:f.candidate,history:[]};
 const pending=f.actions.refresh();await f.actions.approve();gate.resolve({revision:1,candidate:null,history:[]});await pending;
 assert.equal(f.frame.authority.revision,2);assert.equal(f.published.some(value=>value.revision===1),false);
});
test('changing owner during approval does not clear or publish into the new owner',async()=>{
 const f=fixture(),gate=deferred();f.transport.applyPlan=()=>gate.promise;const pending=f.actions.approve();f.frame.scope='owner-B';f.actions.invalidate();
 gate.resolve({status:'ok',revision:{revision:2}});await pending;assert.deepEqual(f.published,[]);assert.equal(f.frame.candidate,f.candidate);assert.doesNotMatch(f.messages.at(-1),/已写入/);
});
test('offline rejection discards only the local candidate without inventing a remote audit',async()=>{
 const f=fixture();f.frame.online=false;f.transport.rejectPlan=()=>assert.fail('offline remote write');await f.actions.reject();
 assert.equal(f.frame.candidate,null);assert.match(f.messages.at(-1),/本页候选/);assert.doesNotMatch(f.messages.at(-1),/记入审计/);
});
test('duplicate rejection is single-flight and failure preserves the candidate',async()=>{
 const f=fixture(),gate=deferred();let calls=0;f.transport.rejectPlan=()=>{calls++;return gate.promise;};
 const pending=f.actions.reject();await f.actions.reject();assert.equal(calls,1);gate.reject(Error('remote unavailable'));await pending;assert.equal(f.frame.candidate,f.candidate);
});
test('stale approval refreshes authority but does not discard the shown candidate',async()=>{
 const f=fixture();f.transport.applyPlan=async()=>({status:'stale'});f.transport.getCurrentPlan=async()=>({revision:3,candidate:null,history:[]});
 await f.actions.approve();assert.equal(f.frame.candidate,f.candidate);assert.equal(f.frame.authority.revision,3);assert.match(f.messages.at(-1),/重新检查/);
});
test('restore sends an expected revision and reads back the new authority',async()=>{
 const f=fixture();let sent;f.transport.restorePlan=async(...args)=>{sent=args;return{status:'ok',revision:{revision:4}};};f.transport.getCurrentPlan=async()=>({revision:4,candidate:f.candidate,history:[{revision:4,undoTarget:0}]});
 await f.actions.restore(0);assert.deepEqual(sent,[0,1,'test']);assert.equal(f.frame.authority.revision,4);assert.equal(f.frame.authority.history[0].undoTarget,0);
});
