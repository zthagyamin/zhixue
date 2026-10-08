// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {studyObject,studyId,studyDigest,studyCount,studySize} from './validation.ts';

export type MachineWritebackReceipt={schemaVersion:1;receiptId:string;eventId:string;envelopeHash:string;
  status:'received'|'blocked'|'applied';reason?:string;proof?:{coreHash:string;proofHash:string;targetCount:number}};
export function parseWritebackReceipt(raw:unknown):MachineWritebackReceipt {
  const value=studyObject(raw,['schemaVersion','receiptId','eventId','envelopeHash','status'],['reason','proof']);
  if(value.schemaVersion!==1) throw new Error('unsupported-writeback-receipt-version');
  studyId(value.receiptId,'receipt');studyId(value.eventId,'event');studyDigest(value.envelopeHash);
  if(value.status!=='received'&&value.status!=='blocked'&&value.status!=='applied') throw new Error('invalid-writeback-status');
  if(value.status==='applied') {
    if(!value.proof) throw new Error('missing-writeback-proof');
    const proof=studyObject(value.proof,['coreHash','proofHash','targetCount']);studyDigest(proof.coreHash);studyDigest(proof.proofHash);
    studyCount(proof.targetCount,'writeback-proof-targets',1);if(proof.targetCount>16) throw new Error('invalid-writeback-proof-targets');
  }else if(Object.hasOwn(value,'proof')) throw new Error('invalid-writeback-proof');
  if(value.status==='blocked') {
    if(typeof value.reason!=='string'||!['source-changed','source-missing','mapping-missing','dependency-pending','write-conflict',
      'storage-unavailable','writeback-failed','baseline-unverified'].includes(value.reason)) throw new Error('invalid-writeback-reason');
  }else if(Object.hasOwn(value,'reason')) throw new Error('invalid-writeback-reason');
  studySize(value,4096);return structuredClone(value) as MachineWritebackReceipt;
}
