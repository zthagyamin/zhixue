import type {LocalStudyEventRecord} from './local-study-events';
import type {SubmissionJournal,SubmissionRow} from './study-submission-journal';
import type {StudyRecordEnvelope} from './account-study-record';
import type {StudyBundle} from './account-study-content';
// @ts-expect-error TS5097: standalone Node contracts.
import {listWorkspaceStudyEvents} from './local-study-events.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {listLocalStudyRecords,getLocalStudySnapshot} from './local-account-study.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseCloudStudyEventV3} from './study-event-v3.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyIso,studyId} from './account-study-content.ts';

/** Complete known local core history. An unreadable journal is unknown, never
 * an empty set; it may be the only durable copy of a just-submitted attempt. */
export async function readRecoverableStudyEvents(workspaceId:string,journal:Pick<SubmissionJournal,'list'>):Promise<LocalStudyEventRecord[]>{
  studyId(workspaceId,'workspace');const [original,rows]=await Promise.all([listWorkspaceStudyEvents(workspaceId),journal.list(workspaceId)]);return mergeRecoverableStudyEvents(workspaceId,original,rows);
}
export async function mergeRecoverableStudyEvents(workspaceId:string,original:LocalStudyEventRecord[],rows:SubmissionRow[]):Promise<LocalStudyEventRecord[]>{
  const records=new Map<string,LocalStudyEventRecord>();
  for(const raw of [...rows.map(row=>row.payload.core),...original]){
    const value=structuredClone(raw),event=await parseCloudStudyEventV3(value.event);studyIso(value.updatedAt);
    if(value.workspaceId!==workspaceId||value.eventId!==event.eventId||value.occurredAt!==event.occurredAt||![value.cloud,value.companion].every(flag=>['pending','not-required','acked','conflict'].includes(flag)))throw new Error('local-event-history-binding');
    const prior=records.get(value.eventId);if(prior&&prior.event.coreHash!==event.coreHash)throw new Error('study-event-history-conflict');
    records.set(value.eventId,{...value,event});
  }
  return [...records.values()].sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt)||a.eventId.localeCompare(b.eventId));
}
/** Local evidence has no cloud sequence. Use only for the local display; shared
 * plan mutations continue to require their original complete remote fences. */
export async function readAccountLocalPractice(workspaceId:string,libraryId:string,journal:Pick<SubmissionJournal,'list'>):Promise<{records:StudyRecordEnvelope[];taskRecords:StudyRecordEnvelope[];taskAckedIds:Set<string>;bundles:StudyBundle[];pendingKeys:Set<string>;pendingIds:Set<string>}>{
  const [original,submissions]=await Promise.all([listLocalStudyRecords(workspaceId,libraryId),journal.list(workspaceId)]),records=new Map<string,StudyRecordEnvelope>(),pendingIds=new Set<string>();
  for(const row of submissions)if(row.payload.route.kind==='account'&&row.payload.route.record.libraryId===libraryId){const record=row.payload.route.record;records.set(record.event.eventId,record);pendingIds.add(record.event.eventId);}
  for(const row of original)if(row.record.provenanceMode!=='task'){
    const record=row.record,prior=records.get(record.event.eventId);if(prior&&prior.envelopeHash!==record.envelopeHash)throw new Error('account-local-record-conflict');records.set(record.event.eventId,record);
    if(row.cloud==='acked')pendingIds.delete(record.event.eventId);else pendingIds.add(record.event.eventId);
  }
  const taskRecords=original.filter(row=>row.record.provenanceMode==='task').map(row=>row.record);
  const taskAckedIds=new Set(original.filter(row=>row.record.provenanceMode==='task'&&row.cloud==='acked').map(row=>row.record.event.eventId));
  const bundles:StudyBundle[]=[];
  for(const snapshotId of new Set([...records.values(),...taskRecords].map(record=>record.snapshotId))){const bundle=await getLocalStudySnapshot(workspaceId,libraryId,snapshotId);if(!bundle)throw new Error('account-local-history-snapshot-missing');bundles.push(bundle);}
  return{records:[...records.values()],taskRecords,taskAckedIds,bundles,pendingIds,pendingKeys:new Set([...records.values()].filter(record=>pendingIds.has(record.event.eventId)).map(record=>record.event.eventType==='practice-attempt'?record.event.item.key:''))};
}
