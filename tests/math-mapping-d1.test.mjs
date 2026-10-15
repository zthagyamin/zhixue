import test from 'node:test';
import assert from 'node:assert/strict';
import {D1MathMappingStore} from '../src/infrastructure/math-study/index.ts';
import {mappingFixture,reviewedCases} from './fixtures/math-mapping-fixtures.mjs';
import {activateSyntheticWriter,changeWriterAtCommit} from './helpers/study-writer-race.mjs';

for(const change of ['revoke','expire','replace-library'])test(`mapping publication remains non-durable when qualification changes at commit: ${change}`,async t=>{
 const f=await mappingFixture(t),actor=await activateSyntheticWriter(f.db.binding,f.scope);
 const before=f.db.sqlite.prepare('SELECT * FROM math_variant_mappings_v1').all();
 const reached=changeWriterAtCommit(f.db.binding,f.db.sqlite,f.scope,actor,change,'math_variant_mappings_v1');
 const result=await f.store.publish(f.scope,f.preparation,{...f.provenance,originGrantId:actor.grantId});
 assert.equal(reached(),true);assert.equal(result.durable,false);assert.equal(result.status,'conflict');
 assert.deepEqual(f.db.sqlite.prepare('SELECT * FROM math_variant_mappings_v1').all(),before);
});

test('historical mapping timestamp cannot qualify a grant already expired at actual insertion time',async t=>{
 const f=await mappingFixture(t),actor=await activateSyntheticWriter(f.db.binding,f.scope);
 const expired=new Date(Date.now()-60000).toISOString(),publishedAt=new Date(Date.now()-120000).toISOString();
 f.db.sqlite.prepare('UPDATE account_study_grants SET expires_at=? WHERE grant_id=?').run(expired,actor.grantId);
 const result=await f.store.publish(f.scope,f.preparation,{originGrantId:actor.grantId,publishedAt});
 assert.equal(result.durable,false);assert.equal(f.db.sqlite.prepare('SELECT count(*) AS n FROM math_variant_mappings_v1').get().n,0);
});

for(const example of reviewedCases)test(`real SQLite immutable preparation ${example.templateId} binds complete original and exact duplicate receipt`,async t=>{
 const f=await mappingFixture(t,example),before=f.db.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').get().attempt_json;
 assert.equal(await f.store.supported(),true);
 const first=await f.store.publish(f.scope,f.preparation,f.provenance);assert.equal(first.status,'accepted');assert.equal(first.durable,true);
 const duplicate=await f.store.publish(f.scope,f.preparation,{...f.provenance,publishedAt:'2026-10-08T02:00:00.000Z'});
 assert.equal(duplicate.status,'duplicate');assert.deepEqual(duplicate.record,first.record);
 assert.equal((await f.store.publish(f.scope,{...f.preparation,review:{...f.preparation.review,rationale:f.preparation.review.rationale+' Reviewed again.'}},f.provenance)).status,'conflict');
 assert.deepEqual(await f.store.resolveMapping(f.scope,f.a.binding),f.preparation.mapping);
 assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM math_variant_mappings_v1').get().n,1);
 assert.equal(f.db.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').get().attempt_json,before);
});
test('real SQLite historical binding survives a newer head and rejects other owner/library and changed originals',async t=>{
 const f=await mappingFixture(t);await f.store.publish(f.scope,f.preparation,f.provenance);
 f.db.sqlite.exec("UPDATE account_study_heads SET snapshot_id=NULL,revision=2");
 assert.deepEqual(await f.store.resolveMapping(f.scope,f.a.binding),f.preparation.mapping);
 await assert.rejects(f.store.resolveMapping({...f.scope,userId:'another'},f.a.binding),/scope-binding/);
 await assert.rejects(f.store.resolveMapping({...f.scope,libraryId:'another'},f.a.binding),/scope-binding/);
 f.db.sqlite.exec("UPDATE account_study_item_versions SET item_json=json_set(item_json,'$.practice.prompt','changed original')");
 await assert.rejects(f.store.resolveMapping(f.scope,f.a.binding),/integrity/);
});
test('real SQLite missing source and incomplete published snapshot cannot approve',async t=>{
 const f=await mappingFixture(t);
 await assert.rejects(f.store.publish(f.scope,{...f.preparation,snapshotId:'missing'},f.provenance),/original/);
 await assert.rejects(f.store.publish(f.scope,{...f.preparation,mapping:{...f.preparation.mapping,parentContentHash:'b'.repeat(64)}},f.provenance),/original/);
 await assert.rejects(f.store.publish(f.scope,{...f.preparation,mapping:{...f.preparation.mapping,mappingId:'other'}},f.provenance),/reference/);
 f.db.sqlite.exec('UPDATE account_study_snapshots SET member_count=2');
 await assert.rejects(f.store.publish(f.scope,f.preparation,f.provenance),/incomplete/);
 assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM math_variant_mappings_v1').get().n,0);
});
test('actual published legacy V1 content remains unchanged and cannot gain reviewed mapping',async t=>{
 const f=await mappingFixture(t,reviewedCases[0],{legacy:true}),before=f.db.sqlite.prepare('SELECT item_json FROM account_study_item_versions').get().item_json;
 await assert.rejects(f.store.publish(f.scope,f.preparation,f.provenance),/original-binding/);
 assert.equal(await f.store.resolveMapping(f.scope,f.a.binding),null);
 assert.equal(f.db.sqlite.prepare('SELECT item_json FROM account_study_item_versions').get().item_json,before);
});
for(const [name,change] of [
 ['member',db=>db.sqlite.exec('DELETE FROM account_study_snapshot_members')],
 ['source',db=>db.sqlite.exec("UPDATE account_study_item_versions SET item_json=json_set(item_json,'$.title','changed')")],
 ['publication',db=>db.sqlite.exec('UPDATE account_study_snapshots SET published=0')],
 ['grant',db=>db.sqlite.exec("UPDATE account_study_grants SET state='revoked'")],
 ['profile',db=>db.sqlite.exec('UPDATE account_study_profiles SET library_id=NULL')],
])test(`committing SQLite INSERT rejects ${name} race without durable preparation`,async t=>{
 const f=await mappingFixture(t);let raced=false;
 const binding={prepare(query){if(query.startsWith('INSERT INTO math_variant_mappings_v1')&&!raced){raced=true;change(f.db);}return f.db.binding.prepare(query);}};
 const store=new D1MathMappingStore(binding,f.study),result=await store.publish(f.scope,f.preparation,f.provenance);
 assert.equal(raced,true);assert.deepEqual(result,{status:'conflict',durable:false,record:null});
 assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM math_variant_mappings_v1').get().n,0);
});
test('concurrent exact and conflicting publications preserve first immutable reviewed artifact',async t=>{
 const f=await mappingFixture(t),changed={...f.preparation,review:{...f.preparation.review,rationale:'A different reviewer has supplied a different prepared explanation.'}};
 const results=await Promise.all([f.store.publish(f.scope,f.preparation,f.provenance),f.store.publish(f.scope,changed,f.provenance)]);
 assert.deepEqual(results.map(x=>x.status).sort(),['accepted','conflict']);
 const record=await f.store.readPreparation(f.scope,f.a.binding);assert.ok([f.preparation.review.rationale,changed.review.rationale].includes(record.preparation.review.rationale));
 assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM math_variant_mappings_v1').get().n,1);
});
test('old absent and partial schema are honestly unsupported',async t=>{
 const f=await mappingFixture(t);f.db.sqlite.exec('DROP TABLE math_variant_mappings_v1');
 assert.equal(await f.store.supported(),false);assert.equal(await f.store.resolveMapping(f.scope,f.a.binding),null);
 await assert.rejects(f.store.publish(f.scope,f.preparation,f.provenance),/unsupported/);
 f.db.sqlite.exec('CREATE TABLE math_variant_mappings_v1(record_json text)');assert.equal(await f.store.supported(),false);
});
test('stored preparation is revalidated against its original and unsupported stored version stays unavailable',async t=>{
 const f=await mappingFixture(t);await f.store.publish(f.scope,f.preparation,f.provenance);
 f.db.sqlite.exec("UPDATE math_variant_mappings_v1 SET record_json=json_set(record_json,'$.preparation.review.sourceQuote','fabricated quote')");
 await assert.rejects(f.store.readPreparation(f.scope,f.a.binding),/review-quote-binding/);
 f.db.sqlite.exec('ALTER TABLE math_variant_mappings_v1 RENAME TO previous_math_mappings; CREATE TABLE math_variant_mappings_v1 AS SELECT * FROM previous_math_mappings; UPDATE math_variant_mappings_v1 SET schema_version=2');
 assert.equal(await f.store.supported(),false);assert.equal(await f.store.resolveMapping(f.scope,f.a.binding),null);
});
