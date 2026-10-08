import assert from 'node:assert/strict';
import test from 'node:test';
import {createHooks,loader,tick} from './helpers/causal-harness.mjs';
import {dashboardValue} from './fixtures/dashboard-functions.mjs';
function mount(){
 const hooks=createHooks(),timers=new Map();let id=0;
 const window={setTimeout:fn=>{const key=++id;timers.set(key,fn);return key;},clearTimeout:key=>timers.delete(key),setInterval:()=>++id,clearInterval(){}};
 const useDailyPlanView=loader(hooks.api,{},window)('src/features/planning/use-daily-plan.ts').useDailyPlanView;
 const day='2026-09-17',props={scope:'owner/library',day,ports:{read:async()=>({day,revision:4,decision:'approved'}),project:async value=>({approved:value.revision})}};
 hooks.mount(value=>useDailyPlanView(value.scope,value.day,value.ports),props);hooks.flush();
 const render=()=>{hooks.render(props);hooks.flush();return hooks.view();};
 return {hooks,props,render,view:()=>hooks.view(),run:async()=>{const jobs=[...timers.values()];timers.clear();jobs.forEach(job=>job());await tick();render();}};
}
test('replacing same-day transport preserves the verified approved source through a failed refresh',async()=>{
 const f=mount();await f.run();assert.equal(f.view().source.approved,4);
 f.props.ports={...f.props.ports,read:async()=>{throw Error('offline');}};f.render();await f.run();
 assert.equal(f.view().state.revision,4);assert.deepEqual(f.view().source,{approved:4});assert.equal(f.view().ready,true);assert.equal(f.view().error,'offline');f.hooks.unmount();
});
test('a new day cannot inherit the old day source or revision floor even with a reused scope string',async()=>{
 const f=mount();await f.run();f.props.day='2026-09-18';f.props.ports={...f.props.ports,read:async()=>({day:f.props.day,revision:1,decision:'draft'})};
 f.render();assert.equal(f.view().source,null);assert.equal(f.view().ready,false);await f.run();assert.equal(f.view().state.revision,1);assert.equal(f.view().state.day,'2026-09-18');f.hooks.unmount();
});
test('actual root legacy scope distinguishes library IDs with identical native material',()=>{
 const base={workspaceId:'owner',accountWanted:false,accountLoaded:null,nativeScope:'identical-path-and-content',nativeLibraryId:'library-A'};
 assert.notEqual(dashboardValue('legacyPlanScope',base),dashboardValue('legacyPlanScope',{...base,nativeLibraryId:'library-B'}));
});
