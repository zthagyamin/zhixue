import type {StudyRecordEnvelope} from './account-study-record';
// @ts-expect-error TS5097: standalone Node contracts.
import {compareStudyRecord} from './account-study-record.ts';

function causalKey(record:StudyRecordEnvelope):string|null{
  return record.provenanceMode==='task'?null:JSON.stringify([record.libraryId,record.originDeviceId,record.provenanceMode,record.provenanceMode==='verified-round'?record.roundId:record.resumeId]);
}
/** Independent stores contain copies, not extra ancestors. Do not put source,
 * content or mode in the group key: inconsistency inside one round must fail. */
export function scopeRecoveryRecords(copies:readonly StudyRecordEnvelope[]){
  const unique=new Map<string,StudyRecordEnvelope>(),groups=new Map<string,StudyRecordEnvelope[]>();
  for(const record of copies){const identity=JSON.stringify([record.libraryId,record.event.eventId]),prior=unique.get(identity);
    if(prior){if(compareStudyRecord(prior,record)!=='duplicate')throw new Error('recovery-record-conflict');continue;}
    unique.set(identity,record);const key=causalKey(record);if(key!==null){let group=groups.get(key);if(!group){group=[];groups.set(key,group);}group.push(record);}
  }
  return{records:[...unique.values()],candidates:(record:StudyRecordEnvelope):readonly StudyRecordEnvelope[]=>groups.get(causalKey(record)??'')??[]};
}
