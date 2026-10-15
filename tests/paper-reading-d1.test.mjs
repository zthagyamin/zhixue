import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openD1} from './helpers/sqlite-d1.mjs';
import {D1PaperReadingStore} from '../src/infrastructure/paper-reading/d1-store.ts';
import {paperReadingUnit, applyPaperReadingMutation} from '../src/domain/paper-reading/workspace.ts';
import {paperReadingTask} from '../src/domain/paper-reading/evidence.ts';

const scope = {ownerId:'account:user-a', libraryId:'account:library-a'};
const source = { ...scope, materialFingerprint:'a'.repeat(64), sourceVersion:'b'.repeat(64), sectionId:'methods',
  paragraphs:[{id:'p1', rawEn:'ReLU avoids saturation for positive inputs.', pageNumber:3}]};
const unit = (s=source, unitId='unit1') => paperReadingUnit({schemaVersion:1, unitId, title:'A paper', goal:'Explain the activation mechanism', source:s});
const mutation = (kind, extra={}, expectedRevision=0, operationId=kind+expectedRevision) =>
  ({schemaVersion:1, operationId, unitId:'unit1', expectedRevision, kind, ...extra});
const register = () => mutation('register', {unit:unit()});
const task = () => paperReadingTask({taskId:'task1', revision:1, source, origin:'ai', goal:unit().goal, ability:'mechanism',
  question:'Why does ReLU avoid saturation for positive inputs?', reference:[{point:'It avoids saturation.', paragraphId:'p1', quote:'avoids saturation'}]});

async function fixture(t, {migrate=true, path=':memory:'}={}) {
  const db=await openD1(path); t.after(()=>db.sqlite.close());
  if(migrate && !db.sqlite.prepare("SELECT 1 FROM sqlite_master WHERE name='paper_reading_workspaces_v1'").get())
    db.sqlite.exec(await readFile(new URL('../drizzle/0025_paper_reading_workspaces_v1.sql', import.meta.url), 'utf8'));
  db.sqlite.exec("INSERT OR IGNORE INTO learning_accounts(user_id) VALUES ('user-a'),('user-b'); INSERT OR IGNORE INTO account_study_libraries(user_id,library_id) VALUES ('user-a','library-a'),('user-a','library-b'),('user-b','library-a');");
  return {...db, store:new D1PaperReadingStore(db.binding)};
}
const storedRow = db => db.sqlite.prepare('SELECT * FROM paper_reading_workspaces_v1').get();
const putRaw = (db, value, revision=value.revision) => db.sqlite.prepare('UPDATE paper_reading_workspaces_v1 SET workspace_json=?,revision=? WHERE user_id=? AND library_id=? AND unit_id=?')
  .run(JSON.stringify(value), revision, 'user-a', 'library-a', 'unit1');

test('D1 registers authoritative reading source without a formal question snapshot and restores it exactly', async t=>{
  const db=await fixture(t);
  assert.equal(await db.store.supported(), true);
  const receipt=await db.store.mutate(scope, register());
  assert.equal(receipt.status, 'accepted'); assert.equal(receipt.durable, true);
  assert.deepEqual((await db.store.read(scope, 'unit1')).unit, unit());
  const row=storedRow(db);
  assert.equal(row.user_id, 'user-a'); assert.equal(row.library_id, 'library-a'); assert.equal(row.unit_id, 'unit1');
  assert.equal(row.revision, 1); assert.equal(receipt.workspace.revision, 1);
  assert.deepEqual(await new D1PaperReadingStore(db.binding).read(scope, 'unit1'), receipt.workspace);
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM account_study_snapshots').get().n, 0);
});

test('D1 owner/library/unit isolation rejects non-account and non-closed scopes and mismatched sources', async t=>{
  const db=await fixture(t); await db.store.mutate(scope, register());
  for(const other of [{ownerId:'account:user-b',libraryId:scope.libraryId}, {ownerId:scope.ownerId,libraryId:'account:library-b'}]) {
    assert.equal(await db.store.read(other, 'unit1'), null);
    await assert.rejects(db.store.mutate(other, register()), /scope.*binding|binding.*scope/);
  }
  assert.equal(await db.store.read(scope, 'other-unit'), null);
  for(const invalid of [{ownerId:'user-a', libraryId:scope.libraryId}, {...scope, libraryId:'local:library-a'}, {...scope, authority:'service'}, {...scope, ownerId:'account:'}])
    await assert.rejects(db.store.read(invalid, 'unit1'), /scope/);
  await assert.rejects(db.store.read(scope, ''), /unit|invalid/);
  const missing={ownerId:'account:user-missing',libraryId:'account:library-a'};
  await assert.rejects(db.store.mutate(missing, mutation('register', {unit:unit({...source,...missing})})), /FOREIGN KEY/);
  assert.equal(db.sqlite.prepare('SELECT count(*) n FROM paper_reading_workspaces_v1').get().n, 1);
});

test('missing D1 table is explicitly unsupported and cannot silently restore empty data', async t=>{
  const db=await fixture(t, {migrate:false});
  db.sqlite.exec('DROP TABLE IF EXISTS paper_reading_workspaces_v1');
  assert.equal(await db.store.supported(), false);
  await assert.rejects(db.store.read(scope, 'unit1'), /paper-reading-unsupported/);
  await assert.rejects(db.store.mutate(scope, register()), /paper-reading-unsupported/);
});

test('public D1 writes cannot inject service tasks, feedback, grades or authority flags', async t=>{
  const db=await fixture(t); await db.store.mutate(scope, register());
  await assert.rejects(db.store.mutate(scope, mutation('task', {task:task()}, 1)), /service-only/);
  await db.store.writeService(scope, mutation('task', {task:task()}, 1));
  await db.store.mutate(scope, mutation('submit', {answer:'Positive inputs avoid saturation.', submittedAt:'2026-10-08T08:00:00Z',referenceSeen:false}, 2));
  const feedback=mutation('feedback',{attemptId:'task1:first',answerRevision:1,taskRevision:1,evaluation:{status:'resolved',outcome:'correct',matched:['Avoids saturation'],issues:[],explanation:'Matches the cited mechanism.'}},3);
  await assert.rejects(db.store.mutate(scope, feedback), /service-only/);
  const receipt=await db.store.writeService(scope, feedback);
  assert.equal(receipt.workspace.attempts[0].evaluation.status, 'resolved');
  await assert.rejects(db.store.mutate(scope, mutation('pause', {paused:true,activeSeconds:30,authority:'service'},4)), /fields/);
  await assert.rejects(db.store.mutate(scope, mutation('pause', {paused:true,activeSeconds:30,rating:'good'},4)), /fields/);
  // Replaying a saved service operation through the public entry is also forbidden.
  await assert.rejects(db.store.mutate(scope, feedback), /service-only/);
});

test('D1 duplicate identity compares normalized exact mutation; source registry is immutable', async t=>{
  const db=await fixture(t); await db.store.mutate(scope, register());
  const reversed=Object.fromEntries(Object.entries(register()).reverse());
  const duplicate=await db.store.mutate(scope, reversed);
  assert.equal(duplicate.status,'duplicate'); assert.equal(duplicate.durable,true);
  const collision=await db.store.mutate(scope, {...register(),unit:{...unit(),title:'Changed'}});
  assert.equal(collision.status,'conflict'); assert.equal(collision.durable,false);
  const replace=await db.store.mutate(scope, mutation('register',{unit:unit({...source,sourceVersion:'c'.repeat(64)})},1,'replace'));
  assert.equal(replace.status,'conflict'); assert.equal(replace.durable,false);
  assert.deepEqual((await db.store.read(scope,'unit1')).unit,unit());
});

test('D1 preserves first-answer reference observation after reveal, retry and restoration', async t=>{
  const db=await fixture(t); await db.store.mutate(scope,register());
  await db.store.writeService(scope,mutation('task',{task:task()},1));
  await db.store.mutate(scope,mutation('draft',{answer:'Original answer',referenceSeen:false},2));
  await db.store.mutate(scope,mutation('submit',{answer:'Original answer',submittedAt:'2026-10-08T08:00:00Z',referenceSeen:false},3));
  await db.store.mutate(scope,mutation('reference',{},4));
  await db.store.mutate(scope,mutation('retry',{attemptId:'retry1',purpose:'remediation'},5));
  await db.store.mutate(scope,mutation('reference',{},6));
  await db.store.mutate(scope,mutation('submit',{answer:'After reference',submittedAt:'2026-10-08T08:01:00Z',referenceSeen:true},7));
  const receipt=await db.store.mutate(scope,mutation('pause',{paused:true,activeSeconds:60},8));
  const current=await new D1PaperReadingStore(db.binding).read(scope,'unit1');
  assert.deepEqual(current,receipt.workspace);
  assert.equal(current.attempts[0].submission.answer,'Original answer'); assert.equal(current.attempts[0].referenceSeen,false);
  assert.equal(current.attempts[1].submission.answer,'After reference'); assert.equal(current.attempts[1].referenceSeen,true);
  assert.equal(current.attempts[1].parentAttemptId,'task1:first'); assert.equal(current.paused,true); assert.equal(current.activeSeconds,60);
});

test('async reads and writes pin the caller scope before the first await', async t=>{
  const db=await fixture(t); const callerScope={...scope};
  const saving=db.store.mutate(callerScope,register());callerScope.ownerId='account:user-b';
  assert.equal((await saving).status,'accepted');
  const readingScope={...scope};const reading=db.store.read(readingScope,'unit1');readingScope.libraryId='account:library-b';
  assert.deepEqual((await reading).unit,unit());
  assert.equal(await db.store.read(callerScope,'unit1'),null);
});

test('D1 read validates revision, row keys, source owner/library and replayed aggregate on every read', async t=>{
  const db=await fixture(t); const initial=(await db.store.mutate(scope,register())).workspace;
  for(const change of [w=>({...w,answer:'forged'}), w=>({...w,operations:[]}), w=>({...w,revision:99})]) {
    putRaw(db,change(initial)); await assert.rejects(db.store.read(scope,'unit1'), /corrupt|binding/);
    await assert.rejects(db.store.mutate(scope,mutation('pause',{paused:true,activeSeconds:1},1)),/corrupt|binding/);
  }
  for(const [field,value] of [['ownerId','account:user-b'],['libraryId','account:library-b']]) {
    const other=applyPaperReadingMutation(null,mutation('register',{unit:unit({...source,[field]:value})})).workspace;
    putRaw(db,other); await assert.rejects(db.store.read(scope,'unit1'),/scope.*binding|binding.*scope/);
  }
  const otherUnit=applyPaperReadingMutation(null,{...register(),unitId:'different',unit:unit(source,'different')}).workspace;
  putRaw(db,otherUnit); await assert.rejects(db.store.read(scope,'unit1'), /unit.*binding|binding.*unit/);
  putRaw(db,initial,7); await assert.rejects(db.store.read(scope,'unit1'),/corrupt|revision/);
  db.sqlite.prepare('UPDATE paper_reading_workspaces_v1 SET workspace_json=?').run('{bad json');
  await assert.rejects(db.store.read(scope,'unit1'), /JSON|Unexpected|corrupt/);
});

function gateWrites(binding, onWrite) {
  return {prepare(sql) {
    const wrap=statement=>({bind:(...args)=>wrap(statement.bind(...args)), first:(...args)=>statement.first(...args),
      all:(...args)=>statement.all(...args), run:async()=>{await onWrite(sql);return statement.run();}});
    return wrap(binding.prepare(sql));
  }};
}

test('real SQLite CAS across two D1 connections never replaces the winner', async t=>{
  const directory=await mkdtemp(join(tmpdir(),'reading-d1-'));
  const path=join(directory,'store.sqlite'); const a=await fixture(t,{path});
  const b=await openD1(path,false); t.after(()=>b.sqlite.close()); await a.store.mutate(scope,register());
  t.after(()=>rm(directory,{recursive:true,force:true}));
  let arrivals=0, release; const ready=new Promise(resolve=>{release=resolve;});
  const gate=async sql=>{if(sql.startsWith('UPDATE paper_reading_workspaces_v1')) {if(++arrivals===2) release();await ready;}};
  const first=new D1PaperReadingStore(gateWrites(a.binding,gate));
  const second=new D1PaperReadingStore(gateWrites(b.binding,gate));
  // A colliding operation ID alone cannot prove durability: its exact mutation must match.
  const receipts=await Promise.all([first.mutate(scope,mutation('pause',{paused:true,activeSeconds:10},1,'shared-op')),
    second.mutate(scope,mutation('pause',{paused:false,activeSeconds:20},1,'shared-op'))]);
  assert.deepEqual(receipts.map(r=>r.status).sort(),['accepted','conflict']);
  const current=await a.store.read(scope,'unit1'); assert.equal(current.revision,2); assert.equal(current.operations.length,2);
  for(const receipt of receipts) assert.equal(receipt.durable,receipt.status==='accepted');
  assert.deepEqual(await new D1PaperReadingStore(b.binding).read(scope,'unit1'),current);
});

test('concurrent identical D1 operations produce one accepted write and one durable duplicate', async t=>{
  const db=await fixture(t);await db.store.mutate(scope,register());
  let arrivals=0,release;const ready=new Promise(resolve=>{release=resolve;});
  const gate=async sql=>{if(sql.startsWith('UPDATE paper_reading_workspaces_v1')){if(++arrivals===2)release();await ready;}};
  const a=new D1PaperReadingStore(gateWrites(db.binding,gate)),b=new D1PaperReadingStore(gateWrites(db.binding,gate));
  const change=mutation('pause',{paused:true,activeSeconds:10},1,'shared-op');
  const receipts=await Promise.all([a.mutate(scope,change),b.mutate(scope,Object.fromEntries(Object.entries(change).reverse()))]);
  assert.deepEqual(receipts.map(r=>r.status).sort(),['accepted','duplicate']);
  assert.equal(receipts.every(r=>r.durable),true);
  assert.equal((await db.store.read(scope,'unit1')).operations.length,2);
});

test('racing registration uses insert-on-conflict and preserves the first immutable source', async t=>{
  const db=await fixture(t); let arrivals=0,release; const ready=new Promise(resolve=>{release=resolve;});
  const gate=async sql=>{if(sql.startsWith('INSERT INTO paper_reading_workspaces_v1')){if(++arrivals===2)release();await ready;}};
  const a=new D1PaperReadingStore(gateWrites(db.binding,gate)),b=new D1PaperReadingStore(gateWrites(db.binding,gate));
  const receipts=await Promise.all([a.mutate(scope,register()),b.mutate(scope,{...register(),unit:{...unit(),title:'Competing title'},operationId:'other-register'})]);
  assert.deepEqual(receipts.map(r=>r.status).sort(),['accepted','conflict']);
  assert.equal((await db.store.read(scope,'unit1')).revision,1);
});

test('commit with lost acknowledgement is confirmed by exact readback and subsequent retry is duplicate', async t=>{
  const db=await fixture(t); let lost=true;
  const binding={prepare(sql){const wrap=statement=>({bind:(...args)=>wrap(statement.bind(...args)),first:(...args)=>statement.first(...args),
    run:async()=>{const result=await statement.run();if(lost&&sql.startsWith('INSERT INTO paper_reading_workspaces_v1')){lost=false;throw Error('lost-write-ack');}return result;}});return wrap(db.binding.prepare(sql));}};
  const store=new D1PaperReadingStore(binding),receipt=await store.mutate(scope,register());
  assert.equal(receipt.status,'duplicate');assert.equal(receipt.durable,true);
  assert.equal((await store.mutate(scope,register())).status,'duplicate');
  assert.equal((await store.read(scope,'unit1')).operations.length,1);
});

test('uncommitted failure never returns durable accepted and leaves existing data unchanged', async t=>{
  const db=await fixture(t);const before=(await db.store.mutate(scope,register())).workspace;
  const store=new D1PaperReadingStore(gateWrites(db.binding,async sql=>{if(sql.startsWith('UPDATE'))throw Error('storage-unavailable');}));
  await assert.rejects(store.mutate(scope,mutation('pause',{paused:true,activeSeconds:10},1)),/storage-unavailable/);
  assert.deepEqual(await db.store.read(scope,'unit1'),before);
});

test('migration and reading writes preserve every existing table schema and row; sidecar has only required fields and FK', async t=>{
  const db=await fixture(t,{migrate:false}); db.sqlite.exec('DROP TABLE IF EXISTS paper_reading_workspaces_v1');
  const tables=db.sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const rows=tables.map(({name})=>({name,rows:db.sqlite.prepare('SELECT * FROM '+name).all()}));
  db.sqlite.exec(await readFile(new URL('../drizzle/0025_paper_reading_workspaces_v1.sql',import.meta.url),'utf8'));
  await db.store.mutate(scope,register());await db.store.writeService(scope,mutation('task',{task:task()},1));
  await db.store.mutate(scope,mutation('submit',{answer:'No saturation for positive inputs.',submittedAt:'2026-10-08T08:00:00Z',referenceSeen:true},2));
  assert.deepEqual(db.sqlite.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'paper_reading_workspaces_v1' ORDER BY name").all(),tables);
  assert.deepEqual(tables.map(({name})=>({name,rows:db.sqlite.prepare('SELECT * FROM '+name).all()})),rows);
  assert.deepEqual(db.sqlite.prepare('PRAGMA table_info(paper_reading_workspaces_v1)').all().map(c=>c.name),['user_id','library_id','unit_id','revision','workspace_json']);
  assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_list(paper_reading_workspaces_v1)').all().map(f=>[f.table,f.from,f.to]),
    [['account_study_libraries','user_id','user_id'],['account_study_libraries','library_id','library_id']]);
});
