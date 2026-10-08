import assert from 'node:assert/strict';
import test from 'node:test';
import {createSyncCoordinator} from '../src/application/sync/index.ts';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function fixture(){
 let binding='A';const notices=[],busy=[],calls=[];
 const frame={key:'A',owner:'account:A',accountOwner:'account:A',ready:true,current:()=>binding==='A',
  legacy:{enabled:true,events:[{eventId:'old'}],send:async()=>({snapshot:{cursor:1},processedEventIds:['old']})},
  account:{drain:async()=>{},refresh:async()=>calls.push('account-refresh')},journal:async()=>({recovered:0,failed:0,states:[]}),targets:async()=>({projectionMismatches:[]}),
  bootstrap:async()=>({supported:true}),diagnostics:async()=>{},recovery:async()=>({complete:true,pending:{coreUploads:[],coreWritebacks:[],recovery:[],assistance:[],tasks:[],legacyQueues:false}})};
 const coordinator=createSyncCoordinator({capture:()=>({...frame,legacy:{...frame.legacy},account:{...frame.account}}),publish:value=>notices.push(value),busy:(...value)=>busy.push(value),now:()=> '2026-09-19T00:00:00Z'});
 return {coordinator,frame,notices,busy,calls,switch:()=>{binding='B';frame.key='B';frame.owner='account:B';frame.accountOwner='account:B';frame.current=()=>binding==='B';}};
}
test('a stale cloud reply cannot publish metadata or status into the new owner',async()=>{
 const f=fixture(),gate=deferred();f.frame.legacy.send=()=>gate.promise;const old=f.coordinator.flushLegacy();await Promise.resolve();f.switch();gate.resolve({snapshot:{cursor:99},processedEventIds:['old']});await old;
 assert.deepEqual(f.notices.map(value=>value.kind),['cloud-start']);assert.deepEqual(f.busy,[['legacy',true]]);
});
test('same-scope concurrent cloud drains share one request and one busy lifetime',async()=>{
 const f=fixture(),gate=deferred();let calls=0;f.frame.legacy.send=()=>{calls++;return gate.promise;};const first=f.coordinator.flushLegacy(),second=f.coordinator.flushLegacy();await Promise.resolve();assert.equal(calls,1);
 gate.resolve({snapshot:{cursor:1}});await Promise.all([first,second]);assert.deepEqual(f.busy,[['legacy',true],['legacy',false]]);
});
test('an old account drain cannot reopen the account source after changing mode',async()=>{
 const f=fixture(),gate=deferred();f.frame.account.drain=()=>gate.promise;const old=f.coordinator.flushAccount();await Promise.resolve();f.switch();gate.resolve();await old;assert.deepEqual(f.calls,[]);
});
test('an old finally does not clear a new scope manual sync busy state',async()=>{
 const f=fixture(),a=deferred(),b=deferred();f.frame.legacy.events=[];f.frame.bootstrap=()=>a.promise;const old=f.coordinator.manual();for(let i=0;i<10;i++)await Promise.resolve();
 f.switch();f.frame.bootstrap=()=>b.promise;const next=f.coordinator.manual();for(let i=0;i<10;i++)await Promise.resolve();a.resolve({supported:true});await old;
 assert.equal(f.busy.filter(([name,value])=>name==='manual'&&!value).length,0);b.resolve({supported:true});await next;assert.equal(f.busy.filter(([name,value])=>name==='manual'&&!value).length,1);
});
test('manual success comes from post-drain recovery receipts, not download support',async()=>{
 const f=fixture();f.frame.recovery=async()=>({complete:true,pending:{coreUploads:['still-pending'],coreWritebacks:[],recovery:[],assistance:[],tasks:[],legacyQueues:false}});
 await f.coordinator.manual();assert.equal(f.notices.at(-1).status,'error');assert.match(f.notices.at(-1).message,/云端待接收 1 条/);
});
test('explicit invalidation retires a pending receipt even before the source frame rerenders',async()=>{
 const f=fixture(),gate=deferred();f.frame.legacy.send=()=>gate.promise;const old=f.coordinator.flushLegacy();await Promise.resolve();f.coordinator.invalidate();gate.resolve({snapshot:{cursor:9}});await old;
 assert.equal(f.notices.some(value=>value.kind==='cloud-receipt'),false);
});
