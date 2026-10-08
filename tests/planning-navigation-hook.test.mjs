import assert from 'node:assert/strict';
import test from 'node:test';
import {createHooks,loader,deferred,tick} from './helpers/causal-harness.mjs';
import {generateTaskPlan,studyPracticeGroups,emptySubjectRound} from '../src/domain/planning/index.ts';
import {vocabularyInput} from './fixtures/task-plan-input.mjs';
async function mount(){
 const hooks=createHooks(),timers=new Map();let sequence=0,ticket=0;
 const load=loader(hooks.api,{}, {setTimeout:fn=>{const id=++sequence;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)});
 const usePlanningNavigation=load('src/features/planning/use-planning-navigation.ts').usePlanningNavigation;
 const input=vocabularyInput(4),plan=await generateTaskPlan(input),events=[];
 const source={ready:true,plan,catalog:input.catalog,libraryId:'library',completedTaskIds:[],startedTaskIds:[],pendingItemByTask:{},context:{}};
 const props={scope:{owner:'A',libraryId:'library',day:plan.day,mode:'native'},stamp:'facts',resetKey:'A-day',active:()=>true,busy:false,pending:()=>false,captureBoundary:()=>()=>true,
  clock:{advance:()=>++ticket,matches:id=>id===ticket},loading:value=>events.push(['busy',value]),reset:()=>events.push(['reset']),ports:{
   prepareLeave:()=>()=>true,loadNative:async()=>source,loadAccount:async()=>source,groups:(value,ids)=>studyPracticeGroups(value.plan,value.catalog,()=> 'recall',ids),
   verify:async()=>{},persistStarted:async(_source,_ids,current)=>{assert.equal(current(),true);events.push(['persist']);return true;},groupItems:(_source,group)=>({keys:group.itemKeys,completedKeys:[]}),
   getRound:()=>undefined,activateRound:()=>emptySubjectRound(),enter:()=>events.push(['enter']),returnToday:()=>events.push(['today']),openNote(){},message:value=>events.push(['message',value]),
  }};
 const render=()=>{hooks.render(props);hooks.flush();};hooks.mount(usePlanningNavigation,props);hooks.flush();
 return {hooks,props,source,events,render,api:()=>hooks.view(),runTimers:()=>{const callbacks=[...timers.values()];timers.clear();callbacks.forEach(fn=>fn());}};
}

test('subject entry reaches the application navigator in both account and native modes',async()=>{
 for(const mode of ['native','account']){
  const f=await mount();f.props.scope.mode=mode;f.render();
  await f.api().startSubject('vocab');assert.equal(f.events.filter(([type])=>type==='enter').length,1);
  assert.equal(f.events.filter(([type])=>type==='persist').length,mode==='native'?1:0);f.hooks.unmount();
 }
});
test('navigation hook rejects a source ABA change before locking tasks',async()=>{
 const f=await mount(),gate=deferred(),entered=deferred();f.props.ports.verify=async()=>{entered.resolve();await gate.promise;};
 const pending=f.api().startNative(f.source.plan.tasks[0].taskId);await entered.promise;
 f.props.stamp='changed';f.render();f.props.stamp='facts';f.render();gate.resolve();await pending;
 assert.equal(f.events.some(([type])=>type==='persist'||type==='enter'),false);f.hooks.unmount();
});
test('a retired operation cannot clear loading owned by a newer navigation',async()=>{
 const f=await mount(),first=deferred(),second=deferred();let reads=0;
 f.props.ports.loadNative=async()=>{await (++reads===1?first.promise:second.promise);return f.source;};
 const old=f.api().startNative(f.source.plan.tasks[0].taskId),latest=f.api().startNative(f.source.plan.tasks[0].taskId);
 first.resolve();await old;assert.deepEqual(f.events.filter(([type])=>type==='busy'),[['busy',true],['busy',true]]);
 second.resolve();await latest;assert.equal(f.events.at(-1)[1],false);assert.equal(f.events.filter(([type])=>type==='enter').length,1);f.hooks.unmount();
});
test('our task lock and entry update do not strand loading or cancel valid entry',async()=>{
 const f=await mount();f.props.ports.persistStarted=async(_source,_ids,current)=>{f.props.busy=true;f.render();assert.equal(current(),true);return true;};
 f.props.ports.enter=()=>{f.events.push(['enter']);f.props.stamp='new-selection';f.render();};
 await f.api().startNative(f.source.plan.tasks[0].taskId);
 assert.equal(f.events.filter(([type])=>type==='enter').length,1);assert.deepEqual(f.events.at(-1),['busy',false]);f.hooks.unmount();
});
test('deferred day reset does not erase a newer navigation, while a new day cancels old reads',async()=>{
 const f=await mount(),gate=deferred();f.props.ports.loadNative=async()=>{await gate.promise;return f.source;};
 const pending=f.api().startNative(f.source.plan.tasks[0].taskId);f.runTimers();assert.equal(f.events.some(([type])=>type==='reset'),false);
 f.props.scope={...f.props.scope,day:'2099-01-02'};f.props.resetKey='new-day';f.render();f.runTimers();
 gate.resolve();await pending;assert.equal(f.events.filter(([type])=>type==='reset').length,1);assert.equal(f.events.some(([type])=>type==='enter'),false);f.hooks.unmount();
});
test('unmounted navigation cannot persist or publish when source read resolves',async()=>{
 const f=await mount(),gate=deferred();f.props.ports.loadNative=async()=>{await gate.promise;return f.source;};
 const pending=f.api().startNative(f.source.plan.tasks[0].taskId);f.hooks.unmount();const count=f.events.length;gate.resolve();await pending;await tick();assert.equal(f.events.length,count);
});
test('switching account mode or library resets retired loading even without a new plan hash',async()=>{
 const f=await mount(),gate=deferred();f.runTimers();f.props.ports.loadNative=async()=>{await gate.promise;return null;};
 const pending=f.api().startNative(f.source.plan.tasks[0].taskId);
 f.props.scope={...f.props.scope,libraryId:'account-library',mode:'account'};f.props.busy=true;f.render();f.runTimers();
 assert.deepEqual(f.events.at(-1),['busy',false]);gate.resolve();await pending;assert.deepEqual(f.events.at(-1),['busy',false]);f.hooks.unmount();
});
test('a host boundary invalidated before React renders prevents the old navigation from persisting',async()=>{
 const f=await mount(),gate=deferred();let current=true;
 f.props.captureBoundary=()=>()=>current;f.render();f.props.ports.loadNative=async()=>{await gate.promise;return f.source;};
 const pending=f.api().startNative(f.source.plan.tasks[0].taskId);current=false;gate.resolve();await pending;
 assert.equal(f.events.some(([type])=>type==='persist'||type==='enter'),false);f.hooks.unmount();
});
