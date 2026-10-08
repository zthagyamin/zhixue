import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {sealAssistanceSummary} from '../app/assistance-summary.ts';
let api;try{api=await import('../app/assistance-record.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const ready=()=>assert.equal(typeof api?.sealAccountAssistance,'function');
const v=JSON.parse(await readFile(new URL('./fixtures/account-study-v1.json',import.meta.url))),summary=JSON.parse(await readFile(new URL('./fixtures/assistance-summary-v1.json',import.meta.url)));
test('an account auxiliary envelope binds the exact original envelope without duplicating its content',async()=>{
  ready();const record=await api.sealAccountAssistance(v.records[0],summary);
  assert.equal(record.attemptEnvelopeHash,v.records[0].envelopeHash);assert.equal(record.summary.summaryId,summary.summaryId);
  assert.deepEqual(await api.validateAccountAssistance(record,v.records[0]),record);
  await assert.rejects(api.validateAccountAssistance(record,v.records[1]),/binding/);
  await assert.rejects(api.parseAccountAssistance({...record,libraryId:'other'}),/integrity/);
  await assert.rejects(api.parseAccountAssistance({...record,event:v.records[0].event}),/field/);
});
test('a valid summary for an incorrect mode cannot attach to the original answer',async()=>{
  ready();const {summaryId,summaryHash,...body}=summary;void summaryId;void summaryHash;
  await assert.rejects(api.sealAccountAssistance(v.records[0],await sealAssistanceSummary({...body,practiceMode:'spelling'})),/mode/);
});
test('assistance receipts require their own applied proof and cannot accept original answer receipts',async()=>{
  ready();const record=await api.sealAccountAssistance(v.records[0],summary),receipt={schemaVersion:1,receiptId:'aux-receipt-one',summaryId:summary.summaryId,summaryHash:summary.summaryHash,associationHash:record.associationHash,status:'received'};
  assert.deepEqual(api.parseAssistanceReceipt(receipt),receipt);
  assert.throws(()=>api.parseAssistanceReceipt({...receipt,status:'applied'}),/proof/);
  assert.throws(()=>api.parseAssistanceReceipt({...receipt,eventId:'event-one'}),/field/);
  const applied={...receipt,status:'applied',proof:{attemptCoreHash:summary.attemptCoreHash,proofHash:'a'.repeat(64),targetCount:2}};
  assert.deepEqual(api.checkAssistanceReceipt(record,applied),applied);
  assert.throws(()=>api.checkAssistanceReceipt(record,{...applied,summaryHash:'b'.repeat(64)}),/binding/);
  assert.throws(()=>api.checkAssistanceReceipt(record,{...applied,proof:{...applied.proof,attemptCoreHash:'b'.repeat(64)}}),/binding/);
});
