import assert from 'node:assert/strict';
import test from 'node:test';
import {createHooks,loader,tick,deferred} from './helpers/causal-harness.mjs';
import {createTaskPlanningSession} from '../app/task-planning-session.ts';
import {catalog,DAY} from './fixtures/task-event-fixtures.mjs';
async function mount(){
 const hooks=createHooks(),useNativePlanningView=loader(hooks.api)('src/features/planning/use-native-planning.ts').useNativePlanningView;
 const bundle={context:{catalog:catalog(),sourceReviews:[],captureReviews:[],observedAt:'2026-08-31T05:00:00.000Z',planRevision:0,capabilities:['task-planning-v1']},
  localEvents:[],companionRecords:[],taskEvents:[],legacyItemKeys:[],history:{local:'complete',cloud:'not-applicable',companion:'complete',tasks:'complete'},authority:{revision:0,candidate:null,history:[]}};
 const props={sessionKey:{},enabled:true,storageReady:true,workspaceId:'owner',day:DAY,evidenceEpoch:'initial',loadBundle:async()=>bundle,
  createSession:runtime=>createTaskPlanningSession({...runtime,loadDraft:async()=>null,saveDraft:()=>assert.fail('unexpected save'),putTaskEvent:()=>assert.fail('unexpected event'),client:{}})};
 hooks.mount(useNativePlanningView,props);hooks.flush();await tick();const render=()=>{hooks.render(props);hooks.flush();return hooks.view();};render();
 assert.equal(hooks.view().state.ready,true);return {hooks,props,render,view:()=>hooks.view()};
}
for(const [field,value] of [['storageReady',false],['enabled',false],['sessionKey',null]])test(`native hook hides and invalidates the old session when ${field} changes`,async()=>{
 const f=await mount(),old=f.view().session;f.props[field]=value;f.render();assert.equal(f.view().session,null);assert.equal(f.view().state,null);assert.equal(old.snapshot().ready,false);f.hooks.unmount();
});
test('a replacement native session never exposes the old ready view while its source is pending',async()=>{
 const f=await mount(),old=f.view().session,gate=deferred(),bundle=await f.props.loadBundle();f.props.sessionKey={};f.props.loadBundle=()=>gate.promise;
 f.render();assert.equal(f.view().session,null);assert.equal(old.snapshot().ready,false);gate.resolve(bundle);await tick();f.render();
 assert.notEqual(f.view().session,old);assert.equal(f.view().state.ready,true);f.hooks.unmount();
});
