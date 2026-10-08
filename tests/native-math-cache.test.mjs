import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB,IDBDatabase} from 'fake-indexeddb';
import {createNativeMathSourceCache} from '../src/infrastructure/math-study/native-source-cache.ts';
import {studyHash} from '../src/domain/sync/index.ts';
import {fixture} from './fixtures/native-math-fixtures.mjs';

globalThis.indexedDB=indexedDB;
test('actual IndexedDB reload retains old source and raw claim despite source update and mutable UI metadata',async()=>{
 const f=await fixture();await f.cache.save(f.capture);await f.cache.bindAttempt('original',f.binding,f.capture.captureId);await f.cache.saveClaim(f.claim);
 const newIdentity={...f.identity,contentHash:'d'.repeat(64)},body={schemaVersion:1,identity:newIdentity,item:{...f.item,contentHash:newIdentity.contentHash,practice:{...f.item.practice,answer:'5'}}};
 const newer={...body,captureId:await studyHash(body)};await f.cache.save(newer);
 const cache=createNativeMathSourceCache(f.scope);assert.deepEqual(await cache.read(f.binding,'original'),f.capture);
 await cache.saveClaim({...f.claim,attempt:{...f.attempt,revision:9,checkpoint:{...f.attempt.checkpoint,phase:'feedback'}}});
 assert.deepEqual(await cache.readClaim('original'),f.claim);
 const escaped=await cache.readClaim('original');escaped.attempt.answer='tampered caller';assert.deepEqual(await cache.readClaim('original'),f.claim);
 for(const patch of [{stepInput:{...f.claim.stepInput,text:'3'}},{attempt:{...f.attempt,answer:'5',submitted:{...f.attempt.submitted,answer:'5'}}}])await assert.rejects(cache.saveClaim({...f.claim,...patch}),/conflict/);
 await assert.rejects(cache.bindAttempt('original',{...f.binding,contentHash:newIdentity.contentHash},newer.captureId),/conflict/);
});
test('owner and library stores isolate sources, raw claims and historical links',async()=>{
 const f=await fixture();await f.cache.save(f.capture);await f.cache.bindAttempt('original',f.binding,f.capture.captureId);await f.cache.saveClaim(f.claim);
 const other=createNativeMathSourceCache({...f.scope,userId:'other'});assert.equal(await other.byIdentity(f.identity),null);assert.equal(await other.readClaim('original'),null);
 await assert.rejects(other.bindAttempt('original',f.binding,f.capture.captureId),/scope/);
 const library=createNativeMathSourceCache({...f.scope,libraryId:'local-vault:'+'e'.repeat(64)});await assert.rejects(library.save(f.capture),/scope/);
});
test('concurrent conflicting captures admit only one and aborted writes cannot claim durability',async()=>{
 const f=await fixture(),body={schemaVersion:1,identity:f.identity,item:{...f.item,practice:{...f.item.practice,answer:'wrong'}}};
 const results=await Promise.allSettled([f.cache.save(f.capture),f.cache.save({...body,captureId:await studyHash(body)})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const next=await fixture(),original=IDBDatabase.prototype.transaction;
 IDBDatabase.prototype.transaction=function(...args){const tx=original.apply(this,args);if(args[1]==='readwrite')queueMicrotask(()=>tx.abort());return tx;};
 try{await assert.rejects(next.cache.save(next.capture));}finally{IDBDatabase.prototype.transaction=original;}
 assert.equal(await next.cache.byIdentity(next.identity),null);
});
