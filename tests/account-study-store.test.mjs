import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve,sep,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {openD1,migrateD1} from './helpers/sqlite-d1.mjs';
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';
import {sealStudyRecord} from '../app/account-study-record.ts';
import {wordBody,snapshotBody,recordBody} from './fixtures/account-study-fixtures.mjs';
let api;
try {api=await import('../db/account-study-store.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;}
function ready(){assert.equal(typeof api?.AccountStudyStore,'function','Account-scoped D1 storage must exist');}
const scope={userId:'user-a',libraryId:'library-a'};
async function data(overrides={},count=1){const items=await Promise.all(Array.from({length:count},(_,i)=>sealStudyItem(wordBody({itemKey:i===0?'word:tree':`word:item-${i}`}))));
  return {items,snapshot:await sealStudySnapshot(snapshotBody(items,overrides))};}
async function setup(t){ready();const db=await openD1();t.after(()=>db.sqlite.close());db.sqlite.exec("INSERT INTO learning_accounts(user_id) VALUES ('user-a'),('user-b')");
  return {...db,store:new api.AccountStudyStore(db.binding)};}
async function publish(store,overrides={},owner=scope){const bundle=await data(overrides);assert.equal((await store.putSnapshot(owner,bundle,0)).status,'accepted');return bundle;}
async function eventFor(bundle,id='event-one'){const body=await recordBody({libraryId:bundle.snapshot.libraryId,snapshotId:bundle.snapshot.snapshotId,contentHash:bundle.items[0].contentHash});
  if(id!=='event-one'){const {attempt}=await import('./fixtures/task-event-fixtures.mjs');body.event=await attempt(id,'2026-09-01T00:01:00Z',0,1);body.roundId=`round-${id}`;}
  return sealStudyRecord(body);}
test('new cloud schema preserves old tables and data when applied incrementally',async t=>{
  ready();const {sqlite}=await openD1(':memory:',false);t.after(()=>sqlite.close());await migrateD1(sqlite,0,3);
  sqlite.exec("INSERT INTO learning_accounts(user_id) VALUES ('legacy-user')");
  sqlite.exec("INSERT INTO learning_item_states(user_id,item_kind,item_key,numeric_value,state) VALUES ('legacy-user','word','kept',2,'in-progress')");
  const before=sqlite.prepare('SELECT * FROM learning_item_states').all();await migrateD1(sqlite,4);
  assert.deepEqual(sqlite.prepare('SELECT * FROM learning_item_states').all(),before);
  assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE name='account_study_records'").get());
});
test('cloud snapshots and records are scoped to both account and library',async t=>{
  const {store}=await setup(t);const bundle=await publish(store);
  assert.equal(await store.getSnapshot({userId:'user-b',libraryId:'library-a'}),null);
  assert.equal(await store.getSnapshot({userId:'user-a',libraryId:'library-b'}),null);
  assert.equal((await store.getSnapshot(scope)).snapshotHash,bundle.snapshot.snapshotHash);
  const other=await publish(store,{libraryId:'library-b'},{userId:'user-a',libraryId:'library-b'});
  await store.appendRecord(scope,await eventFor(bundle));await store.appendRecord({userId:'user-a',libraryId:'library-b'},await eventFor(other));
  assert.equal((await store.listRecordsAfter(scope,0,10)).records.length,1);
  assert.equal((await store.listRecordsAfter({userId:'user-b',libraryId:'library-a'},0,10)).records.length,0);
});
test('records freeze both hashes and same ID cannot be rebound to another round',async t=>{
  const {store}=await setup(t);const bundle=await publish(store),record=await eventFor(bundle);
  const first=await store.appendRecord(scope,record);assert.equal(first.status,'accepted');
  const duplicate=await store.appendRecord(scope,record);assert.equal(duplicate.status,'duplicate');assert.equal(duplicate.sequence,first.sequence);
  const changed={...record,roundId:'other-round'};delete changed.envelopeHash;
  assert.equal((await store.appendRecord(scope,await sealStudyRecord(changed))).status,'conflict');
  assert.equal((await store.listRecordsAfter(scope,0,10)).records[0].record.envelopeHash,record.envelopeHash);
});
test('staging is invisible, rejects incomplete publication and supports bounded page uploads',async t=>{
  const {store,binding}=await setup(t),bundle=await data({},43);
  await store.beginSnapshot(scope,bundle.snapshot);assert.equal(await store.getSnapshot(scope,'snapshot-a'),null);
  await assert.rejects(store.completeSnapshot(scope,'snapshot-a',0),/incomplete/);
  for(let start=0;start<bundle.items.length;start+=20){binding.queryCount=0;
    await store.stageSnapshotItems(scope,'snapshot-a',bundle.items.slice(start,start+20).map((item,i)=>({position:start+i,item})));
    assert.ok(binding.queryCount<=50,'one upload page must fit a bounded D1 invocation');}
  assert.equal((await store.completeSnapshot(scope,'snapshot-a',0)).status,'accepted');
  let position=0,received=[];
  do {const page=await store.getSnapshotItems(scope,'snapshot-a',position,20);received.push(...page.items);position=page.nextPosition;}while(position!==null);
  assert.deepEqual(received.map(item=>item.itemKey),bundle.items.map(item=>item.itemKey));
});
test('concurrent publishers on separate connections cannot replace the same head revision',async t=>{
  ready();const dir=await mkdtemp(join(tmpdir(),'zhixue-account-store-')),path=join(dir,'test.sqlite');const a=await openD1(path),b=await openD1(path,false);
  t.after(async()=>{a.sqlite.close();b.sqlite.close();if(!resolve(dir).startsWith(resolve(tmpdir())+sep)||!basename(dir).startsWith('zhixue-account-store-')) throw new Error('Unsafe test cleanup');await rm(dir,{recursive:true,force:true});});
  a.sqlite.exec("INSERT INTO learning_accounts(user_id) VALUES ('user-a')");const one=new api.AccountStudyStore(a.binding),two=new api.AccountStudyStore(b.binding);
  const outcomes=await Promise.all([one.putSnapshot(scope,await data(),0),two.putSnapshot(scope,await data({snapshotId:'snapshot-b'}),0)]);
  assert.deepEqual(outcomes.map(value=>value.status).sort(),['accepted','stale']);
  assert.equal((await one.getSnapshot(scope)).revision,1);
});
test('historical published snapshots remain available without rolling the active head back',async t=>{
  const {store}=await setup(t);const older=await publish(store),newer=await data({snapshotId:'snapshot-b',revision:2});
  assert.equal((await store.putSnapshot(scope,newer,1)).status,'accepted');
  assert.equal((await store.putSnapshot(scope,older,0)).status,'duplicate');
  assert.equal((await store.getSnapshot(scope)).snapshotId,'snapshot-b');
  assert.equal((await store.getSnapshot(scope,'snapshot-a')).snapshotHash,older.snapshot.snapshotHash);
  assert.equal((await store.appendRecord(scope,await eventFor(older))).status,'accepted');
});
test('record cursor uses the returned page, not the newest global sequence',async t=>{
  const {store}=await setup(t),bundle=await publish(store);
  for(const id of ['event-one','event-two','event-three']) await store.appendRecord(scope,await eventFor(bundle,id));
  const first=await store.listRecordsAfter(scope,0,1);assert.equal(first.records.length,1);assert.equal(first.nextCursor,first.records[0].sequence);
  const second=await store.listRecordsAfter(scope,first.nextCursor,1);assert.equal(second.records[0].record.event.eventId,'event-two');
  const third=await store.listRecordsAfter(scope,second.nextCursor,1);assert.equal(third.records[0].record.event.eventId,'event-three');assert.equal(third.nextCursor,null);
});
test('missing snapshot, mismatched library and wrong member content never become accepted records',async t=>{
  const {store}=await setup(t),bundle=await data(),record=await eventFor(bundle);
  await assert.rejects(store.appendRecord(scope,record),/snapshot/);
  await store.putSnapshot(scope,bundle,0);
  await assert.rejects(store.appendRecord({userId:'user-a',libraryId:'library-b'},record),/scope/);
  const changed={...record,contentHash:'b'.repeat(64)};delete changed.envelopeHash;
  await assert.rejects(store.appendRecord(scope,await sealStudyRecord(changed)),/membership|binding/);
});
test('failed upload batch rolls back its members and versions and never activates a snapshot',async t=>{
  const {store,sqlite}=await setup(t),bundle=await data({},2);await store.beginSnapshot(scope,bundle.snapshot);
  sqlite.exec("CREATE TRIGGER injected_failure BEFORE INSERT ON account_study_snapshot_members WHEN NEW.position=1 BEGIN SELECT RAISE(ABORT,'injected upload failure'); END;");
  await assert.rejects(store.stageSnapshotItems(scope,'snapshot-a',bundle.items.map((item,position)=>({item,position}))),/injected/);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM account_study_snapshot_members').get().n,0);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM account_study_item_versions').get().n,0);
  assert.equal(await store.getSnapshot(scope),null);
  sqlite.exec('DROP TRIGGER injected_failure');
  assert.equal((await store.putSnapshot(scope,bundle,0)).status,'accepted');
});
test('foreign keys reject cross-account content and cursor query uses its scoped index',async t=>{
  const {store,sqlite}=await setup(t);await publish(store);
  assert.throws(()=>sqlite.prepare('INSERT INTO account_study_snapshot_members(user_id,library_id,snapshot_id,position,item_key,content_hash) VALUES (?,?,?,?,?,?)')
    .run('user-b','library-a','snapshot-a',0,'word:tree','a'.repeat(64)),/FOREIGN KEY/);
  const plan=sqlite.prepare('EXPLAIN QUERY PLAN SELECT record_json FROM account_study_records WHERE user_id=? AND library_id=? AND sequence>? ORDER BY sequence LIMIT ?').all('user-a','library-a',0,20);
  assert.ok(plan.some(row=>/USING INDEX/.test(row.detail)));
});
test('stage rejects a different valid version before poisoning the fixed manifest',async t=>{
  const {store,sqlite}=await setup(t),bundle=await data({},2);await store.beginSnapshot(scope,bundle.snapshot);
  const changed=wordBody();changed.word.meaning='另一版本';const wrong=await sealStudyItem(changed);
  await assert.rejects(store.stageSnapshotItems(scope,'snapshot-a',[{position:0,item:wrong},{position:1,item:bundle.items[1]}]),/manifest|member/);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM account_study_item_versions').get().n,0);
  await store.stageSnapshotItems(scope,'snapshot-a',bundle.items.map((item,position)=>({item,position})));
  assert.equal((await store.completeSnapshot(scope,'snapshot-a',0)).status,'accepted');
});
test('a semantic conflict rejects the entire upload page before any valid neighbor is stored',async t=>{
  const {store,sqlite}=await setup(t),bundle=await data({},2);await store.beginSnapshot(scope,bundle.snapshot);
  await store.stageSnapshotItems(scope,'snapshot-a',[{position:0,item:bundle.items[0]}]);
  const changed=wordBody();changed.word.meaning='冲突版本';const wrong=await sealStudyItem(changed);
  await assert.rejects(store.stageSnapshotItems(scope,'snapshot-a',[{position:1,item:bundle.items[1]},{position:0,item:wrong}]),/manifest|member/);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM account_study_snapshot_members').get().n,1);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM account_study_item_versions').get().n,1);
});
