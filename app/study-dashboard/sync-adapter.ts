import {flushStudyEventTargets} from '../../src/application/sync';
import type {CloudBatchResult,CompanionActivityResult,LocalStudyEventRecord} from '../../src/domain/sync';
import type {StudyEventV3,LocalEventContext} from '../../src/domain/evidence';
import {listPendingStudyEvents,updateStudyEventDelivery} from '../local-study-events';

/** Existing IndexedDB indexes are the authoritative outbox; this adapter creates no second queue. */
export function drainOriginalEventTargets(owner:string,sendCloud:(event:StudyEventV3)=>Promise<CloudBatchResult>,
  sendCompanion:(event:StudyEventV3,context?:LocalEventContext)=>Promise<CompanionActivityResult>){
  return flushStudyEventTargets(owner,{
    listPending:async workspace=>{
      const [cloud,companion]=await Promise.all([listPendingStudyEvents(workspace,'cloud'),listPendingStudyEvents(workspace,'companion')]);
      const byId=new Map<string,LocalStudyEventRecord>();for(const record of [...cloud,...companion])byId.set(record.eventId,record);return[...byId.values()];
    },sendCloud,sendCompanion:({event,localContext})=>sendCompanion(event,localContext),updateDelivery:updateStudyEventDelivery,
  });
}
