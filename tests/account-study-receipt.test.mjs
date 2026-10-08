import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {openD1} from './helpers/sqlite-d1.mjs';
import {AccountStudyAccessStore} from '../db/account-study-access-store.ts';
import {AccountStudyStore} from '../db/account-study-store.ts';
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';
import {sealStudyRecord} from '../app/account-study-record.ts';
import {wordBody,snapshotBody,recordBody} from './fixtures/account-study-fixtures.mjs';
let api;
try {api=await import('../db/account-study-receipt-store.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;}
const scope={userId:'user-a',libraryId:'library-a'},writer='grant-one';
async function setup(t){assert.equal(typeof api?.AccountStudyReceiptStore,'function','Verified writeback receipt storage must exist');
  const db=await openD1();t.after(()=>db.sqlite.close());const clock=()=>new Date('2026-09-01T00:00:00.000Z'),access=new AccountStudyAccessStore(db.binding,clock),study=new AccountStudyStore(db.binding);
  const secret=Buffer.alloc(32,9).toString('base64url');await access.register('user-a',{grantId:writer,libraryId:'library-a',tokenHash:createHash('sha256').update(secret).digest('hex'),label:'Desktop',expectedProfileRevision:0,replaceLibrary:false});await access.activate(secret);
  const items=[await sealStudyItem(wordBody())],snapshot=await sealStudySnapshot(snapshotBody(items));await study.putSnapshot(scope,{items,snapshot},0);
  const record=await sealStudyRecord(await recordBody({contentHash:items[0].contentHash}));await study.appendRecord(scope,record);
  const receipt=(id,status='received')=>({schemaVersion:1,receiptId:id,eventId:record.event.eventId,envelopeHash:record.envelopeHash,status,
    ...(status==='blocked'?{reason:'source-changed'}:{}),...(status==='applied'?{proof:{coreHash:record.event.coreHash,proofHash:'c'.repeat(64),targetCount:2}}:{})});
  return {...db,access,record,receipt,receipts:new api.AccountStudyReceiptStore(db.binding,clock)};
}
test('received and applied receipts are distinct and bound to the actual stored core',async t=>{
  const {receipts,receipt}=await setup(t);const a=await receipts.append(scope,receipt('receipt-one'),writer);
  const b=await receipts.append(scope,receipt('receipt-two','applied'),writer);
  assert.equal(a.status,'accepted');assert.equal(a.receipt.delivery.status,'received');assert.equal(b.receipt.delivery.status,'applied');
  assert.equal(b.receipt.delivery.target,'companion');assert.ok(b.receipt.sequence>a.receipt.sequence);
});
test('receipt retry preserves its original sequence and changed meaning conflicts',async t=>{
  const {receipts,receipt,sqlite}=await setup(t);const input=receipt('receipt-one');const a=await receipts.append(scope,input,writer),b=await receipts.append(scope,input,writer);
  assert.equal(b.status,'duplicate');assert.equal(a.receipt.sequence,b.receipt.sequence);
  assert.equal((await receipts.append(scope,receipt('receipt-one','blocked'),writer)).status,'conflict');
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM account_study_writeback_receipts').get().n,1);
});
test('applied requires a nonempty matching proof and malformed statuses are rejected',async t=>{
  const {receipts,receipt}=await setup(t);const noProof=receipt('receipt-one','applied');delete noProof.proof;
  await assert.rejects(receipts.append(scope,noProof,writer),/proof/);
  const wrong=receipt('receipt-two','applied');wrong.proof.coreHash='b'.repeat(64);await assert.rejects(receipts.append(scope,wrong,writer),/binding/);
  wrong.proof.targetCount=0;await assert.rejects(receipts.append(scope,wrong,writer),/proof/);
  await assert.rejects(receipts.append(scope,{...receipt('receipt-three'),status:['applied']},writer),/status/);
});
test('missing or mismatched events and inactive writers never certify a writeback',async t=>{
  const {receipts,receipt,access}=await setup(t);
  await assert.rejects(receipts.append(scope,{...receipt('receipt-one'),eventId:'missing-event'},writer),/record/);
  await assert.rejects(receipts.append(scope,{...receipt('receipt-one'),envelopeHash:'b'.repeat(64)},writer),/binding/);
  await assert.rejects(receipts.append({userId:'user-b',libraryId:'library-a'},receipt('receipt-one'),writer),/writer|grant|record/);
  await access.revoke('user-a',writer);await assert.rejects(receipts.append(scope,receipt('receipt-one'),writer),/writer|grant/);
});
test('applied receipt cannot regress and the prior successful receipt is returned',async t=>{
  const {receipts,receipt}=await setup(t);const done=await receipts.append(scope,receipt('receipt-one','applied'),writer);
  const stale=await receipts.append(scope,receipt('receipt-two','received'),writer);assert.equal(stale.status,'conflict');
  assert.equal(stale.current.sequence,done.receipt.sequence);
  assert.equal((await receipts.listAfter(scope,0,20)).receipts.length,1);
});
test('receipt pages are account-scoped and reject fabricated read fences',async t=>{
  const {receipts,receipt}=await setup(t);await receipts.append(scope,receipt('receipt-one'),writer);await receipts.append(scope,receipt('receipt-two','applied'),writer);
  const first=await receipts.listAfter(scope,0,1);assert.equal(first.receipts.length,1);assert.equal(first.nextCursor,first.receipts[0].sequence);
  const last=await receipts.listAfter(scope,first.nextCursor,1,first.through);assert.equal(last.nextCursor,null);assert.equal(last.receipts[0].delivery.status,'applied');
  assert.deepEqual((await receipts.listAfter({userId:'user-b',libraryId:'library-a'},0,20)).receipts,[]);
  await assert.rejects(receipts.listAfter(scope,999999,20,999999),/fence/);
});
test('damaged stored status does not allow an applied proof to be overwritten',async t=>{
  const {receipts,receipt,sqlite}=await setup(t);await receipts.append(scope,receipt('receipt-one','applied'),writer);
  sqlite.exec("UPDATE account_study_writeback_receipts SET status='received'");
  await assert.rejects(receipts.append(scope,receipt('receipt-two'),writer),/integrity/);
});
test('concurrent received and applied writes end in applied without a later regression',async t=>{
  const {receipts,receipt}=await setup(t);await Promise.all([receipts.append(scope,receipt('receipt-one'),writer),receipts.append(scope,receipt('receipt-two','applied'),writer)]);
  const rows=(await receipts.listAfter(scope,0,20)).receipts;assert.equal(rows.at(-1).delivery.status,'applied');
});
