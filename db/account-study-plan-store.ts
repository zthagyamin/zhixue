import type {CloudPlanningCatalogV1,CloudPlanningFactsV1,CloudTaskPlanV1} from '../app/account-study-planning';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {parseCloudPlanningCatalog,parseCloudPlanningFacts,parseCloudTaskPlan} from '../app/account-study-planning.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {canonicalizeJson} from '../app/study-event-v3.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {studyCount,studyDigest,studyHash,studyId,studyObject} from '../app/account-study-content.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {validPlanDay} from '../app/task-plan-types.ts';
import type {StudyRecordEnvelope} from '../app/account-study-record';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {parsePlanExecutionReceipt,type PlanExecutionReceipt} from '../app/account-study-plan-execution.ts';

type D1=Pick<D1Database,'prepare'|'batch'>;
type Scope={userId:string;libraryId:string};
type StateRow={user_id:string;library_id:string;day:string;revision:number;plan_hash:string|null;plan_json:string|null;
  approved_plan_hash:string|null;approved_plan_json:string|null;approved_revision:number|null;approved_operation_id:string|null;decision:string;last_operation_id:string|null};
type OperationRow={sequence:number;user_id:string;library_id:string;day:string;operation_id:string;action:string;request_hash:string;
  plan_hash:string|null;plan_json:string|null;predecessor_operation_id:string|null;state_revision:number;received_at:string};
export type SharedPlanState={day:string;revision:number;currentPlan:CloudTaskPlanV1|null;approvedPlan:CloudTaskPlanV1|null;
  approvedRevision:number|null;approvedOperationId:string|null;decision:'none'|'draft'|'approved'|'rejected'|'cancelled'|'restored';lastOperationId:string|null};
type MutationResult={status:'accepted'|'duplicate'|'stale';state:SharedPlanState;operationRevision?:number};
export type StoredPlanOperation={sequence:number;operationId:string;day:string;action:string;plan:CloudTaskPlanV1|null;predecessorOperationId:string|null;stateRevision:number;receivedAt:string};
export type StoredPlanExecution={sequence:number;receipt:PlanExecutionReceipt;writerGrantId:string;receivedAt:string};
type ExecutionRow={sequence:number;user_id:string;library_id:string;receipt_id:string;operation_id:string;cloud_plan_hash:string;status:string;payload_hash:string;payload_json:string;writer_grant_id:string;received_at:string};

function scopeArgs(scope:Scope):[string,string]{studyId(scope.userId,'user');studyId(scope.libraryId,'library');return [scope.userId,scope.libraryId];}

export class AccountStudyPlanStore {
  private database:D1;
  constructor(database:D1){this.database=database;}
  private q(sql:string,...bindings:unknown[]){return this.database.prepare(sql).bind(...bindings);}
  async putCatalog(scope:Scope,raw:unknown):Promise<'accepted'|'duplicate'> {
    const args=scopeArgs(scope),catalog=await parseCloudPlanningCatalog(raw);
    if(catalog.libraryId!==scope.libraryId) throw new Error('study-scope-mismatch');
    const published=await this.q('SELECT published FROM account_study_snapshots WHERE user_id=? AND library_id=? AND snapshot_id=?',...args,catalog.snapshotId).first<number>('published');
    if(published!==1) throw new Error('unknown-study-snapshot');
    const existing=await this.q('SELECT catalog_hash,catalog_json FROM account_study_planning_catalogs WHERE user_id=? AND library_id=? AND (snapshot_id=? OR catalog_hash=?)',...args,catalog.snapshotId,catalog.catalogHash).first<{catalog_hash:string;catalog_json:string}>();
    if(existing){const same=existing.catalog_hash===catalog.catalogHash&&canonicalizeJson(await parseCloudPlanningCatalog(JSON.parse(existing.catalog_json)))===canonicalizeJson(catalog);if(!same)throw new Error('study-planning-catalog-conflict');return 'duplicate';}
    await this.q('INSERT INTO account_study_planning_catalogs(user_id,library_id,snapshot_id,source_hash,catalog_hash,catalog_json) VALUES(?,?,?,?,?,?)',...args,catalog.snapshotId,catalog.sourceHash,catalog.catalogHash,canonicalizeJson(catalog)).run();
    const saved=await this.getCatalog(scope,catalog.snapshotId);if(!saved||saved.catalogHash!==catalog.catalogHash)throw new Error('study-planning-catalog-storage-failed');return 'accepted';
  }
  async getCatalog(scope:Scope,snapshotId:string):Promise<CloudPlanningCatalogV1|null>{
    const args=scopeArgs(scope);studyId(snapshotId,'snapshot');const row=await this.q('SELECT * FROM account_study_planning_catalogs WHERE user_id=? AND library_id=? AND snapshot_id=?',...args,snapshotId).first<{user_id:string;library_id:string;snapshot_id:string;source_hash:string;catalog_hash:string;catalog_json:string}>();
    if(!row)return null;const catalog=await parseCloudPlanningCatalog(JSON.parse(row.catalog_json));if(row.user_id!==scope.userId||row.library_id!==scope.libraryId||row.snapshot_id!==catalog.snapshotId||row.source_hash!==catalog.sourceHash||row.catalog_hash!==catalog.catalogHash)throw new Error('study-planning-catalog-integrity');return catalog;
  }
  private async catalogForHash(scope:Scope,catalogHash:string):Promise<CloudPlanningCatalogV1>{
    studyDigest(catalogHash);const row=await this.q('SELECT snapshot_id FROM account_study_planning_catalogs WHERE user_id=? AND library_id=? AND catalog_hash=?',...scopeArgs(scope),catalogHash).first<{snapshot_id:string}>();
    const catalog=row?await this.getCatalog(scope,row.snapshot_id):null;if(!catalog)throw new Error('unknown-planning-source');return catalog;
  }
  async getCatalogByHash(scope:Scope,catalogHash:string):Promise<CloudPlanningCatalogV1|null>{try{return await this.catalogForHash(scope,catalogHash);}catch(error){if(error instanceof Error&&error.message==='unknown-planning-source')return null;throw error;}}
  async putFacts(scope:Scope,raw:unknown):Promise<'accepted'|'duplicate'>{
    const args=scopeArgs(scope),facts=await parseCloudPlanningFacts(raw);if(facts.libraryId!==scope.libraryId)throw new Error('study-scope-mismatch');
    const catalog=await this.getCatalog(scope,facts.snapshotId);if(!catalog||catalog.catalogHash!==facts.catalogHash)throw new Error('unknown-planning-catalog');
    const old=await this.q('SELECT facts_json FROM account_study_planning_facts WHERE user_id=? AND library_id=? AND facts_hash=?',...args,facts.factsHash).first<{facts_json:string}>();
    if(old){if(canonicalizeJson(await parseCloudPlanningFacts(JSON.parse(old.facts_json)))!==canonicalizeJson(facts))throw new Error('planning-facts-conflict');return 'duplicate';}
    await this.q('INSERT INTO account_study_planning_facts(user_id,library_id,snapshot_id,catalog_hash,facts_hash,observed_at,facts_json) VALUES(?,?,?,?,?,?,?)',...args,facts.snapshotId,facts.catalogHash,facts.factsHash,facts.observedAt,canonicalizeJson(facts)).run();
    if(!(await this.getFacts(scope,facts.snapshotId,facts.factsHash)))throw new Error('planning-facts-storage-failed');return 'accepted';
  }
  async getFacts(scope:Scope,snapshotId:string,factsHash?:string):Promise<CloudPlanningFactsV1|null>{
    const args=scopeArgs(scope);studyId(snapshotId,'snapshot');if(factsHash!==undefined)studyDigest(factsHash);
    const row=await this.q(`SELECT * FROM account_study_planning_facts WHERE user_id=? AND library_id=? AND snapshot_id=?${factsHash===undefined?'':' AND facts_hash=?'} ORDER BY sequence DESC LIMIT 1`,...args,snapshotId,...(factsHash===undefined?[]:[factsHash])).first<{user_id:string;library_id:string;snapshot_id:string;catalog_hash:string;facts_hash:string;observed_at:string;facts_json:string}>();
    if(!row)return null;const facts=await parseCloudPlanningFacts(JSON.parse(row.facts_json));if(row.user_id!==scope.userId||row.library_id!==scope.libraryId||row.snapshot_id!==facts.snapshotId||row.catalog_hash!==facts.catalogHash||row.facts_hash!==facts.factsHash||row.observed_at!==facts.observedAt)throw new Error('planning-facts-integrity');return facts;
  }
  private async checkFence(scope:Scope,value:number):Promise<void>{
    studyCount(value,'planning-record-fence');const args=scopeArgs(scope),latest=await this.q('SELECT coalesce(max(sequence),0) AS value FROM account_study_records WHERE user_id=? AND library_id=?',...args).first<number>('value')??0;
    if(value>latest||value!==0&&!await this.q('SELECT sequence FROM account_study_records WHERE user_id=? AND library_id=? AND sequence=?',...args,value).first())throw new Error('invalid-planning-record-fence');
  }
  private async stateFromRow(scope:Scope,row:StateRow):Promise<SharedPlanState>{
    if(row.user_id!==scope.userId||row.library_id!==scope.libraryId||!validPlanDay(row.day)||!Number.isSafeInteger(row.revision)||row.revision<0||!['none','draft','approved','rejected','cancelled','restored'].includes(row.decision))throw new Error('study-plan-state-integrity');
    const parse=async(json:string|null,hash:string|null)=>{if((json===null)!==(hash===null))throw new Error('study-plan-state-integrity');if(!json)return null;const raw=JSON.parse(json),catalog=await this.catalogForHash(scope,raw.catalogHash),plan=await parseCloudTaskPlan(raw,catalog);if(plan.cloudPlanHash!==hash)throw new Error('study-plan-state-integrity');return plan;};
    const currentPlan=await parse(row.plan_json,row.plan_hash),approvedPlan=await parse(row.approved_plan_json,row.approved_plan_hash);
    if((approvedPlan===null)!==(row.approved_revision===null)||row.approved_revision!==null&&(!Number.isSafeInteger(row.approved_revision)||row.approved_revision<1||row.approved_revision>row.revision))throw new Error('study-plan-state-integrity');
    if(row.approved_operation_id!==null)studyId(row.approved_operation_id,'approved-operation');
    return {day:row.day,revision:row.revision,currentPlan,approvedPlan,approvedRevision:row.approved_revision,approvedOperationId:row.approved_operation_id,decision:row.decision as SharedPlanState['decision'],lastOperationId:row.last_operation_id};
  }
  async getState(scope:Scope,day:string):Promise<SharedPlanState>{
    scopeArgs(scope);if(!validPlanDay(day))throw new Error('invalid-plan-day');const row=await this.q('SELECT * FROM account_study_plan_states WHERE user_id=? AND library_id=? AND day=?',...scopeArgs(scope),day).first<StateRow>();
    return row?this.stateFromRow(scope,row):{day,revision:0,currentPlan:null,approvedPlan:null,approvedRevision:null,approvedOperationId:null,decision:'none',lastOperationId:null};
  }
  private async operation(scope:Scope,id:string):Promise<OperationRow|null>{scopeArgs(scope);studyId(id,'operation');return this.q('SELECT * FROM account_study_plan_operations WHERE user_id=? AND library_id=? AND operation_id=?',...scopeArgs(scope),id).first<OperationRow>();}
  private async operationWire(scope:Scope,row:OperationRow):Promise<StoredPlanOperation>{
    if(row.user_id!==scope.userId||row.library_id!==scope.libraryId||!validPlanDay(row.day)||!['save','approve','reject','cancel','restore'].includes(row.action)||!Number.isSafeInteger(row.sequence)||row.sequence<1||!Number.isSafeInteger(row.state_revision)||row.state_revision<1)throw new Error('plan-operation-integrity');
    let plan:null|CloudTaskPlanV1=null;if(row.plan_json){const raw=JSON.parse(row.plan_json),cat=await this.catalogForHash(scope,raw.catalogHash);plan=await parseCloudTaskPlan(raw,cat);if(plan.cloudPlanHash!==row.plan_hash)throw new Error('plan-operation-integrity');}else if(row.plan_hash!==null)throw new Error('plan-operation-integrity');
    if(row.predecessor_operation_id!==null)studyId(row.predecessor_operation_id,'predecessor-operation');return {sequence:row.sequence,operationId:row.operation_id,day:row.day,action:row.action,plan,predecessorOperationId:row.predecessor_operation_id,stateRevision:row.state_revision,receivedAt:row.received_at};
  }
  async listOperations(scope:Scope,after:number,limit:number,through?:number):Promise<{operations:StoredPlanOperation[];nextCursor:number|null;through:number}>{
    const args=scopeArgs(scope);studyCount(after,'operation-cursor');studyCount(limit,'operation-limit',1);if(limit>20)throw new Error('invalid-operation-limit');
    const latest=await this.q('SELECT coalesce(max(sequence),0) AS value FROM account_study_plan_operations WHERE user_id=? AND library_id=?',...args).first<number>('value')??0,fence=through??latest;
    studyCount(fence,'operation-fence');if(after>fence||fence>latest||fence!==0&&!await this.q('SELECT sequence FROM account_study_plan_operations WHERE user_id=? AND library_id=? AND sequence=?',...args,fence).first())throw new Error('invalid-operation-fence');
    const rows=(await this.q('SELECT * FROM account_study_plan_operations WHERE user_id=? AND library_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?',...args,after,fence,limit+1).all<OperationRow>()).results,operations:StoredPlanOperation[]=[];
    let bytes=48;
    for(const row of rows.slice(0,limit)){const operation=await this.operationWire(scope,row),nextBytes=new TextEncoder().encode(canonicalizeJson(operation)).byteLength+1;
      if(operations.length&&bytes+nextBytes>2_050_000)break;if(!operations.length&&nextBytes>2_100_000)throw new Error('plan-operation-too-large');operations.push(operation);bytes+=nextBytes;}
    const cursor=operations.at(-1)?.sequence??after,more=cursor<fence;if(!more&&cursor!==fence)throw new Error('invalid-operation-fence');
    return {operations,nextCursor:more?cursor:null,through:fence};
  }
  private async latestExecution(scope:Scope,operationId:string):Promise<StoredPlanExecution|null>{
    const row=await this.q('SELECT * FROM account_study_plan_execution_receipts WHERE user_id=? AND library_id=? AND operation_id=? ORDER BY sequence DESC LIMIT 1',...scopeArgs(scope),operationId).first<ExecutionRow>();
    if(!row)return null;const receipt=parsePlanExecutionReceipt(JSON.parse(row.payload_json));if(row.user_id!==scope.userId||row.library_id!==scope.libraryId||row.receipt_id!==receipt.receiptId||row.operation_id!==receipt.operationId||row.cloud_plan_hash!==receipt.cloudPlanHash||row.status!==receipt.status||row.payload_hash!==await studyHash(receipt))throw new Error('plan-execution-integrity');
    return {sequence:row.sequence,receipt,writerGrantId:row.writer_grant_id,receivedAt:row.received_at};
  }
  async claimExecution(scope:Scope,operationId:string,writerGrantId:string):Promise<{status:'accepted'|'duplicate';operationId:string;leaseUntil:string}>{
    const args=scopeArgs(scope);studyId(operationId,'operation');studyId(writerGrantId,'grant');const operation=await this.operation(scope,operationId);
    if(!operation||!['approve','restore'].includes(operation.action))throw new Error('unknown-plan-execution-operation');
    if(!await this.q("SELECT grant_id FROM account_study_grants WHERE user_id=? AND library_id=? AND grant_id=? AND state='active' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')",...args,writerGrantId).first())throw new Error('study-writer-required');
    await this.q("INSERT INTO account_study_plan_claims(user_id,library_id,operation_id,writer_grant_id,state,lease_until) SELECT ?,?,?,?,'claimed','9999-12-31T23:59:59.999Z' WHERE NOT EXISTS (SELECT 1 FROM account_study_plan_operations WHERE user_id=? AND library_id=? AND action='cancel' AND predecessor_operation_id=?) ON CONFLICT DO NOTHING",...args,operationId,writerGrantId,...args,operationId).run();
    let saved=await this.q('SELECT writer_grant_id,state,lease_until FROM account_study_plan_claims WHERE user_id=? AND library_id=? AND operation_id=?',...args,operationId).first<{writer_grant_id:string;state:string;lease_until:string}>();
    if(!saved){if(await this.q("SELECT operation_id FROM account_study_plan_operations WHERE user_id=? AND library_id=? AND action='cancel' AND predecessor_operation_id=?",...args,operationId).first())throw new Error('plan-operation-cancelled');throw new Error('plan-operation-in-flight');}
    if(saved.writer_grant_id!==writerGrantId){await this.q("UPDATE account_study_plan_claims SET writer_grant_id=? WHERE user_id=? AND library_id=? AND operation_id=? AND writer_grant_id=? AND state IN ('claimed','completed','blocked') AND NOT EXISTS (SELECT 1 FROM account_study_grants old WHERE old.grant_id=account_study_plan_claims.writer_grant_id AND old.state='active' AND old.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND (SELECT count(*) FROM account_study_grants current WHERE current.user_id=? AND current.library_id=? AND current.state='active' AND current.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))=1",writerGrantId,...args,operationId,saved.writer_grant_id,...args).run();saved=await this.q('SELECT writer_grant_id,state,lease_until FROM account_study_plan_claims WHERE user_id=? AND library_id=? AND operation_id=?',...args,operationId).first<{writer_grant_id:string;state:string;lease_until:string}>();}
    if(!saved||saved.writer_grant_id!==writerGrantId)throw new Error('plan-operation-in-flight');return{status:saved.state==='claimed'?'accepted':'duplicate',operationId,leaseUntil:saved.lease_until};
  }
  async appendExecution(scope:Scope,raw:unknown,writerGrantId:string):Promise<{status:'accepted'|'duplicate'|'conflict';execution:StoredPlanExecution}>{
    const args=scopeArgs(scope),receipt=parsePlanExecutionReceipt(raw);studyId(writerGrantId,'grant');
    const opRow=await this.operation(scope,receipt.operationId);if(!opRow||!opRow.plan_json||!['approve','restore'].includes(opRow.action))throw new Error('unknown-plan-execution-operation');
    const operation=await this.operationWire(scope,opRow);if(!operation.plan||operation.plan.cloudPlanHash!==receipt.cloudPlanHash)throw new Error('plan-execution-binding');
    const active=await this.q("SELECT grant_id FROM account_study_grants WHERE user_id=? AND library_id=? AND grant_id=? AND state='active' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')",...args,writerGrantId).first();if(!active)throw new Error('study-writer-required');
    const hash=await studyHash(receipt),sameId=await this.q('SELECT payload_hash FROM account_study_plan_execution_receipts WHERE user_id=? AND library_id=? AND receipt_id=?',...args,receipt.receiptId).first<string>('payload_hash'),claim=await this.q("SELECT writer_grant_id,state FROM account_study_plan_claims WHERE user_id=? AND library_id=? AND operation_id=?",...args,receipt.operationId).first<{writer_grant_id:string;state:string}>();
    if(sameId){if(!claim||claim.writer_grant_id!==writerGrantId||!['claimed','completed','blocked'].includes(claim.state))throw new Error('plan-execution-claim-required');const execution=await this.latestExecution(scope,receipt.operationId);if(!execution)throw new Error('plan-execution-integrity');if(sameId===hash)await this.q("UPDATE account_study_plan_claims SET state=?,lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=? AND library_id=? AND operation_id=? AND writer_grant_id=?",receipt.status==='applied'?'completed':'blocked',...args,receipt.operationId,writerGrantId).run();return {status:sameId===hash?'duplicate':'conflict',execution};}
    const before=await this.latestExecution(scope,receipt.operationId);
    if(before?.receipt.status==='applied'){
      const prior={...before.receipt} as Partial<PlanExecutionReceipt>,next={...receipt} as Partial<PlanExecutionReceipt>;delete prior.receiptId;delete next.receiptId;
      return {status:receipt.status==='applied'&&canonicalizeJson(prior)===canonicalizeJson(next)?'duplicate':'conflict',execution:before};
    }
    if(before?.receipt.status==='blocked'){const prior={...before.receipt} as Partial<PlanExecutionReceipt>,next={...receipt} as Partial<PlanExecutionReceipt>;delete prior.receiptId;delete next.receiptId;return{status:receipt.status==='blocked'&&canonicalizeJson(prior)===canonicalizeJson(next)?'duplicate':'conflict',execution:before};}
    if(!claim||claim.writer_grant_id!==writerGrantId||claim.state!=='claimed')throw new Error('plan-execution-claim-required');
    if(receipt.status==='applied'){
      const predecessor=operation.predecessorOperationId?await this.latestExecution(scope,operation.predecessorOperationId):null;
      const expected=predecessor?.receipt.status==='applied'?predecessor.receipt.proof!.localRevision:operation.predecessorOperationId?null:operation.plan.nativeBaseRevision;
      if(expected===null)throw new Error('plan-predecessor-pending');if(receipt.proof!.localRevision!==expected+1)throw new Error('plan-execution-revision');
    }
    await this.q("INSERT INTO account_study_plan_execution_receipts(user_id,library_id,receipt_id,operation_id,cloud_plan_hash,status,payload_hash,payload_json,writer_grant_id) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM account_study_grants WHERE user_id=? AND library_id=? AND grant_id=? AND state='active' AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND NOT EXISTS (SELECT 1 FROM account_study_plan_execution_receipts WHERE user_id=? AND library_id=? AND operation_id=? AND status='applied')",...args,receipt.receiptId,receipt.operationId,receipt.cloudPlanHash,receipt.status,hash,canonicalizeJson(receipt),writerGrantId,...args,writerGrantId,...args,receipt.operationId).run();
    const execution=await this.latestExecution(scope,receipt.operationId);if(!execution)throw new Error('plan-execution-storage-failed');if(execution.receipt.receiptId===receipt.receiptId)await this.q("UPDATE account_study_plan_claims SET state=?,lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=? AND library_id=? AND operation_id=? AND writer_grant_id=?",receipt.status==='applied'?'completed':'blocked',...args,receipt.operationId,writerGrantId).run();return {status:execution.receipt.receiptId===receipt.receiptId?'accepted':'conflict',execution};
  }
  async listExecutions(scope:Scope,after:number,limit:number,through?:number):Promise<{executions:StoredPlanExecution[];nextCursor:number|null;through:number}>{
    const args=scopeArgs(scope);studyCount(after,'execution-cursor');studyCount(limit,'execution-limit',1);if(limit>20)throw new Error('invalid-execution-limit');
    const latest=await this.q('SELECT coalesce(max(sequence),0) AS value FROM account_study_plan_execution_receipts WHERE user_id=? AND library_id=?',...args).first<number>('value')??0,fence=through??latest;
    studyCount(fence,'execution-fence');if(after>fence||fence>latest||fence!==0&&!await this.q('SELECT sequence FROM account_study_plan_execution_receipts WHERE user_id=? AND library_id=? AND sequence=?',...args,fence).first())throw new Error('invalid-execution-fence');
    const rows=(await this.q('SELECT * FROM account_study_plan_execution_receipts WHERE user_id=? AND library_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?',...args,after,fence,limit+1).all<ExecutionRow>()).results,executions=[];
    for(const row of rows.slice(0,limit)){const receipt=parsePlanExecutionReceipt(JSON.parse(row.payload_json));if(row.user_id!==scope.userId||row.library_id!==scope.libraryId||row.receipt_id!==receipt.receiptId||row.operation_id!==receipt.operationId||row.payload_hash!==await studyHash(receipt))throw new Error('plan-execution-integrity');executions.push({sequence:row.sequence,receipt,writerGrantId:row.writer_grant_id,receivedAt:row.received_at});}
    if(rows.length<=limit&&(executions.at(-1)?.sequence??after)!==fence)throw new Error('invalid-execution-fence');return {executions,nextCursor:rows.length>limit?executions.at(-1)!.sequence:null,through:fence};
  }
  async validateTaskRecord(scope:Scope,record:StudyRecordEnvelope):Promise<void>{
    if(record.provenanceMode!=='task')throw new Error('task-record-required');const event=record.event,row=await this.q("SELECT a.* FROM account_study_plan_operations a WHERE a.user_id=? AND a.library_id=? AND a.day=? AND a.plan_hash=? AND a.action IN ('approve','restore') AND julianday(a.received_at)<=julianday(?) AND NOT EXISTS (SELECT 1 FROM account_study_plan_operations c WHERE c.user_id=a.user_id AND c.library_id=a.library_id AND c.action='cancel' AND c.predecessor_operation_id=a.operation_id AND julianday(c.received_at)<julianday(?)) ORDER BY a.sequence DESC LIMIT 1",...scopeArgs(scope),event.day,record.planHash,event.occurredAt,event.occurredAt).first<OperationRow>(),operation=row?await this.operationWire(scope,row):null,plan=operation?.plan;
    if(!plan||plan.cloudPlanHash!==record.planHash)throw new Error('task-plan-not-approved');const task=plan.tasks.find(task=>task.taskId===event.taskId);
    if(!task||record.assignmentId!==task.taskId||event.subjectId!==task.subjectId||canonicalizeJson(event.unitIds)!==canonicalizeJson(task.unitIds)||event.day!==plan.day)throw new Error('task-plan-binding');
    const expected=`completion:${await studyHash([plan.cloudPlanHash,task.taskId,task.unitIds,event.day])}`;if(record.completionKey!==expected)throw new Error('task-completion-binding');
    if(event.source==='self-report'){
      if(task.completionRule!=='self-report'||event.evidenceRefs.length)throw new Error('task-evidence-required');
    }else throw new Error('task-evidence-not-yet-verified');
  }
  async mutate(scope:Scope,raw:unknown):Promise<MutationResult>{
    const args=scopeArgs(scope),base=studyObject(raw,['action','operationId','expectedRevision'],['plan','day','planHash','targetOperationId','predecessorOperationId']);studyId(base.operationId,'operation');studyCount(base.expectedRevision,'expected-revision');
    if(!['save','approve','reject','cancel','restore'].includes(String(base.action)))throw new Error('unsupported-plan-action');
    const requestHash=await studyHash(base),prior=await this.operation(scope,base.operationId as string);
    if(prior){if(prior.request_hash!==requestHash)throw new Error('plan-operation-conflict');return {status:'duplicate',state:await this.getState(scope,prior.day),operationRevision:prior.state_revision};}
    let day:string,plan:CloudTaskPlanV1|null=null,target:OperationRow|null=null;
    if(base.action==='save'){
      studyObject(base,['action','operationId','expectedRevision','plan']);const candidate=base.plan as CloudTaskPlanV1,cat=await this.catalogForHash(scope,candidate?.catalogHash);plan=await parseCloudTaskPlan(candidate,cat);day=plan.day;
      if(plan.baseRevision!==base.expectedRevision)throw new Error('plan-base-revision');
      const facts=await this.getFacts(scope,cat.snapshotId,plan.factsHash);if(!facts||facts.catalogHash!==plan.catalogHash)throw new Error('unknown-planning-facts');
      if(plan.nativeBaseRevision!==facts.nativePlanRevision)throw new Error('plan-native-base-revision');
      await this.checkFence(scope,plan.eventThrough);await this.checkFence(scope,plan.taskThrough);
    } else {
      studyObject(base,['action','operationId','expectedRevision','day',...(base.action==='restore'?['targetOperationId','predecessorOperationId']:base.action==='approve'?['planHash','predecessorOperationId']:base.action==='cancel'?['targetOperationId']:['planHash'])]);
      if(!validPlanDay(base.day))throw new Error('invalid-plan-day');day=base.day;
      if(base.action==='restore'){studyId(base.targetOperationId,'target-operation');target=await this.operation(scope,base.targetOperationId as string);if(!target||target.day!==day||!target.plan_json)throw new Error('unknown-plan-restore');const rawPlan=JSON.parse(target.plan_json),cat=await this.catalogForHash(scope,rawPlan.catalogHash);plan=await parseCloudTaskPlan(rawPlan,cat);}
      else if(base.action==='cancel'){studyId(base.targetOperationId,'target-operation');target=await this.operation(scope,base.targetOperationId as string);if(!target||target.day!==day||!target.plan_json||!['approve','restore'].includes(target.action))throw new Error('unknown-plan-cancel');const rawPlan=JSON.parse(target.plan_json),cat=await this.catalogForHash(scope,rawPlan.catalogHash);plan=await parseCloudTaskPlan(rawPlan,cat);}
      else studyDigest(base.planHash);
      if((base.action==='approve'||base.action==='restore')&&base.predecessorOperationId!==null)studyId(base.predecessorOperationId,'predecessor-operation');
    }
    await this.q('INSERT INTO account_study_plan_states(user_id,library_id,day,revision,decision) VALUES(?,?,?,0,\'none\') ON CONFLICT DO NOTHING',...args,day).run();
    const before=await this.getState(scope,day);if(before.revision!==base.expectedRevision)return {status:'stale',state:before};
    if((base.action==='approve'||base.action==='restore')&&base.predecessorOperationId!==before.approvedOperationId)throw new Error('plan-predecessor-mismatch');
    if(base.action==='cancel'&&base.targetOperationId!==before.approvedOperationId)throw new Error('plan-cancel-target-changed');
    if(base.action==='cancel'&&await this.q("SELECT operation_id FROM account_study_plan_claims WHERE user_id=? AND library_id=? AND operation_id=? AND state IN ('claimed','completed')",...args,base.targetOperationId).first())throw new Error('plan-operation-in-flight');
    if(base.action!=='save'&&base.action!=='restore'&&base.action!=='cancel'){
      if(!before.currentPlan||before.currentPlan.cloudPlanHash!==base.planHash)throw new Error('unknown-current-plan');plan=before.currentPlan;
    }
    const next=before.revision+1;let current=before.currentPlan,approved=before.approvedPlan,approvedRevision=before.approvedRevision,approvedOperationId=before.approvedOperationId,decision:SharedPlanState['decision']='draft';
    if(base.action==='save')current=plan;
    else if(base.action==='approve'){approved=plan;approvedRevision=next;approvedOperationId=base.operationId as string;decision='approved';}
    else if(base.action==='reject')decision='rejected';
    else if(base.action==='cancel'){
      const predecessor=target?.predecessor_operation_id?await this.operation(scope,target.predecessor_operation_id):null;
      if(predecessor?.plan_json){const rawPlan=JSON.parse(predecessor.plan_json),cat=await this.catalogForHash(scope,rawPlan.catalogHash);approved=await parseCloudTaskPlan(rawPlan,cat);approvedRevision=predecessor.state_revision;approvedOperationId=predecessor.operation_id;}
      else {approved=null;approvedRevision=null;approvedOperationId=null;}decision='cancelled';
    }
    else {current=plan;approved=plan;approvedRevision=next;approvedOperationId=base.operationId as string;decision='restored';}
    const update=this.q(`UPDATE account_study_plan_states SET revision=?,plan_hash=?,plan_json=?,approved_plan_hash=?,approved_plan_json=?,approved_revision=?,approved_operation_id=?,decision=?,last_operation_id=? WHERE user_id=? AND library_id=? AND day=? AND revision=?${base.action==='cancel'?" AND NOT EXISTS (SELECT 1 FROM account_study_plan_claims WHERE user_id=? AND library_id=? AND operation_id=? AND state IN ('claimed','completed'))":''}`,
      next,current?.cloudPlanHash??null,current?canonicalizeJson(current):null,approved?.cloudPlanHash??null,approved?canonicalizeJson(approved):null,approvedRevision,approvedOperationId,decision,base.operationId,...args,day,before.revision,...(base.action==='cancel'?[...args,base.targetOperationId]:[]));
    const operation=this.q('INSERT INTO account_study_plan_operations(user_id,library_id,day,operation_id,action,request_hash,plan_hash,plan_json,predecessor_operation_id,state_revision) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM account_study_plan_states WHERE user_id=? AND library_id=? AND day=? AND revision=? AND last_operation_id=?)',
      ...args,day,base.operationId,base.action,requestHash,plan?.cloudPlanHash??null,plan?canonicalizeJson(plan):null,base.action==='cancel'?base.targetOperationId:base.predecessorOperationId??null,next,...args,day,next,base.operationId);
    await this.database.batch([update,operation]);const saved=await this.operation(scope,base.operationId as string);
    if(!saved){if(base.action==='cancel'&&await this.q("SELECT operation_id FROM account_study_plan_claims WHERE user_id=? AND library_id=? AND operation_id=? AND state IN ('claimed','completed')",...args,base.targetOperationId).first())throw new Error('plan-operation-in-flight');return {status:'stale',state:await this.getState(scope,day)};}
    const state=await this.getState(scope,day);if(state.revision!==next||state.lastOperationId!==base.operationId)throw new Error('study-plan-mutation-integrity');return {status:'accepted',state,operationRevision:next};
  }
}
