import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {openD1,migrateD1} from './helpers/sqlite-d1.mjs';
import {AccountStudyStore} from '../db/account-study-store.ts';
import {AccountStudyAccessStore} from '../db/account-study-access-store.ts';
import {sealAccountAssistance} from '../app/assistance-record.ts';
import {sealAssistanceSummary} from '../app/assistance-summary.ts';
import {sealStudyRecord} from '../app/account-study-record.ts';
import {attempt} from './fixtures/task-event-fixtures.mjs';
const v=JSON.parse(await readFile(new URL('./fixtures/account-study-v1.json',import.meta.url))),summary=JSON.parse(await readFile(new URL('./fixtures/assistance-summary-v1.json',import.meta.url)));
let api;try{api=await import('../db/account-assistance-store.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const owner={userId:'user-a',libraryId:'library-a'},now=()=>new Date('2026-09-01T00:00:00.000Z');
async function setup(t){
  assert.equal(typeof api?.AccountAssistanceStore,'function');const {sqlite,binding}=await openD1();t.after(()=>sqlite.close());
  const core=new AccountStudyStore(binding),access=new AccountStudyAccessStore(binding,now),store=new api.AccountAssistanceStore(binding,now);
  const secret=Buffer.alloc(32,6).toString('base64url');await access.register(owner.userId,{grantId:'writer-a',libraryId:owner.libraryId,tokenHash:createHash('sha256').update(secret).digest('hex'),label:'Synthetic',expectedProfileRevision:0,replaceLibrary:false});await access.activate(secret);
  await core.putSnapshot(owner,v.bundle,0);await core.appendRecord(owner,v.records[0]);
  return{sqlite,binding,core,access,store,record:await sealAccountAssistance(v.records[0],summary)};
}
test('summary append is isolated, immutable and does not modify learning events or projections',async t=>{
  const f=await setup(t),before=f.sqlite.prepare('SELECT * FROM account_study_records').all();
  const first=await f.store.append(owner,f.record);assert.equal(first.status,'accepted');assert.equal(first.durable,true);
  assert.equal((await f.store.append(owner,f.record)).status,'duplicate');
  const {summaryHash,summaryId,...body}=summary;void summaryHash;void summaryId;
  const changed=await sealAccountAssistance(v.records[0],await sealAssistanceSummary({...body,preSubmitAssistance:[]}));
  assert.equal((await f.store.append(owner,changed)).status,'conflict');
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM account_study_records').all(),before);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM study_events_v3').get().n,0);
  assert.deepEqual((await f.store.listAfter({userId:'user-b',libraryId:'library-a'},0,20)).summaries,[]);
  await assert.rejects(f.store.append({userId:'user-b',libraryId:'library-a'},f.record),/unknown/);
  await assert.rejects(f.store.append({...owner,libraryId:'other'},f.record),/scope/);
});
test('bounded append-only pages retain a fixed fence across new arrivals and interleaved owners',async t=>{
  const f=await setup(t);
  async function append(n){const {envelopeHash,...body}=v.records[0];void envelopeHash;
    const parent=await sealStudyRecord({...body,event:await attempt(`aux-event-${n}`,'2026-09-01T00:01:00Z',0,1),roundId:`aux-round-${n}`,attemptId:`aux-attempt-${n}`});
    await f.core.appendRecord(owner,parent);
    const {summaryHash,summaryId,...summaryBody}=summary;void summaryHash;void summaryId;
    await f.store.append(owner,await sealAccountAssistance(parent,await sealAssistanceSummary({...summaryBody,attemptEventId:parent.event.eventId,attemptCoreHash:parent.event.coreHash})));
  }
  for(let n=0;n<22;n++)await append(n);const first=await f.store.listAfter(owner,0,20);assert.equal(first.summaries.length,20);assert.ok(first.nextCursor);
  await append(22);const second=await f.store.listAfter(owner,first.nextCursor,20,first.through);assert.equal(second.summaries.length,2);assert.equal(second.nextCursor,null);
  await assert.rejects(f.store.listAfter(owner,0,21),/limit/);await assert.rejects(f.store.listAfter(owner,0,20,first.through+100),/fence/);
});
function receipt(record,overrides={}){return{schemaVersion:1,receiptId:'aux-received-one',summaryId:record.summary.summaryId,summaryHash:record.summary.summaryHash,associationHash:record.associationHash,status:'received',...overrides};}
test('independent receipts validate proof and writer, and cannot regress applied evidence',async t=>{
  const f=await setup(t);await f.store.append(owner,f.record);
  assert.equal((await f.store.appendReceipt(owner,receipt(f.record),'writer-a')).status,'accepted');
  const applied=receipt(f.record,{receiptId:'aux-applied-one',status:'applied',proof:{attemptCoreHash:summary.attemptCoreHash,proofHash:'a'.repeat(64),targetCount:2}});
  assert.equal((await f.store.appendReceipt(owner,applied,'writer-a')).status,'accepted');assert.equal((await f.store.appendReceipt(owner,applied,'writer-a')).status,'duplicate');
  assert.equal((await f.store.appendReceipt(owner,receipt(f.record,{receiptId:'late-received'}),'writer-a')).status,'conflict');
  await assert.rejects(f.store.appendReceipt(owner,{...applied,summaryHash:'b'.repeat(64)},'writer-a'),/binding/);
  const page=await f.store.listReceiptsAfter(owner,0,20);assert.equal(page.receipts.length,2);assert.equal(page.receipts[1].receipt.status,'applied');
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM account_study_writeback_receipts').get().n,0);
  await f.access.revoke(owner.userId,'writer-a');await assert.rejects(f.store.appendReceipt(owner,receipt(f.record,{receiptId:'revoked'}),'writer-a'),/writer/);
});
test('receipt insert rechecks a grant revoked after the initial authorization check',async t=>{
  const f=await setup(t);await f.store.append(owner,f.record);const original=f.binding.prepare.bind(f.binding);let revoked=false;
  f.binding.prepare=query=>{if(query.startsWith('INSERT INTO account_study_assistance_receipts')&&!revoked){revoked=true;f.sqlite.prepare("UPDATE account_study_grants SET state='revoked' WHERE grant_id='writer-a'").run();}return original(query);};
  await assert.rejects(f.store.appendReceipt(owner,receipt(f.record),'writer-a'),/writer/);assert.equal((await f.store.listReceiptsAfter(owner,0,20)).receipts.length,0);
});
test('additive upgrade and older code access preserve both old evidence and new summaries',async t=>{
  assert.equal(typeof api?.AccountAssistanceStore,'function');const {sqlite,binding}=await openD1(':memory:',false);t.after(()=>sqlite.close());await migrateD1(sqlite,0,15);
  sqlite.prepare('INSERT INTO learning_accounts(user_id) VALUES (?)').run(owner.userId);
  const old=new AccountStudyStore(binding);await old.putSnapshot(owner,v.bundle,0);await old.appendRecord(owner,v.records[0]);const before=sqlite.prepare('SELECT * FROM account_study_records').all();
  await migrateD1(sqlite,16);const store=new api.AccountAssistanceStore(binding);await store.append(owner,await sealAccountAssistance(v.records[0],summary));
  assert.deepEqual(sqlite.prepare('SELECT * FROM account_study_records').all(),before);assert.equal((await old.listRecordsAfter(owner,0,20)).records.length,1);
  assert.equal((await store.listAfter(owner,0,20)).summaries.length,1);
});
