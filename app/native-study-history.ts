import type {StudyEventV3} from './study-event-v3';
import type {SubmissionJournal} from './study-submission-journal';
// @ts-expect-error TS5097: standalone Node contracts.
import {listWorkspaceStudyEvents} from './local-study-events.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {listAllLocalAccountStudyRecords} from './local-account-study.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {mergeRecoverableStudyEvents} from './study-submission-history.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseCloudStudyEventV3} from './study-event-v3.ts';

/** Classify browser replicas by exact event identity, never by item key alone.
 * Current Companion evidence is independently supplied by the source-checked
 * caller, so a verified writeback from the matching account library may return. */
export async function readNativeStudyHistory(workspaceId:string,journal:Pick<SubmissionJournal,'list'>,options:{cachedEvents?:StudyEventV3[];companionEvents?:StudyEventV3[]}={}):Promise<{events:StudyEventV3[];excludedKeys:string[]}>{
  const cached=structuredClone(options.cachedEvents??[]),companion=structuredClone(options.companionEvents??[]);
  const originals=await listWorkspaceStudyEvents(workspaceId),submissions=await journal.list(workspaceId),accounts=workspaceId.startsWith('account:')?await listAllLocalAccountStudyRecords(workspaceId):[];
  const known=new Map<string,string>(),excludedKeys=new Set<string>();
  for(const record of [...accounts.map(row=>row.record),...submissions.flatMap(row=>row.payload.route.kind==='account'?[row.payload.route.record]:[])])if(record.provenanceMode!=='task'){
    const prior=known.get(record.event.eventId);if(prior&&prior!==record.event.coreHash)throw new Error('native-history-account-conflict');
    known.set(record.event.eventId,record.event.coreHash);excludedKeys.add(record.event.item.key);
  }
  const rows=await mergeRecoverableStudyEvents(workspaceId,originals,submissions),events=new Map<string,StudyEventV3>();
  const add=(event:StudyEventV3)=>{const prior=events.get(event.eventId);if(prior&&prior.coreHash!==event.coreHash)throw new Error('native-history-event-conflict');events.set(event.eventId,event);};
  for(const raw of [...rows.map(row=>row.event),...cached]){
    const event=await parseCloudStudyEventV3(raw),accountHash=known.get(event.eventId);
    if(accountHash){if(accountHash!==event.coreHash)throw new Error('native-history-account-conflict');continue;}add(event);
  }
  for(const raw of companion){const event=await parseCloudStudyEventV3(raw),accountHash=known.get(event.eventId);if(accountHash&&accountHash!==event.coreHash)throw new Error('native-history-companion-conflict');add(event);}
  return{events:[...events.values()],excludedKeys:[...excludedKeys].sort()};
}
