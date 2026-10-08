import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB} from 'fake-indexeddb';
import {createAccountMathMappingClient} from '../src/infrastructure/math-study/mapping-client.ts';
import {createMathMappingCache} from '../src/infrastructure/math-study/mapping-cache.ts';
import {reviewedCases,mappingFixture} from './fixtures/math-mapping-fixtures.mjs';
import {variantSource} from './fixtures/math-variant-host-fixture.mjs';
globalThis.indexedDB=indexedDB;
test('client uses actual account read/variant actions and rejects caller definition tampering',async t=>{
 const f=await mappingFixture(t,reviewedCases[2]);await f.send({action:'math-mapping-publish',preparation:f.preparation},f.device);
 const wires=[],fetcher=async(_,init)=>{const wire=JSON.parse(init.body);wires.push(wire);delete wire.expectedUserId;return Response.json((await f.send(wire)).value);};
 const client=createAccountMathMappingClient({ownerId:'owner',libraryId:'library'},{item:f.item,snapshot:f.snapshot},fetcher);
 const record=await client.read('attempt');assert.equal(record.preparation.mapping.mappingId,f.preparation.mapping.mappingId);
 const value=await client.variant('attempt',22,record);assert.equal(value.descriptor.seed,22);assert.equal(wires[1].mapping,undefined);
 const invalid=createAccountMathMappingClient({ownerId:'owner',libraryId:'library'},{item:f.item,snapshot:f.snapshot},async()=>Response.json({...value,status:'available',mapping:record.preparation.mapping,variant:{...value.variant,definition:{...value.variant.definition,answer:'999'}}}));
 await assert.rejects(()=>invalid.variant('attempt',22,record),/binding/);
});
test('cache is historical, scoped, immutable and rejects corrupt source and foreign preparation',async()=>{
 const s=await variantSource(),cache=createMathMappingCache({ownerId:'cache-owner',libraryId:'library'},s);
 assert.equal(await cache.read(),null);await cache.save(s.record);assert.deepEqual(await cache.read(),s.record);
 assert.equal(await createMathMappingCache({ownerId:'other-owner',libraryId:'library'},s).read(),null);
 await assert.rejects(()=>cache.save({...s.record,preparation:{...s.record.preparation,mapping:{...s.record.preparation.mapping,mappingId:'foreign'}}}),/binding/);
 await assert.rejects(()=>cache.save({...s.record,preparation:{...s.record.preparation,review:{...s.record.preparation.review,rationale:'Changed approved review'}}}),/conflict/);
 await assert.rejects(()=>createMathMappingCache({ownerId:'cache-owner',libraryId:'library'},{...s,item:{...s.item,title:'tampered'}}).read(),/integrity/);
});
