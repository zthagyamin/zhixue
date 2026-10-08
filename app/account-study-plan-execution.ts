// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {studyCount,studyDigest,studyId,studyObject,studySize} from './account-study-content.ts';
export type PlanExecutionReceipt={schemaVersion:1;receiptId:string;operationId:string;cloudPlanHash:string;status:'blocked'|'applied';reason?:string;
  proof?:{cloudPlanHash:string;nativePlanHash:string;localRevision:number;proofHash:string;targetCount:number}};
export function parsePlanExecutionReceipt(raw:unknown):PlanExecutionReceipt{
  const value=studyObject(raw,['schemaVersion','receiptId','operationId','cloudPlanHash','status'],['reason','proof']);if(value.schemaVersion!==1)throw new Error('unsupported-plan-execution-version');
  studyId(value.receiptId,'receipt');studyId(value.operationId,'operation');studyDigest(value.cloudPlanHash);
  if(value.status!=='blocked'&&value.status!=='applied')throw new Error('invalid-plan-execution-status');
  if(value.status==='applied'){
    const proof=studyObject(value.proof,['cloudPlanHash','nativePlanHash','localRevision','proofHash','targetCount']);studyDigest(proof.cloudPlanHash);studyDigest(proof.nativePlanHash);studyCount(proof.localRevision,'local-revision',1);studyDigest(proof.proofHash);
    studyCount(proof.targetCount,'target-count',1);if(proof.cloudPlanHash!==value.cloudPlanHash||proof.targetCount!==1)throw new Error('invalid-plan-execution-proof');
  }else{
    if(value.proof!==undefined)throw new Error('invalid-plan-execution-proof');
    if(!['source-changed','material-missing','predecessor-pending','local-plan-conflict','storage-unavailable','plan-write-failed'].includes(String(value.reason)))throw new Error('invalid-plan-execution-reason');
  }
  if(value.status!=='blocked'&&value.reason!==undefined)throw new Error('invalid-plan-execution-reason');studySize(value,4096);return structuredClone(value) as PlanExecutionReceipt;
}
