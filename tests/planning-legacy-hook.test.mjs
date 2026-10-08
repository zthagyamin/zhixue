import assert from 'node:assert/strict';
import test from 'node:test';
import {createHooks,loader,deferred} from './helpers/causal-harness.mjs';
function mount(){
 const hooks=createHooks(),load=loader(hooks.api),{useLegacyPlanState}=load('src/features/planning/use-legacy-plan-state.ts'),{useLegacyPlanning}=load('src/features/planning/use-legacy-planning.ts');
 const sends=[],messages=[],loading=[];let revision=12;
 const props={scope:'owner-A/library-A',day:'2026-09-17',transport:{getCurrentPlan:async()=>({revision,candidate:null,history:[]}),applyPlan:async candidate=>{sends.push(candidate);return {status:'ok',revision:{revision:revision+1}};}}};
 hooks.mount(value=>{
  const state=useLegacyPlanState(value.scope,value.transport);
  const actions=useLegacyPlanning({frame:{...value,sourceStamp:'facts',enabled:true,historyReady:true,storageReady:true,hasContent:true,candidate:state.candidate,authority:state.authority,
   mode:'deterministic',online:true,operator:'test'},ports:{isCurrent:()=>true,readInput:()=>assert.fail('read'),replaceCandidate:(before,after)=>state.setCandidate(current=>current===before?after:current),
   publishAuthority:state.publishAuthority,message:value=>messages.push(value),loading:value=>loading.push(value),resetSelection(){}}});return{state,actions};
 },props);hooks.flush();
 const render=()=>{hooks.render(props);hooks.flush();return hooks.view();};return {hooks,props,render,view:()=>hooks.view(),revision:value=>revision=value,sends,messages,loading};
}
for(const boundary of ['owner-B/library-A','owner-A/library-B'])test(`legacy view and approval are isolated after switching to ${boundary}`,async()=>{
 const f=mount();await f.view().actions.refresh();f.render();assert.equal(f.view().state.authority.revision,12);
 f.view().state.setCandidate({day:f.props.day,planHash:'from-A'});f.render();f.props.scope=boundary;f.revision(1);f.render();
 assert.equal(f.view().state.candidate,null);assert.equal(f.view().state.authority.revision,0);await f.view().actions.approve();assert.deepEqual(f.sends,[]);
 await f.view().actions.refresh();f.render();assert.equal(f.view().state.authority.revision,1);f.hooks.unmount();
});
test('changing transport discards its revision floor while retaining a same-library local draft',async()=>{
 const f=mount();await f.view().actions.refresh();f.view().state.setCandidate({day:f.props.day,planHash:'local-draft'});f.render();
 f.props.transport={...f.props.transport,getCurrentPlan:async()=>({revision:1,candidate:null,history:[]})};f.render();
 assert.equal(f.view().state.authority.revision,0);assert.equal(f.view().state.candidate.planHash,'local-draft');
 await f.view().actions.refresh();f.render();assert.equal(f.view().state.authority.revision,1);f.hooks.unmount();
});
test('an old scope approval completion cannot clear a new scope pending operation',async()=>{
 const f=mount(),old=deferred(),next=deferred();f.props.transport.applyPlan=()=>old.promise;f.view().state.setCandidate({day:f.props.day,planHash:'A'});f.render();
 const first=f.view().actions.approve();f.props.scope='owner-B/library-B';f.props.transport={...f.props.transport,applyPlan:()=>next.promise};f.render();
 f.view().state.setCandidate({day:f.props.day,planHash:'B'});f.render();const second=f.view().actions.approve();const count=f.loading.length;
 old.resolve({status:'ok',revision:{revision:13}});await first;assert.equal(f.loading.length,count);assert.equal(f.view().state.candidate.planHash,'B');
 next.resolve({status:'ok',revision:{revision:1}});await second;f.render();assert.equal(f.view().state.candidate,null);f.hooks.unmount();
});
