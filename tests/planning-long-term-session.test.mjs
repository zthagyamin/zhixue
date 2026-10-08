import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {loadLongTermPlanState,saveLongTermPlanState} from '../app/local-long-term-plan.ts';
import {createLongTermPlanSession} from '../src/application/planning/index.ts';
const raw=JSON.parse(readFileSync(new URL('./fixtures/long-term-plan.json',import.meta.url),'utf8'));
const plan=()=>structuredClone(raw.snapshot??raw);
const state=revision=>revision?{revision,enabled:true,snapshot:plan(),lastOperationId:'operation-'+revision}:{revision:0,enabled:false,snapshot:null,lastOperationId:null};
const mutation=revision=>({expectedRevision:revision,enabled:true,snapshot:plan()});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function setup(transport){let ids=0;const views=[];
 const session=createLongTermPlanSession({scope:'owner/library',transport,newId:()=> 'operation-'+(++ids),publish:value=>views.push(value)});
 return {session,views,ids:()=>ids};
}

test('an older refresh cannot overwrite a later accepted long-term save',async()=>{
 const old=deferred(),f=setup({read:()=>old.promise,write:async()=>({status:'accepted',state:state(2)})});
 const refresh=f.session.refresh();await f.session.save(mutation(1));old.resolve(state(1));await refresh;
 assert.equal(f.session.snapshot().state.revision,2);assert.equal(f.views.at(-1).state.revision,2);
});

test('a delayed save receipt cannot replace a newer observed revision',async()=>{
 const saved=deferred(),entered=deferred(),f=setup({read:async()=>state(3),write:()=>{entered.resolve();return saved.promise;}});
 const write=f.session.save(mutation(1));await entered.promise;await f.session.refresh();saved.resolve({status:'accepted',state:state(2)});assert.equal((await write).revision,2,'The caller receives its own durable receipt, independently of the newer view');
 assert.equal(f.session.snapshot().state.revision,3);
});

test('same pending edit is accepted once and its payload is immutable',async()=>{
 const reply=deferred(),entered=deferred(),commands=[],f=setup({read:async()=>state(0),write:command=>{commands.push(command);entered.resolve();return reply.promise;}});
 const value=mutation(0),first=f.session.save(value),second=f.session.save(structuredClone(value));value.enabled=false;value.snapshot.spec.targetDeadline='2099-01-01';
 await entered.promise;assert.equal(commands.length,1);assert.equal(commands[0].enabled,true);assert.notEqual(commands[0].snapshot.spec.targetDeadline,'2099-01-01');
 reply.resolve({status:'accepted',state:state(1)});await Promise.all([first,second]);assert.equal(f.ids(),1);assert.equal(f.session.snapshot().saving,false);
});

test('committed write with lost reply retries one ID through real local storage',async()=>{
 globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;const scope={workspaceId:'m3-synthetic',libraryId:'library-a'},ids=[];let lost=true;
 const f=setup({read:()=>loadLongTermPlanState(scope),write:async command=>{ids.push(command.operationId);const result=await saveLongTermPlanState(scope,command);if(lost){lost=false;throw Error('reply lost');}return result;}});
 await assert.rejects(f.session.save(mutation(0)),/reply lost/);await f.session.save(mutation(0));
 assert.deepEqual(ids,['operation-1','operation-1']);assert.equal((await loadLongTermPlanState(scope)).revision,1);assert.equal(f.session.snapshot().state.revision,1);
});

test('different edits serialize and preserve explicit revision checks',async()=>{
 const first=deferred(),entered=deferred();let writes=0,active=0,max=0;
 const f=setup({read:async()=>state(0),write:async()=>{active++;max=Math.max(max,active);const n=++writes;if(n===1){entered.resolve();await first.promise;}active--;return {status:n===1?'accepted':'stale',state:state(1)};}});
 const a=f.session.save(mutation(0)),b=f.session.save({...mutation(0),enabled:false});const rejected=assert.rejects(b,/long-term-stale/);
 await entered.promise;assert.equal(writes,1);first.resolve();await a;await rejected;
 assert.equal(max,1);assert.equal(writes,2);assert.equal(f.session.snapshot().state.revision,1);assert.equal(f.session.snapshot().saving,false);
});

test('disposing a scope ignores late reads and prevents queued writes',async()=>{
 globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;const scope={workspaceId:'retired-owner',libraryId:'library-a'};
 const read=deferred(),write=deferred(),entered=deferred();let writes=0;
 const f=setup({read:()=>read.promise,write:async command=>{writes++;const result=await saveLongTermPlanState(scope,command);entered.resolve();await write.promise;return result;}});
 const r=f.session.refresh(),a=f.session.save(mutation(0)),b=f.session.save({...mutation(0),enabled:false});
 const settled=Promise.allSettled([r,a,b]);await entered.promise;f.session.dispose();const count=f.views.length;
 read.resolve(state(1));write.resolve();const outcomes=await settled;await tick();
 assert.deepEqual(outcomes.map(value=>value.status),['rejected','fulfilled','rejected']);assert.equal(outcomes[1].value.revision,1);assert.equal((await loadLongTermPlanState(scope)).revision,1);
 assert.equal(f.views.length,count);assert.equal(writes,1);await assert.rejects(f.session.refresh(),/long-term-source-changed/);
});

test('equal revision with conflicting content is rejected without changing the view',async()=>{
 let current=state(1);const f=setup({read:async()=>current,write:async()=>({status:'accepted',state:state(2)})});
 await f.session.refresh();current={...state(1),enabled:false};await assert.rejects(f.session.refresh(),/long-term-revision-conflict/);
 assert.equal(f.session.snapshot().state.enabled,true);
});
