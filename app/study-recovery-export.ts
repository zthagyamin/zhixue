// @ts-expect-error TS5097: standalone Node contracts.
import {exportAllLocalAccountStudy} from './local-account-study.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createSubmissionJournal} from './study-submission-journal.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createAssistanceReadCache} from './assistance-read-cache.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {exportAccountProgress} from './account-study-progress.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {readRecoverableStudyEvents} from './study-submission-history.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {exportRecoveryWorkspaceRecords} from './local-study-db.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {exportTaskEventRecords} from './local-task-events.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {hashLocalJson} from './local-json-integrity.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyId} from './account-study-content.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {checkStudyRecordBinding} from './account-study-record.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {scopeRecoveryRecords} from './recovery-causal-scope.ts';

function owner(workspaceId:string){if(!workspaceId.startsWith('account:'))throw new Error('recovery-account-required');studyId(workspaceId.slice(8),'owner');}
/** Every reader validates its own stored evidence. No current-library parameter:
 * historical libraries and independently queued summaries remain discoverable. */
export async function collectStudyRecovery(workspaceId:string){
  owner(workspaceId);const journal=createSubmissionJournal();
  const [accountLibraries,coreEvents,submissions,assistanceViews,accountProgress,workspaceRecords,taskEvents]=await Promise.all([
    exportAllLocalAccountStudy(workspaceId),readRecoverableStudyEvents(workspaceId,journal),journal.list(workspaceId),createAssistanceReadCache().exportOwner(workspaceId),
    exportAccountProgress(workspaceId),exportRecoveryWorkspaceRecords(workspaceId),exportTaskEventRecords(workspaceId),
  ]);
  return{accountLibraries,coreEvents,submissions,assistanceViews,accountProgress,workspaceRecords,taskEvents};
}
export type StudyRecoveryPayload=Awaited<ReturnType<typeof collectStudyRecovery>>;
function describe(payload:StudyRecoveryPayload){
  const snapshots=new Map(payload.accountLibraries.flatMap(library=>library.snapshots.map(bundle=>[JSON.stringify([library.libraryId,bundle.snapshot.snapshotId]),bundle] as const)));
  const assigned=new Set(payload.submissions.map(row=>row.eventId)),missing=new Set<string>();
  const scoped=scopeRecoveryRecords([...payload.accountLibraries.flatMap(library=>library.records.map(row=>row.record)),...payload.submissions.flatMap(row=>row.payload.route.kind==='account'?[row.payload.route.record]:[]),...payload.assistanceViews.flatMap(view=>view.summaries.map(row=>row.parent))]);
  const records=scoped.records;
  for(const record of records){assigned.add(record.event.eventId);const snapshot=snapshots.get(JSON.stringify([record.libraryId,record.snapshotId]));
    if(!snapshot)missing.add(`snapshot:${record.libraryId}:${record.snapshotId}`);
    else if(record.provenanceMode!=='task'){
      const item=snapshot.items.find(item=>item.itemKey===record.event.item.key&&item.contentHash===record.contentHash);
      if(!item)missing.add(`item-version:${record.libraryId}:${record.snapshotId}:${record.event.item.key}`);
      else try{if(checkStudyRecordBinding(record,item,scoped.candidates(record))!=='ready')missing.add(`parent:${record.event.eventId}`);}catch{missing.add(`record-binding:${record.event.eventId}`);}
    }
  }
  const coreUploads=new Set<string>(),coreWritebacks=new Set<string>(),recovery=new Set<string>(),assistance=new Set<string>();
  for(const row of payload.coreEvents){if(row.cloud==='pending'||row.cloud==='conflict')coreUploads.add(row.eventId);if(row.companion==='pending'||row.companion==='conflict')coreWritebacks.add(row.eventId);}
  // Portable receipts supersede the original journal's initial delivery flag.
  for(const library of payload.accountLibraries)for(const row of library.records){if(row.cloud==='acked')coreUploads.delete(row.record.event.eventId);else coreUploads.add(row.record.event.eventId);if(row.writeback!=='applied')coreWritebacks.add(row.record.event.eventId);else coreWritebacks.delete(row.record.event.eventId);}
  const appliedAuxiliary=new Set<string>();
  for(const view of payload.assistanceViews)for(const row of view.receipts)if(row.receipt.status==='applied')appliedAuxiliary.add(row.receipt.associationHash);
  for(const row of payload.submissions){if(!row.coreStored)recovery.add(row.eventId);const summary=row.payload.summary;
    if(summary&&row.writeback?.receipt.status!=='applied'&&(!row.associationHash||!appliedAuxiliary.has(row.associationHash)))assistance.add(summary.summaryId);
  }
  for(const view of payload.assistanceViews)for(const row of view.summaries)if(!appliedAuxiliary.has(row.record.associationHash))assistance.add(row.record.summary.summaryId);
  const legacyQueues=payload.workspaceRecords.filter(row=>row.kind==='pending-activities'||row.kind==='cloud-outbox');
  const pending={coreUploads:[...coreUploads].sort(),coreWritebacks:[...coreWritebacks].sort(),recovery:[...recovery].sort(),assistance:[...assistance].sort(),tasks:payload.taskEvents.filter(row=>!row.delivered).map(row=>row.eventId).sort(),legacyQueues:legacyQueues.some(row=>!Array.isArray(row.value)||row.value.length>0)};
  return{missingDependencies:[...missing].sort(),unassignedLegacyEventIds:payload.coreEvents.filter(row=>!assigned.has(row.eventId)).map(row=>row.eventId).sort(),pending};
}
/** Cross-database reads are not atomic. Compare complete validated captures,
 * expose the read interval and refuse a complete-backup claim during changes. */
export async function exportStudyRecovery(workspaceId:string,options:{collect?:()=>Promise<StudyRecoveryPayload>;now?:()=>Date}={}){
  owner(workspaceId);const now=options.now??(()=>new Date()),read=options.collect??(()=>collectStudyRecovery(workspaceId)),startedAt=now().toISOString();
  let payload=await read(),payloadHash=await hashLocalJson(payload),consistency:'stable'|'changed-during-read'='changed-during-read';
  for(let attempt=0;attempt<3;attempt++){const next=await read(),hash=await hashLocalJson(next);payload=next;if(hash===payloadHash){consistency='stable';break;}payloadHash=hash;}
  const description=describe(payload);return{schemaVersion:1 as const,format:'zhixue-study-recovery-v1' as const,workspaceId,startedAt,finishedAt:now().toISOString(),consistency,
    complete:consistency==='stable'&&description.missingDependencies.length===0,...description,payload,payloadHash};
}
export function hasPendingStudyRecovery(value:Awaited<ReturnType<typeof exportStudyRecovery>>):boolean{
  const p=value.pending;return !value.complete||p.legacyQueues||[p.coreUploads,p.coreWritebacks,p.recovery,p.assistance,p.tasks].some(ids=>ids.length>0);
}
