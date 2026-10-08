import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory} from 'fake-indexeddb';
import {createAccountStudyClient} from '../app/account-study-client.ts';
import {createAccountReadCache} from '../app/account-study-read-cache.ts';
import {createAccountPreview} from './fixtures/account-preview.mjs';
import {sealStudyRecord} from '../app/account-study-record.ts';
import {recordBody} from './fixtures/account-study-fixtures.mjs';
import {attempt} from './fixtures/task-event-fixtures.mjs';
const origin='http://127.0.0.1:3991';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{resolve,reject,promise};};
async function fixture(t){
  globalThis.indexedDB=new IDBFactory();const preview=await createAccountPreview({origin,scenario:'partial-15'});t.after(()=>preview.close());
  const calls=[];let gate=null,fail=false;
  const fetcher=async(url,init={})=>{const target=new URL(String(url),origin);calls.push({url:target,init});
    if(gate&&target.searchParams.get('action')==='bootstrap')await gate.promise;
    init.signal?.throwIfAborted();if(fail)throw new Error('offline');
    return preview.handle(new Request(target,{...init,headers:{...init.headers,Origin:origin}}));};
  const client=()=>createAccountStudyClient({companionUrl:'http://127.0.0.1:43121',expectedUserId:preview.userId,fetcher});
  return {calls,client,fetcher,userId:preview.userId,setGate:value=>{gate=value;},setOffline:value=>{fail=value;}};
}
test('unchanged and incremental loads reuse immutable items and retain complete history',async t=>{
  const f=await fixture(t),client=f.client(),cold=await client.load();assert.equal(cold.records.length,3);
  const coldItems=f.calls.filter(call=>call.url.searchParams.get('action')==='items').length;assert.equal(coldItems,2);f.calls.length=0;
  const warm=await client.load();assert.equal(warm.records.length,3);assert.equal(f.calls.filter(call=>call.url.searchParams.get('action')==='items').length,0);
  assert.ok(f.calls.some(call=>call.url.searchParams.get('action')==='records'&&call.url.searchParams.get('after')==='3'));
  const item=warm.bundle.items[1],event=await attempt('cache-new-event',new Date().toISOString(),0,1,true,{item:{kind:'word',key:item.itemKey}});
  const record=await sealStudyRecord(await recordBody({contentHash:item.contentHash,roundId:'cache-new-round',attemptId:'cache-new-attempt',event}));
  assert.equal((await client.appendRecords([record])).results[0].durable,true);f.calls.length=0;
  const updated=await client.load();assert.equal(updated.records.length,4);assert.equal(updated.records[3].record.event.eventId,'cache-new-event');
  assert.ok(f.calls.some(call=>call.url.searchParams.get('action')==='records'&&call.url.searchParams.get('after')==='3'));
  const restarted=f.client();assert.equal((await restarted.cached()).records.length,4);
  f.setOffline(true);await assert.rejects(restarted.load(),/offline/);assert.equal((await restarted.cached()).records.length,4);
});
test('same-account concurrent readers share work and one cancellation does not abort another',async t=>{
  const f=await fixture(t),gate=deferred();f.setGate(gate);const a=new AbortController();
  const first=f.client().load({signal:a.signal}),second=f.client().load();const rejected=assert.rejects(first,{name:'AbortError'});
  a.abort();gate.resolve();await rejected;const value=await second;assert.equal(value.records.length,3);
  assert.equal(f.calls.filter(call=>call.url.searchParams.get('action')==='bootstrap').length,1);
  value.bundle.items[0].title='caller mutation';assert.notEqual((await f.client().cached()).bundle.items[0].title,'caller mutation');
});

test('a known-library reader and a discovering reader tolerate a same-owner cache generation race',async t=>{
  const f=await fixture(t),known=f.client();await known.load();const discovering=f.client(),gate=deferred();f.setGate(gate);
  const results=Promise.all([known.load(),discovering.load()]);await new Promise(resolve=>setImmediate(resolve));gate.resolve();const values=await results;
  assert.ok(values.every(value=>value.records.length===3));assert.equal((await discovering.cached()).records.length,3);
});
test('cancelling all readers does not publish a checkpoint and the next call retries',async t=>{
  const f=await fixture(t),gate=deferred();f.setGate(gate);const controller=new AbortController(),client=f.client();
  const pending=client.load({signal:controller.signal}),rejected=assert.rejects(pending,{name:'AbortError'});controller.abort();gate.resolve();await rejected;
  assert.equal(await client.cached(),null);f.setGate(null);assert.equal((await client.load()).records.length,3);
});
test('clearing while bootstrap is pending cannot republish the just-cleared cache',async t=>{
  const f=await fixture(t),client=f.client();await client.load();const gate=deferred();f.setGate(gate);
  const pending=client.load(),rejected=assert.rejects(pending,/abort|cancel|stale|clear/i);
  await new Promise(resolve=>setImmediate(resolve));await client.clearReadCache();gate.resolve();await rejected;
  assert.equal(await f.client().cached(),null);
});
test('a different browser read pool cannot adopt a clear epoch created after its request started',async t=>{
  const f=await fixture(t),client=f.client();await client.load();const gate=deferred();f.setGate(gate);
  const pending=client.load(),rejected=assert.rejects(pending,/abort|cancel|stale|clear/i);await new Promise(resolve=>setTimeout(resolve,10));
  const other=createAccountStudyClient({companionUrl:'http://127.0.0.1:43121',expectedUserId:f.userId,fetcher:(...args)=>f.fetcher(...args)});
  await other.clearReadCache();gate.resolve();await rejected;assert.equal(await other.cached(),null);
});
test('a read finishing after explicit library replacement cannot rebind the client to the old library',async t=>{
  const f=await fixture(t),cache=createAccountReadCache(),entered=deferred(),release=deferred(),commit=cache.commit.bind(cache);
  cache.commit=async(...args)=>{const saved=await commit(...args);entered.resolve();await release.promise;return saved;};t.after(()=>release.resolve());
  const fetcher=async(url,init)=>String(url).includes('/v1/account-sync/prepare')?Response.json({grantId:'new-library-grant',libraryId:'library-b',tokenHash:'a'.repeat(64),label:'Synthetic machine'}):f.fetcher(url,init);
  const client=createAccountStudyClient({companionUrl:'http://127.0.0.1:43121',sessionToken:'synthetic-pair',expectedUserId:f.userId,fetcher,cache});
  const pending=client.load(),rejected=assert.rejects(pending,/abort|cancel|library|scope/i);await entered.promise;
  await client.prepare('Synthetic machine',{replaceLibrary:true});release.resolve();await rejected;
  // Registration is prepared, not activated: the server must refuse B until
  // its Companion activates it, but the client must never silently return to A.
  await assert.rejects(client.getPlanState('2026-09-05'),/library-mismatch/);assert.equal(f.calls.at(-1).url.searchParams.get('libraryId'),'library-b');
});
