import type {AssistanceSummaryV1} from './assistance-summary';
import type {StudyRecordEnvelope} from './account-record';
// @ts-expect-error TS5097: standalone Node tests.
import {parseAssistanceSummary,validateAssistanceParent} from './assistance-summary.ts';
// @ts-expect-error TS5097: standalone Node tests.
import {parseStudyRecord} from './account-record.ts';
// @ts-expect-error TS5097: standalone Node tests.
import {studyObject,studyId,studyDigest,studyCount,studySize,studyHash} from './validation.ts';

export type AccountAssistanceV1={schemaVersion:1;libraryId:string;attemptEnvelopeHash:string;summary:AssistanceSummaryV1;associationHash:string};
export type AssistanceReceiptV1={schemaVersion:1;receiptId:string;summaryId:string;summaryHash:string;associationHash:string;
  status:'received'|'blocked'|'applied';reason?:'source-changed'|'source-missing'|'mapping-missing'|'dependency-pending'|'write-conflict'|'storage-unavailable'|'writeback-failed'|'baseline-unverified';
  proof?:{attemptCoreHash:string;proofHash:string;targetCount:number}};
export async function sealAccountAssistance(rawParent:unknown,rawSummary:unknown):Promise<AccountAssistanceV1>{
  const frozenSummary=structuredClone(rawSummary),parent=await parseStudyRecord(rawParent);
  if(parent.provenanceMode==='task')throw new Error('assistance-requires-practice');
  const summary=await validateAssistanceParent(frozenSummary,parent.event,parent.practiceMode);
  const body={schemaVersion:1 as const,libraryId:parent.libraryId,attemptEnvelopeHash:parent.envelopeHash,summary};
  return{...body,associationHash:await studyHash(body)};
}
export async function parseAccountAssistance(raw:unknown):Promise<AccountAssistanceV1>{
  studySize(raw,8192);const value=structuredClone(studyObject(raw,['schemaVersion','libraryId','attemptEnvelopeHash','summary','associationHash']));
  if(value.schemaVersion!==1)throw new Error('unsupported-assistance-version');
  studyId(value.libraryId,'library');studyDigest(value.attemptEnvelopeHash);studyDigest(value.associationHash);
  const summary=await parseAssistanceSummary(value.summary),body={schemaVersion:1 as const,libraryId:value.libraryId,attemptEnvelopeHash:value.attemptEnvelopeHash,summary};
  if(value.associationHash!==await studyHash(body))throw new Error('assistance-association-integrity');
  return{...body,associationHash:value.associationHash};
}
export async function validateAccountAssistance(raw:unknown,rawParent:unknown):Promise<AccountAssistanceV1>{
  const frozenParent=structuredClone(rawParent),record=await parseAccountAssistance(raw),parent:StudyRecordEnvelope=await parseStudyRecord(frozenParent);
  if(parent.provenanceMode==='task'||parent.libraryId!==record.libraryId||parent.envelopeHash!==record.attemptEnvelopeHash)throw new Error('assistance-account-binding');
  await validateAssistanceParent(record.summary,parent.event,parent.practiceMode);return record;
}
export function parseAssistanceReceipt(raw:unknown):AssistanceReceiptV1{
  studySize(raw,4096);const value=studyObject(raw,['schemaVersion','receiptId','summaryId','summaryHash','associationHash','status'],['reason','proof']);
  if(value.schemaVersion!==1)throw new Error('unsupported-assistance-receipt-version');
  studyId(value.receiptId,'receipt');studyId(value.summaryId,'summary');studyDigest(value.summaryHash);studyDigest(value.associationHash);
  if(!['received','blocked','applied'].some(status=>status===value.status))throw new Error('invalid-assistance-receipt-status');
  if(value.status==='applied'){
    if(!value.proof)throw new Error('missing-assistance-proof');
    const proof=studyObject(value.proof,['attemptCoreHash','proofHash','targetCount']);studyDigest(proof.attemptCoreHash);studyDigest(proof.proofHash);
    studyCount(proof.targetCount,'assistance-target-count',2);if(proof.targetCount!==2)throw new Error('invalid-assistance-target-count');
  }else if(Object.hasOwn(value,'proof'))throw new Error('invalid-assistance-proof');
  if(value.status==='blocked'){
    if(!['source-changed','source-missing','mapping-missing','dependency-pending','write-conflict','storage-unavailable','writeback-failed','baseline-unverified'].some(reason=>reason===value.reason))throw new Error('invalid-assistance-reason');
  }else if(Object.hasOwn(value,'reason'))throw new Error('invalid-assistance-reason');
  return structuredClone(value) as AssistanceReceiptV1;
}
/** Parent must be parsed/verified first. Core and auxiliary receipts are separate. */
export function checkAssistanceReceipt(record:Pick<AccountAssistanceV1,'summary'|'associationHash'>,raw:unknown):AssistanceReceiptV1{
  const receipt=parseAssistanceReceipt(raw),summary=record.summary;
  if(receipt.summaryId!==summary.summaryId||receipt.summaryHash!==summary.summaryHash||receipt.associationHash!==record.associationHash
    ||receipt.proof&&receipt.proof.attemptCoreHash!==summary.attemptCoreHash)throw new Error('assistance-receipt-binding');
  return receipt;
}
