import assert from 'node:assert/strict';
import test from 'node:test';
import * as api from '../src/application/sources/index.ts';
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
function fixture(){
 let connection={id:'old'},owner='A';const notices=[],busy=[];
 const ports={capture:()=>{const expected=connection,scope=owner;return{key:scope,connection:expected,current:()=>owner===scope&&connection===expected,
  user:{userId:scope,displayName:scope,email:''},code:'synthetic',account:()=>false};},
  health:async()=>({version:'fixture',capabilities:[]}),pair:async()=>({id:'new'}),source:async()=>({ok:true,httpStatus:200,payload:{status:'connected',subjects:[{}]}}),
  publish:notice=>{notices.push(notice);if(notice.kind==='paired')connection=notice.connection;if(notice.kind==='expired')connection=null;},
  apply:()=>true,flushActivities:async()=>{},busy:(kind,value)=>busy.push([kind,value]),abort:()=>new AbortController()};
 return{ports,notices,busy,create:()=>api.createCompanionSession(ports),connection:()=>connection,replace:()=>{connection={id:'replacement'};},retire:()=>{owner='B';}};
}
test('a delayed 401 cannot clear a replacement connection before any render',async()=>{
 const f=fixture(),gate=deferred();f.ports.source=()=>gate.promise;const session=f.create(),pending=session.refresh();await Promise.resolve();f.replace();gate.resolve({ok:false,httpStatus:401,payload:{status:'offline'}});await pending;
 assert.equal(f.connection().id,'replacement');assert.equal(f.notices.some(value=>value.kind==='expired'),false);
});
test('an old refresh finally cannot clear the newer refresh busy state',async()=>{
 const f=fixture(),first=deferred(),second=deferred();let calls=0;f.ports.source=()=>++calls===1?first.promise:second.promise;const session=f.create();
 const a=session.refresh();await Promise.resolve();const b=session.refresh();await Promise.resolve();const count=f.busy.length;
 first.resolve({ok:true,httpStatus:200,payload:{status:'connected',subjects:[{}]}});await a;assert.equal(f.busy.length,count);
 second.resolve({ok:true,httpStatus:200,payload:{status:'connected',subjects:[{}]}});await b;assert.deepEqual(f.busy.at(-1),['refresh',false]);
});
test('a new pairing retires an older source read and preserves the new connection',async()=>{
 const f=fixture(),gate=deferred();f.ports.source=()=>gate.promise;const session=f.create(),old=session.refresh();await Promise.resolve();await session.pair();
 gate.resolve({ok:false,httpStatus:401,payload:{status:'offline'}});await old;assert.equal(f.connection().id,'new');assert.equal(f.notices.some(value=>value.kind==='expired'),false);
});
test('pairing response after owner change is ignored',async()=>{
 const f=fixture(),gate=deferred();f.ports.pair=()=>gate.promise;const pending=f.create().pair();await Promise.resolve();f.retire();gate.resolve({id:'new'});assert.equal(await pending,false);assert.equal(f.connection().id,'old');
});
test('a background poll does not replace a pending manual operation',async()=>{
 const f=fixture(),gate=deferred();let sources=0;f.ports.source=()=>{sources++;return gate.promise;};const session=f.create(),manual=session.refresh();await Promise.resolve();const poll=session.poll();
 assert.equal(sources,1);gate.resolve({ok:true,httpStatus:200,payload:{status:'connected',subjects:[{}]}});await Promise.all([manual,poll]);assert.equal(sources,1);
});
