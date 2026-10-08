import type {AccountStudyLoaded} from './account-study-client';
import type {CloudPlanningCatalogV1} from './account-study-planning';
import type {StoredPlanOperation,StoredPlanExecution} from '../db/account-study-plan-store';
import type {StoredWritebackReceipt} from '../db/account-study-receipt-store';
import type {ContentDecisionOperation} from '../db/account-study-content-decision-store';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {studyObject,studyCount,studyId,studyDigest,studyHash,validateStudyBundle} from './account-study-content.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {parseCloudPlanningCatalog,parseCloudPlanningFacts,parseCloudTaskPlan} from './account-study-planning.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {parseStudyRecord,checkStudyRecordBinding} from './account-study-record.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {parseWritebackReceipt} from './account-study-receipt.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {validPlanDay} from './task-plan-types.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {canonicalizeJson} from './study-event-v3.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {parsePlanExecutionReceipt} from './account-study-plan-execution.ts';

export type AccountReadModel={loaded:AccountStudyLoaded;operations:StoredPlanOperation[];operationThrough:number;receiptThrough:number;executions:StoredPlanExecution[];executionThrough:number};
function array(value:unknown):unknown[]{if(!Array.isArray(value))throw new Error('account-read-array-invalid');return value;}
function time(value:unknown):void{if(typeof value!=='string'||value.length>40||!Number.isFinite(Date.parse(value)))throw new Error('account-read-time-invalid');}
export function parseReadContentDecision(raw:unknown):ContentDecisionOperation{
  const row=studyObject(raw,['sequence','operationId','factsHash','candidateId','contentHash','decision','status','receivedAt']);studyCount(row.sequence,'decision-sequence',1);
  studyId(row.operationId,'operation');studyId(row.candidateId,'candidate');studyDigest(row.factsHash);studyDigest(row.contentHash);time(row.receivedAt);
  if(!['approved','rejected','later'].includes(String(row.decision))||!['pending','applied','blocked'].includes(String(row.status)))throw new Error('account-content-decision-invalid');
  return structuredClone(row) as ContentDecisionOperation;
}
export function validateReadSequences(rows:{sequence:number}[],through:number):void{
  studyCount(through,'read-fence');let previous=0;
  for(const row of rows){studyCount(row.sequence,'read-sequence',1);if(row.sequence<=previous||row.sequence>through)throw new Error('account-read-sequence');previous=row.sequence;}
  if(previous!==through)throw new Error('account-read-incomplete');
}
export async function parseReadOperation(raw:unknown,catalogs:CloudPlanningCatalogV1[]):Promise<StoredPlanOperation>{
  const value=studyObject(raw,['sequence','operationId','day','action','plan','predecessorOperationId','stateRevision','receivedAt']);
  studyCount(value.sequence,'operation-sequence',1);studyId(value.operationId,'operation');studyCount(value.stateRevision,'state-revision',1);time(value.receivedAt);
  if(!validPlanDay(value.day)||!['save','approve','reject','cancel','restore'].includes(String(value.action)))throw new Error('account-operation-invalid');
  if(value.predecessorOperationId!==null)studyId(value.predecessorOperationId,'predecessor');
  let plan=null;
  if(value.plan!==null){const catalog=catalogs.find(item=>item.catalogHash===(value.plan as {catalogHash?:unknown})?.catalogHash);if(!catalog)throw new Error('account-operation-catalog-missing');plan=await parseCloudTaskPlan(value.plan,catalog);if(plan.day!==value.day)throw new Error('account-operation-plan-binding');}
  if(['save','approve','restore'].includes(String(value.action))&&!plan)throw new Error('account-operation-plan-missing');
  return {...value,plan} as StoredPlanOperation;
}
export function parseReadWriteback(raw:unknown,libraryId:string,records:AccountStudyLoaded['records']):StoredWritebackReceipt{
  const value=studyObject(raw,['sequence','receipt','delivery','receivedAt','writerGrantId']);studyCount(value.sequence,'receipt-sequence',1);time(value.receivedAt);studyId(value.writerGrantId,'writer');
  const receipt=parseWritebackReceipt(value.receipt),delivery=studyObject(value.delivery,['schemaVersion','libraryId','eventId','envelopeHash','target','status','revision'],['reason']);
  const parent=records.find(row=>row.record.event.eventId===receipt.eventId)?.record;
  if(!parent||parent.libraryId!==libraryId||parent.envelopeHash!==receipt.envelopeHash||receipt.proof&&receipt.proof.coreHash!==parent.event.coreHash
    ||delivery.schemaVersion!==1||delivery.libraryId!==libraryId||delivery.eventId!==receipt.eventId||delivery.envelopeHash!==receipt.envelopeHash
    ||delivery.target!=='companion'||delivery.status!==receipt.status||delivery.revision!==value.sequence||delivery.reason!==receipt.reason)throw new Error('account-receipt-binding');
  return structuredClone({...value,receipt,delivery}) as StoredWritebackReceipt;
}

/** Complete transport history, not a claim that every raw attempt proves mastery.
 * Existing planning/FSRS projections still check ancestry and conflicting rounds. */
export async function validateAccountReadModel(raw:unknown,libraryId:string):Promise<AccountReadModel>{
  studyId(libraryId,'library');const value=studyObject(raw,['loaded','operations','operationThrough','receiptThrough','executions','executionThrough']);
  const loaded=studyObject(value.loaded,['bundle','bundles','catalog','catalogs','facts','records','writebacks','eventThrough','taskThrough']);
  const bundle=await validateStudyBundle(loaded.bundle),bundles=await Promise.all(array(loaded.bundles).map(validateStudyBundle));
  const snapshots=new Map(bundles.map(item=>[item.snapshot.snapshotId,item]));
  if(snapshots.size!==bundles.length||bundles.some(item=>item.snapshot.libraryId!==libraryId)||bundle.snapshot.libraryId!==libraryId
    ||snapshots.get(bundle.snapshot.snapshotId)?.snapshot.snapshotHash!==bundle.snapshot.snapshotHash)throw new Error('account-read-snapshot-binding');
  const catalogs=await Promise.all(array(loaded.catalogs).map(parseCloudPlanningCatalog)),catalog=await parseCloudPlanningCatalog(loaded.catalog),facts=await parseCloudPlanningFacts(loaded.facts);
  if(new Set(catalogs.map(item=>item.catalogHash)).size!==catalogs.length||new Set(catalogs.map(item=>item.snapshotId)).size!==catalogs.length)throw new Error('account-read-catalog-duplicate');
  // Catalog sourceHash covers the planning source, not the question manifest.
  for(const source of catalogs){const target=snapshots.get(source.snapshotId);if(source.libraryId!==libraryId||!target)throw new Error('account-read-catalog-binding');
    const members=new Map(target.items.map(item=>[item.itemKey,item.contentHash]));for(const [key,hash]of Object.entries(source.contentRefs))if(members.get(key)!==hash)throw new Error('account-read-catalog-membership');}
  if(!catalogs.some(item=>item.catalogHash===catalog.catalogHash)||catalog.snapshotId!==bundle.snapshot.snapshotId||facts.libraryId!==libraryId||facts.snapshotId!==catalog.snapshotId||facts.catalogHash!==catalog.catalogHash)throw new Error('account-read-facts-binding');
  const records:AccountStudyLoaded['records']=[],ids=new Set<string>();
  for(const rawRow of array(loaded.records)){const row=studyObject(rawRow,['sequence','record']);studyCount(row.sequence,'record-sequence',1);const record=await parseStudyRecord(row.record);
    if(record.libraryId!==libraryId||!snapshots.has(record.snapshotId)||ids.has(record.event.eventId))throw new Error('account-read-record-binding');ids.add(record.event.eventId);
    if(record.provenanceMode!=='task'){const item=snapshots.get(record.snapshotId)!.items.find(item=>item.itemKey===record.event.item.key&&item.contentHash===record.contentHash);if(!item)throw new Error('account-read-record-membership');checkStudyRecordBinding(record,item);}
    records.push({sequence:row.sequence,record});}
  studyCount(loaded.eventThrough,'event-fence');if(loaded.taskThrough!==loaded.eventThrough)throw new Error('account-read-task-fence');validateReadSequences(records,loaded.eventThrough);
  const operations=await Promise.all(array(value.operations).map(row=>parseReadOperation(row,catalogs)));
  studyCount(value.operationThrough,'operation-fence');validateReadSequences(operations,value.operationThrough);
  const operationIds=new Set<string>();for(const operation of operations){if(operationIds.has(operation.operationId)||operation.predecessorOperationId&&!operationIds.has(operation.predecessorOperationId))throw new Error('account-read-operation-binding');operationIds.add(operation.operationId);
    if(operation.plan&&(operation.plan.eventThrough>loaded.eventThrough||operation.plan.taskThrough>loaded.eventThrough))throw new Error('account-read-operation-record-fence');}
  for(const {record}of records)if(record.provenanceMode==='task'){
    const event=record.event,operation=[...operations].reverse().find(op=>['approve','restore'].includes(op.action)&&op.plan?.cloudPlanHash===record.planHash&&op.day===event.day&&Date.parse(op.receivedAt)<=Date.parse(event.occurredAt)
      &&!operations.some(cancel=>cancel.action==='cancel'&&cancel.predecessorOperationId===op.operationId&&Date.parse(cancel.receivedAt)<Date.parse(event.occurredAt))),plan=operation?.plan,task=plan?.tasks.find(task=>task.taskId===event.taskId);
    if(!plan||!task||record.assignmentId!==task.taskId||event.subjectId!==task.subjectId||JSON.stringify(event.unitIds)!==JSON.stringify(task.unitIds)||event.source!=='self-report'||task.completionRule!=='self-report'||event.evidenceRefs.length
      ||record.completionKey!==`completion:${await studyHash([plan.cloudPlanHash,task.taskId,task.unitIds,event.day])}`)throw new Error('account-read-task-binding');
  }
  const writebacks=array(loaded.writebacks).map(row=>parseReadWriteback(row,libraryId,records));studyCount(value.receiptThrough,'receipt-fence');validateReadSequences(writebacks,value.receiptThrough);
  if(new Set(writebacks.map(row=>row.receipt.receiptId)).size!==writebacks.length)throw new Error('account-read-receipt-duplicate');
  const executions=array(value.executions).map(raw=>{
    const row=studyObject(raw,['sequence','receipt','writerGrantId','receivedAt']);studyCount(row.sequence,'execution-sequence',1);studyId(row.writerGrantId,'writer');time(row.receivedAt);
    const receipt=parsePlanExecutionReceipt(row.receipt),operation=operations.find(item=>item.operationId===receipt.operationId);
    if(!operation||!['approve','restore'].includes(operation.action)||operation.plan?.cloudPlanHash!==receipt.cloudPlanHash)throw new Error('account-execution-binding');
    return {...row,receipt} as StoredPlanExecution;
  });studyCount(value.executionThrough,'execution-fence');validateReadSequences(executions,value.executionThrough);
  if(new Set(executions.map(row=>row.receipt.receiptId)).size!==executions.length)throw new Error('account-execution-duplicate');
  return {loaded:{bundle,bundles,catalog,catalogs,facts,records,writebacks,eventThrough:loaded.eventThrough,taskThrough:loaded.eventThrough},operations,operationThrough:value.operationThrough,receiptThrough:value.receiptThrough,executions,executionThrough:value.executionThrough};
}
export function checkAccountReadAdvance(previous:AccountReadModel,next:AccountReadModel):void{
  const before=previous.loaded,after=next.loaded;
  if(before.bundle.snapshot.libraryId!==after.bundle.snapshot.libraryId)throw new Error('account-read-library-changed');
  for(const old of before.bundles){const current=after.bundles.find(item=>item.snapshot.snapshotId===old.snapshot.snapshotId);if(!current||current.snapshot.snapshotHash!==old.snapshot.snapshotHash)throw new Error('account-snapshot-conflict');}
  const head=after.bundle.snapshot,oldHead=before.bundle.snapshot;
  if(head.snapshotId===oldHead.snapshotId&&head.snapshotHash!==oldHead.snapshotHash)throw new Error('account-snapshot-conflict');
  if(head.revision<oldHead.revision||head.revision===oldHead.revision&&head.snapshotId!==oldHead.snapshotId)throw new Error('account-snapshot-revision');
  if(after.eventThrough<before.eventThrough||next.operationThrough<previous.operationThrough||next.receiptThrough<previous.receiptThrough||next.executionThrough<previous.executionThrough)throw new Error('account-read-fence-rollback');
  const unchanged=(old:{sequence:number}[],fresh:{sequence:number}[],through:number)=>canonicalizeJson(old)===canonicalizeJson(fresh.filter(row=>row.sequence<=through));
  if(!unchanged(before.records,after.records,before.eventThrough)||!unchanged(previous.operations,next.operations,previous.operationThrough)
    ||!unchanged(before.writebacks as StoredWritebackReceipt[],after.writebacks as StoredWritebackReceipt[],previous.receiptThrough)||!unchanged(previous.executions,next.executions,previous.executionThrough))throw new Error('account-history-changed');
  for(const old of before.catalogs)if(!after.catalogs.some(item=>item.snapshotId===old.snapshotId&&item.catalogHash===old.catalogHash))throw new Error('account-catalog-conflict');
}
