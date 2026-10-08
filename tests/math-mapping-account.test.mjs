import test from 'node:test';
import assert from 'node:assert/strict';
import {mappingFixture,reviewedCases} from './fixtures/math-mapping-fixtures.mjs';
for(const example of reviewedCases)test(`actual account actions prepare ${example.templateId} from device; browser attempt read and variant carry exact mapping`,async t=>{
 const f=await mappingFixture(t,example),before=f.db.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').get().attempt_json;
 assert.deepEqual((await f.send({action:'math-mapping-read',attemptId:'attempt'})).value,{status:'unavailable'});
 const published=(await f.send({action:'math-mapping-publish',preparation:f.preparation},f.device)).value;
 assert.equal(published.status,'accepted');assert.equal(published.record.provenance.originGrantId,f.device.principal.grantId);
 const read=(await f.send({action:'math-mapping-read',attemptId:'attempt'})).value;
 assert.equal(read.status,'available');assert.deepEqual(read.preparation,f.preparation);
 const variant=(await f.send({action:'math-variant',attemptId:'attempt',seed:22})).value;
 assert.equal(variant.status,'available');assert.deepEqual(variant.mapping,f.preparation.mapping);assert.equal(variant.descriptor.mappingId,f.preparation.mapping.mappingId);
 assert.equal(f.db.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').get().attempt_json,before);
});
test('actual account rejects browser/model-shaped publish, pending grants, wrong scope and caller definitions',async t=>{
 const f=await mappingFixture(t),publish={action:'math-mapping-publish',preparation:f.preparation};
 await assert.rejects(f.send(publish),/action-not-allowed/);
 await assert.rejects(f.send(publish,{principal:{...f.device.principal,kind:'model'}}),/action-not-allowed/);
 await assert.rejects(f.send(publish,{principal:{...f.device.principal,state:'pending'}}),/action-not-allowed/);
 await assert.rejects(f.send({...publish,libraryId:'other'},f.device),/library-mismatch/);
 await assert.rejects(f.send({...publish,ownerId:'other'},f.device),/unknown-study-field/);
 await assert.rejects(f.send({...publish,originGrantId:'caller'},f.device),/unknown-study-field/);
 await assert.rejects(f.send({...publish,preparation:{...f.preparation,approved:true}},f.device),/unknown-study-field/);
 await assert.rejects(f.send({action:'math-mapping-read',attemptId:'attempt',mapping:f.preparation.mapping}),/unknown-study-field/);
 await assert.rejects(f.send({action:'math-mapping-read',attemptId:'attempt',libraryId:'other'}),/library-mismatch/);
 assert.deepEqual((await f.send({action:'math-mapping-read',attemptId:'missing'})).value,{status:'unavailable'});
 assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM math_variant_mappings_v1').get().n,0);
});
test('actual account old schema never fabricates mapping or changes attempt history',async t=>{
 const f=await mappingFixture(t),before=f.db.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').get().attempt_json;f.db.sqlite.exec('DROP TABLE math_variant_mappings_v1');
 assert.deepEqual((await f.send({action:'math-mapping-read',attemptId:'attempt'})).value,{status:'unavailable'});
 assert.deepEqual((await f.send({action:'math-variant',attemptId:'attempt',seed:1})).value,{status:'unavailable'});
 await assert.rejects(f.send({action:'math-mapping-publish',preparation:f.preparation},f.device),/unsupported/);
 assert.equal(f.db.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').get().attempt_json,before);
});
