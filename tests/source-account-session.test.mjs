import assert from 'node:assert/strict';
import test from 'node:test';
import * as api from '../src/application/sources/index.ts';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
const value=(revision=1,events=1)=>({version:{libraryId:'library',snapshotId:'snapshot-'+revision,revision,eventThrough:events,taskThrough:0,observedAt:'2026-09-19T00:00:00Z'}});
function fixture(){
 let active=false,epoch=0,mutation=0,visible=null;const commits=[],statuses=[],receipts=[];
 const ports={capture:()=>{const captured=epoch;return{key:'owner/'+captured,owner:'owner',modeEpoch:captured,ready:true,identity:{userId:'owner'},local:false,paused:false,
  current:()=>captured===epoch,studying:()=>active,mutation:()=>mutation,visible:()=>visible,client:{cached:async()=>null,load:async()=>value()}};},
  version:input=>input.version,prepare:async()=>['receipt'],project:async()=>({verified:true}),publish:(_frame,next,projection)=>{commits.push({next,projection});visible=next;},
  receipts:(_frame,rows)=>receipts.push(rows),status:(_frame,status)=>statuses.push(status),clear(){},identityChanged(){},now:()=> '2026-09-19T00:00:00Z',abort:()=>new AbortController()};
 return{ports,commits,statuses,receipts,create:()=>api.createAccountSourceSession(ports),active:flag=>active=flag,retire:()=>epoch++,mutate:()=>mutation++};
}
test('active practice defers the verified source until a later explicit apply',async()=>{
 const f=fixture(),session=f.create();f.active(true);assert.equal(await session.apply(value()),false);assert.equal(f.commits.length,0);assert.equal(session.pending().version.revision,1);
 f.active(false);assert.equal(await session.apply(session.pending()),true);assert.equal(f.commits.length,1);assert.equal(session.pending(),null);
});
test('newer pending history cannot be replaced by an older page of the same snapshot',async()=>{
 const f=fixture(),session=f.create();f.active(true);await session.apply(value(1,5));await session.apply(value(1,2));assert.equal(session.pending().version.eventThrough,5);
});
test('owner retirement during durable cache preparation does not publish old view or receipts',async()=>{
 const f=fixture(),gate=deferred(),entered=deferred();f.ports.prepare=async()=>{entered.resolve();await gate.promise;return['stored-receipt'];};const session=f.create(),pending=session.apply(value());
 await entered.promise;f.retire();gate.resolve();assert.equal(await pending,false);assert.deepEqual(f.commits,[]);assert.deepEqual(f.receipts,[]);assert.equal(session.pending(),null);
});
test('an answer recorded during projection defers replacement instead of overwriting visible progress',async()=>{
 const f=fixture(),gate=deferred(),entered=deferred();f.ports.project=async()=>{entered.resolve();await gate.promise;return {verified:true};};const session=f.create(),pending=session.apply(value());
 await entered.promise;f.mutate();gate.resolve();assert.equal(await pending,false);assert.equal(f.commits.length,0);assert.ok(session.pending());
});
test('cancelled source reads cannot publish late readiness and new reads proceed independently',async()=>{
 const f=fixture(),gate=deferred();let calls=0;const capture=f.ports.capture;f.ports.capture=()=>{const frame=capture();frame.client.load=async()=>++calls===1?gate.promise:value(2);return frame;};
 const session=f.create(),old=session.read();for(let i=0;i<5;i++)await Promise.resolve();session.cancel();const current=await session.read();gate.resolve(value(1));await old;
 assert.equal(current.version.revision,2);assert.equal(f.commits.length,1);assert.equal(f.commits[0].next.version.revision,2);
});
