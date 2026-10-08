import assert from 'node:assert/strict';
import test from 'node:test';
import * as api from '../src/application/sync/index.ts';
import {applyTargetNotice} from '../src/domain/sync/index.ts';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
function fixture(){
 const event={eventId:'A',coreHash:'core-A',eventType:'practice-attempt'};let current=true;
 const notices=[],ports={owner:'account:owner',accountOwner:'account:owner',hasCompanion:true,isOwnerCurrent:()=>current,isViewCurrent:()=>current,
  readSubmitted:async()=>null,findAccount:async()=>null,readAccount:async()=>null,drainAccount:async()=>({results:[]}),
  cloud:async()=>({accepted:['A']}),companion:async()=>({ok:true,httpStatus:200,receipt:{status:'accepted',companionReceipt:{durable:true}}}),
  submitted:{cloud:()=>assert.fail('no journal'),companion:()=>assert.fail('no journal'),summary:()=>assert.fail('no journal')},
  notice:(scope,patch)=>notices.push({scope,patch}),auxiliary(){},dashboard(){}};
 return {event,ports,notices,retire:()=>{current=false;},create:()=>api.createEventDispatcher(ports)};
}
test('fallback account acknowledgement only updates its bound cloud target',async()=>{
 const f=fixture();f.ports.findAccount=async()=>({record:{libraryId:'original-library',event:f.event},cloud:'pending'});
 f.ports.readAccount=async()=>({record:{event:f.event},cloud:'acked'});await f.create().cloud(f.event);
 assert.deepEqual(f.notices,[{scope:{workspaceId:'account:owner',eventId:'A',libraryId:'original-library'},patch:{cloud:'acked'}}]);
});
test('legacy bound cloud and native results do not publish after owner retirement',async()=>{
 const f=fixture(),gate=deferred(),entered=deferred();f.ports.cloud=()=>{entered.resolve();return gate.promise;};const pending=f.create().cloud(f.event);await entered.promise;f.retire();gate.resolve({accepted:['A']});assert.deepEqual(await pending,{accepted:['A']});assert.deepEqual(f.notices,[]);
});
test('old event A receipts cannot mark displayed B as received or regress applied proof',()=>{
 const before={workspaceId:'account:owner',eventId:'B',libraryId:'library-B',cloud:'pending',companion:'applied'};
 assert.equal(applyTargetNotice(before,{workspaceId:'account:owner',eventId:'A'},{cloud:'acked',companion:'pending'}),before);
 assert.deepEqual(applyTargetNotice(before,{workspaceId:'account:owner',eventId:'B'},{cloud:'acked'}),{...before,cloud:'acked'});
 assert.equal(applyTargetNotice(before,{workspaceId:'account:owner',eventId:'B'},{companion:'pending'}).companion,'applied');
});
test('native pending projection remains pending, while a structured conflict is visible',async()=>{
 const f=fixture();f.ports.companion=async()=>({ok:true,httpStatus:200,receipt:{status:'accepted',projectionStatus:'pending',companionReceipt:{durable:true}}});await f.create().companion(f.event);assert.equal(f.notices.at(-1).patch.companion,'pending');
 f.ports.companion=async()=>({ok:false,httpStatus:409,receipt:{status:'conflict'}});await f.create().companion(f.event);assert.equal(f.notices.at(-1).patch.companion,'conflict');
});
