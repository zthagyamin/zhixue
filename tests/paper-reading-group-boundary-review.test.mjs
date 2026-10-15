import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createPaperReadingGroupClock} from '../src/application/paper-reading-clock/index.ts';
import {createPaperReadingClockStore} from '../app/paper-reading/clock.ts';
import {createHooks,extract,tick,waitForObservation,deferred} from './helpers/causal-harness.mjs';

const scope={ownerId:'account:group-review',libraryId:'local:l',materialFingerprint:'a'.repeat(64)};

test('first public group commit rejects a legacy offset that differs from the actual retained V1 record',async()=>{
 globalThis.indexedDB=new IDBFactory();const store=createPaperReadingClockStore();
 const legacy={schemaVersion:1,scope,revision:1,operationId:'legacy',elapsedMs:12000,paused:false};
 await store.save(scope,legacy,0);
 const initial={schemaVersion:1,scope,revision:1,operationId:'initial',legacyElapsedMs:0,
  groups:[{groupId:'group',elapsedMs:0,paused:false,completed:false}]};
 await assert.rejects(store.saveGroups(scope,initial,0),/legacy|history|conflict/);
 assert.equal(await store.readGroups(scope),null);assert.deepEqual(await store.read(scope),legacy);
 const legitimate={...initial,legacyElapsedMs:legacy.elapsedMs};
 assert.deepEqual(await store.saveGroups(scope,legitimate,0),legitimate);
 assert.deepEqual(await store.read(scope),legacy);
});

test('failed automatic completed-group start retains hook observation and retry restores visible active counting',async()=>{
 globalThis.indexedDB=new IDBFactory();const store=createPaperReadingClockStore();let now=0,id=0,fail=false,interval,clock;
 const seed=createPaperReadingGroupClock({scope,store,now:()=>now,makeId:()=>`seed-${++id}`});
 await seed.load();await seed.completeGroup();seed.dispose();fail=true;
 const failing={...store,async saveGroups(...args){
  if(fail&&args[1].groups.length===2)throw Error('quota');return store.saveGroups(...args);
 }};
 const hooks=createHooks(),disposed=deferred(),jsx=(type,props)=>({type,props});
 const hook=extract('app/paper-reading/use-clock.tsx','usePaperClock')({...hooks.api,
  Date:{now:()=>now},paperFingerprint:async()=>scope.materialFingerprint,createPaperReadingClockStore:()=>failing,
  createPaperReadingGroupClock:options=>{
   clock=createPaperReadingGroupClock(options);return {...clock,dispose(){clock.dispose();disposed.resolve();}};
  },
  PaperReadingClockControls:'Controls',PaperReadingClockDetails:'Details',
  window:{setInterval:callback=>{interval=callback;return 1;},clearInterval(){},addEventListener(){},removeEventListener(){}},
  document:{visibilityState:'visible',hasFocus:()=>true,addEventListener(){},removeEventListener(){}},
  exports:{},require:()=>({jsx,jsxs:jsx}),
 });
 const paper={paperId:'review-paper'},services={owner:scope.ownerId,library:scope.libraryId,isCurrent:()=>true};
 hooks.mount(()=>hook(paper,services),{});hooks.flush();
 try{
  await waitForObservation(tick,()=>hooks.render().controls?.props.state.saveStatus==='failed');
  assert.equal(hooks.render().controls.props.state.groupCompleted,true);
  fail=false;hooks.render().controls.props.onRetry();
  await waitForObservation(tick,()=>clock.snapshot().saveStatus==='saved');
  const recovered=hooks.render().controls.props.state;
  assert.equal(recovered.groupCompleted,false);assert.equal(recovered.saveStatus,'saved');
  assert.equal(typeof interval,'function');assert.equal(clock.snapshot().counting,true);
  now=10000;assert.equal(clock.snapshot().elapsedMs,10000);
  assert.equal((await store.readGroups(scope)).groups.length,2);
 }finally{hooks.unmount();await disposed.promise;}
});

test('receipt loss in the draft prerequisite preserves the original new-group boundary until retry',async()=>{
 globalThis.indexedDB=new IDBFactory();const real=createPaperReadingClockStore();let now=0,id=0,lost=false;
 const store={...real,async saveGroups(...args){
  const receipt=await real.saveGroups(...args);if(lost){lost=false;throw Error('lost-receipt');}return receipt;
 }};
 const clock=createPaperReadingGroupClock({scope,store,now:()=>now,makeId:()=>`boundary-${++id}`});
 await clock.load();clock.setActive(true);clock.setVisible(true);const previous=clock.snapshot().groupId;
 now=5000;lost=true;await assert.rejects(clock.startGroup(),/lost-receipt/);
 assert.equal(clock.snapshot().groupId,previous);assert.equal(clock.snapshot().counting,false);
 now=95000;await clock.flush();const retained=await real.readGroups(scope);
 assert.equal(retained.groups.length,2);assert.notEqual(clock.snapshot().groupId,previous);
 assert.equal(retained.groups[0].elapsedMs,5000);assert.equal(retained.groups[0].completed,true);
 assert.equal(clock.snapshot().elapsedMs,0);assert.equal(clock.snapshot().saveStatus,'saved');
 await clock.flush();assert.equal((await real.readGroups(scope)).groups.length,2);clock.dispose();
});

test('initial group restore failure can retry into observed visible counting without crediting the failed wait',async()=>{
 globalThis.indexedDB=new IDBFactory();const real=createPaperReadingClockStore();let now=0,fail=true,interval,clock;
 const store={...real,async readGroups(...args){if(fail)throw Error('initial-open-failed');return real.readGroups(...args);}};
 const hooks=createHooks(),disposed=deferred(),jsx=(type,props)=>({type,props});
 const hook=extract('app/paper-reading/use-clock.tsx','usePaperClock')({...hooks.api,
  Date:{now:()=>now},paperFingerprint:async()=>scope.materialFingerprint,createPaperReadingClockStore:()=>store,
  createPaperReadingGroupClock:options=>{
   clock=createPaperReadingGroupClock(options);return {...clock,dispose(){clock.dispose();disposed.resolve();}};
  },
  PaperReadingClockControls:'Controls',PaperReadingClockDetails:'Details',
  window:{setInterval:callback=>{interval=callback;return 1;},clearInterval(){},addEventListener(){},removeEventListener(){}},
  document:{visibilityState:'visible',hasFocus:()=>true,addEventListener(){},removeEventListener(){}},
  exports:{},require:()=>({jsx,jsxs:jsx}),
 });
 const paper={paperId:'retry-bootstrap'},services={owner:scope.ownerId,library:scope.libraryId,isCurrent:()=>true};
 hooks.mount(()=>hook(paper,services),{});hooks.flush();
 try{
  await waitForObservation(tick,()=>hooks.render().controls?.props.state.status==='unavailable');
  now=90000;fail=false;hooks.render().controls.props.onRetry();
  await waitForObservation(tick,()=>clock.snapshot().status==='ready');
  assert.equal(hooks.render().controls.props.state.status,'ready');assert.equal(typeof interval,'function');
  assert.equal(clock.snapshot().counting,true);assert.equal(clock.snapshot().elapsedMs,0);
  now=91000;interval();let saved;
  await waitForObservation(async()=>{await tick();saved=await real.readGroups(scope);},()=>saved?.groups.at(-1).elapsedMs===1000);
  assert.equal(hooks.render().controls.props.state.elapsedMs,1000);
 }finally{hooks.unmount();await disposed.promise;}
});
