import assert from 'node:assert/strict';
import test from 'node:test';
import {assistanceView,assistanceBundle} from './fixtures/assistance-read.mjs';
import {sealStudyRecord,checkStudyRecordBinding} from '../app/account-study-record.ts';
import {withStudyEventCoreHash} from '../app/study-event-v3.ts';
let api;try{api=await import('../app/recovery-causal-scope.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
test('a multi-store history over ten thousand replicas is deduplicated and checked within actual causal rounds',async()=>{
  const seed=(await assistanceView()).summaries[0].parent,{envelopeHash,...body}=seed;void envelopeHash;const records=[];
  for(let i=0;i<3334;i++){const event=await withStudyEventCoreHash({...seed.event,eventId:`history-${i}`});records.push(await sealStudyRecord({...body,event,roundId:`round-${i}`,attemptId:`attempt-${i}`}));}
  const replicas=[...records,...records,...records],item=assistanceBundle().items.find(item=>item.itemKey===seed.event.item.key);
  assert.throws(()=>checkStudyRecordBinding(records[0],item,replicas),/ancestry-too-large/);
  assert.equal(typeof api?.scopeRecoveryRecords,'function');const scoped=api.scopeRecoveryRecords(replicas);assert.equal(scoped.records.length,3334);
  for(const record of scoped.records){assert.equal(scoped.candidates(record).length,1);assert.equal(checkStudyRecordBinding(record,item,scoped.candidates(record)),'ready');}
});
test('same record identity with different content is rejected rather than silently deduplicated',async()=>{
  const record=(await assistanceView()).summaries[0].parent,{envelopeHash,...body}=record;void envelopeHash;assert.equal(typeof api?.scopeRecoveryRecords,'function');
  const changed=await sealStudyRecord({...body,attemptId:'changed'});assert.throws(()=>api.scopeRecoveryRecords([record,changed]),/conflict/);
});
test('same causal round with changed mode is retained together so binding checks can reject it',async()=>{
  const record=(await assistanceView()).summaries[0].parent,item=assistanceBundle().items.find(item=>item.itemKey===record.event.item.key);
  const event=await withStudyEventCoreHash({...record.event,eventId:'other-mode'}),{envelopeHash,...body}=record;void envelopeHash;
  const other=await sealStudyRecord({...body,event,attemptId:'other-attempt',practiceMode:'spelling'}),scoped=api.scopeRecoveryRecords([record,other]);
  assert.equal(scoped.candidates(record).length,2);assert.throws(()=>checkStudyRecordBinding(record,item,scoped.candidates(record)),/round|stage/);
});
