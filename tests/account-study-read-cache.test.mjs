import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {IDBFactory,IDBObjectStore} from 'fake-indexeddb';
let api;try{api=await import('../app/account-study-read-cache.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const V=JSON.parse(readFileSync(new URL('./fixtures/account-study-v1.json',import.meta.url))),PV=JSON.parse(readFileSync(new URL('./fixtures/account-planning-v1.json',import.meta.url)));
const model=()=>structuredClone({loaded:{bundle:V.bundle,bundles:[V.bundle],catalog:PV.catalog,catalogs:[PV.catalog],facts:PV.facts,records:V.records.map((record,i)=>({sequence:i+1,record})),writebacks:[],eventThrough:3,taskThrough:3},operations:[],operationThrough:0,receiptThrough:0,executions:[],executionThrough:0});
const scope={userId:'cache-user',libraryId:'library-a'};
function setup(){globalThis.indexedDB=new IDBFactory();assert.equal(typeof api?.createAccountReadCache,'function');return api.createAccountReadCache();}
test('independent cache publishes complete checkpoints only and isolates accounts',async()=>{
  const cache=setup(),empty=await cache.read(scope);assert.equal(empty.model,null);
  await cache.commit(scope,model(),empty.token);const saved=await cache.read(scope);assert.equal(saved.model.loaded.records.length,3);
  assert.equal((await cache.read({...scope,userId:'another-user'})).model,null);
  const latest=await cache.latest(scope.userId);assert.equal(latest.scope.libraryId,scope.libraryId);
  saved.model.loaded.bundle.items[0].title='changed';assert.notEqual((await cache.read(scope)).model.loaded.bundle.items[0].title,'changed');
});
test('stale writers and clears cannot resurrect an old checkpoint',async()=>{
  const cache=setup(),before=await cache.read(scope);await cache.commit(scope,model(),before.token);
  await assert.rejects(cache.commit(scope,model(),before.token),/cache.*stale/);
  const pending=await cache.read(scope);await cache.clearUser(scope.userId);
  await assert.rejects(cache.commit(scope,model(),pending.token),/cache.*stale/);assert.equal(await cache.latest(scope.userId),null);
  assert.equal((await cache.read(scope)).model,null);
});
test('malformed, cancelled and failed transactions keep the previous complete checkpoint',async()=>{
  const cache=setup();await cache.commit(scope,model(),(await cache.read(scope)).token);const before=await cache.read(scope),bad=model();bad.loaded.records.pop();
  await assert.rejects(cache.commit(scope,bad,before.token));const controller=new AbortController();controller.abort();
  await assert.rejects(cache.commit(scope,model(),before.token,{signal:controller.signal}),{name:'AbortError'});
  const original=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(){throw new DOMException('quota','QuotaExceededError');};
  try{await assert.rejects(cache.commit(scope,model(),before.token),/quota/);}finally{IDBObjectStore.prototype.put=original;}
  const after=await cache.read(scope);assert.deepEqual(after.token,before.token);assert.equal(after.model.loaded.records.length,3);
});
test('new cache does not upgrade or block the databases used by old pages',async()=>{
  const cache=setup(),open=(name,version)=>new Promise((resolve,reject)=>{const request=indexedDB.open(name,version);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  const old=await open('zhixue-local-study-v1',3),account=await open('zhixue-account-study-v1',1);
  await cache.commit(scope,model(),(await cache.read(scope)).token);
  assert.equal(old.version,3);assert.equal(account.version,1);old.close();account.close();
});
