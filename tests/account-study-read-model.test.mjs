import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {sealStudySnapshot} from '../app/account-study-content.ts';
let api;try{api=await import('../app/account-study-read-model.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const V=JSON.parse(readFileSync(new URL('./fixtures/account-study-v1.json',import.meta.url))),PV=JSON.parse(readFileSync(new URL('./fixtures/account-planning-v1.json',import.meta.url)));
export const model=()=>structuredClone({loaded:{bundle:V.bundle,bundles:[V.bundle],catalog:PV.catalog,catalogs:[PV.catalog],facts:PV.facts,records:V.records.map((record,i)=>({sequence:i+1,record})),writebacks:[],eventThrough:3,taskThrough:3},operations:[],operationThrough:0,receiptThrough:0,executions:[],executionThrough:0});
const validate=(raw)=>{assert.equal(typeof api?.validateAccountReadModel,'function');return api.validateAccountReadModel(raw,'library-a');};
test('a complete read model verifies source closure and returns an isolated value',async()=>{
  const raw=model(),value=await validate(raw);assert.equal(value.loaded.records.length,3);value.loaded.bundle.items[0].title='mutated';assert.notEqual(raw.loaded.bundle.items[0].title,'mutated');
});
test('a checkpoint cannot label partial, unordered or duplicate history as complete',async()=>{
  for(const edit of [v=>v.loaded.records.pop(),v=>v.loaded.records.reverse(),v=>v.loaded.taskThrough=2,v=>v.loaded.records[1].record=v.loaded.records[0].record]){const value=model();edit(value);await assert.rejects(validate(value));}
});
test('a checkpoint rejects foreign source facts, missing snapshot closure and receipt-parent mismatches',async()=>{
  for(const edit of [v=>v.loaded.bundles=[],v=>v.loaded.facts.libraryId='other',v=>v.loaded.catalogs=[]]){const value=model();edit(value);await assert.rejects(validate(value));}
  const value=model(),record=value.loaded.records[0].record;
  value.loaded.writebacks=[{sequence:1,receipt:{schemaVersion:1,receiptId:'receipt-one',eventId:record.event.eventId,envelopeHash:'f'.repeat(64),status:'received'},delivery:{schemaVersion:1,libraryId:'library-a',eventId:record.event.eventId,envelopeHash:'f'.repeat(64),target:'companion',status:'received',revision:1},receivedAt:'2026-09-01T01:00:00Z',writerGrantId:'writer-one'}];value.receiptThrough=1;
  await assert.rejects(validate(value),/receipt.*binding/);
});
test('a valid separate writeback receipt is bound to the original event and envelope',async()=>{
  const value=model(),record=value.loaded.records[0].record;
  value.loaded.writebacks=[{sequence:2,receipt:{schemaVersion:1,receiptId:'receipt-one',eventId:record.event.eventId,envelopeHash:record.envelopeHash,status:'applied',proof:{coreHash:record.event.coreHash,proofHash:'a'.repeat(64),targetCount:1}},delivery:{schemaVersion:1,libraryId:'library-a',eventId:record.event.eventId,envelopeHash:record.envelopeHash,target:'companion',status:'applied',revision:2},receivedAt:'2026-09-01T01:00:00Z',writerGrantId:'writer-one'}];value.receiptThrough=2;
  assert.equal((await validate(value)).loaded.writebacks[0].receipt.status,'applied');
  value.loaded.writebacks[0].receipt.proof.coreHash='b'.repeat(64);await assert.rejects(validate(value),/receipt.*binding/);
});
test('immutable snapshot reuse rejects same-id changes and revision rollback',async()=>{
  assert.equal(typeof api?.checkAccountReadAdvance,'function');const previous=await validate(model()),same=await validate(model());api.checkAccountReadAdvance(previous,same);
  const value=model(),body={...value.loaded.bundle.snapshot};delete body.snapshotHash;value.loaded.bundle={...value.loaded.bundle,snapshot:await sealStudySnapshot({...body,sourceHash:'b'.repeat(64)})};
  assert.throws(()=>api.checkAccountReadAdvance(previous,value),/snapshot.*conflict/);
  const lowered=structuredClone(previous);lowered.loaded.bundle.snapshot.revision=0;assert.throws(()=>api.checkAccountReadAdvance(previous,lowered));
});
test('a new checkpoint cannot remove previously complete history below the same fence',async()=>{
  const previous=await validate(model()),next=structuredClone(previous);next.loaded.records.splice(1,1);
  assert.throws(()=>api.checkAccountReadAdvance(previous,next),/history.*changed/);
});
test('plan execution receipts require an approved operation with the same plan hash',async()=>{
  const value=model();value.executions=[{sequence:1,receipt:{schemaVersion:1,receiptId:'plan-receipt',operationId:'missing-op',cloudPlanHash:'b'.repeat(64),status:'blocked',reason:'source-changed'},writerGrantId:'writer',receivedAt:'2026-09-01T01:00:00Z'}];value.executionThrough=1;
  await assert.rejects(validate(value),/execution.*binding/);
});
