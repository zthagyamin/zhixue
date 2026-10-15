import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createPaperReadingGroupClock} from '../src/application/paper-reading-clock/index.ts';
import {createPaperReadingClockStore} from '../app/paper-reading/clock.ts';
import {createHooks,extract,tick,deferred,waitForObservation} from './helpers/causal-harness.mjs';
test('actual reading hook stops counting and reliably saves the final interval before disposal',async()=>{
 globalThis.indexedDB=new IDBFactory();let now=0,interval;const disposed=deferred(),hooks=createHooks();
 const scope={ownerId:'account:clock-lifecycle',libraryId:'local:l',materialFingerprint:'a'.repeat(64)},store=createPaperReadingClockStore();
 const jsx=(type,props)=>({type,props});
 const hook=extract('app/paper-reading/use-clock.tsx','usePaperClock')({...hooks.api,
  Date:{now:()=>now},paperFingerprint:async()=>scope.materialFingerprint,createPaperReadingClockStore:()=>store,
  createPaperReadingGroupClock:options=>{const clock=createPaperReadingGroupClock(options);return {...clock,dispose:()=>{clock.dispose();disposed.resolve();}};},
  PaperReadingClockControls:'Controls',PaperReadingClockDetails:'Details',
  window:{setInterval:callback=>{interval=callback;return 1;},clearInterval(){},addEventListener(){},removeEventListener(){}},
  document:{visibilityState:'visible',hasFocus:()=>true,addEventListener(){},removeEventListener(){}},exports:{},require:()=>({jsx,jsxs:jsx}),
 });
 const Component=()=>hook({paperId:'paper'},{owner:scope.ownerId,library:scope.libraryId,isCurrent:()=>true});
 hooks.mount(Component,{});hooks.flush();await waitForObservation(tick,()=>Boolean(interval)&&hooks.render().controls?.props.state.status==='ready');
 now=5000;interval();let checkpoint;
 await waitForObservation(async()=>{await tick();checkpoint=await store.readGroups(scope);},()=>checkpoint?.groups.at(-1)?.elapsedMs===5000);
 now=7000;hooks.unmount();await disposed.promise;checkpoint=await store.readGroups(scope);
 assert.equal(checkpoint.groups.at(-1).elapsedMs,7000);assert.equal(checkpoint.revision,3);
});
