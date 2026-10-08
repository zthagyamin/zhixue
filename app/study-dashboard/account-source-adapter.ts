import type {AccountStudyLoaded} from '../account-study-client';
import {getLocalStudySnapshot,putLocalStudySnapshot,cacheLocalStudySnapshot,materializeStudyHistory} from '../local-account-study';
import {readAccountLocalPractice} from '../study-submission-history';
import {composeAccountPlanningInput} from '../account-study-planning-projection';
import {rebuildEventProgress} from '../review-projection';
import {studyHash} from '../account-study-content';
import {loadAccountProgress} from '../account-study-progress';
import type {StudyEventV3} from '../study-event-v3';
import type {SubmissionJournal} from '../study-submission-journal';

/** Existing validated snapshots/history stay in their original stores. No UI state or mode decisions. */
export async function prepareAccountSource(owner:string,value:AccountStudyLoaded,current:()=>boolean){
  const prior=await getLocalStudySnapshot(owner,value.bundle.snapshot.libraryId);if(!current())return[];
  if(!prior)await putLocalStudySnapshot(owner,value.bundle,0);
  else if(prior.snapshot.snapshotId!==value.bundle.snapshot.snapshotId)await putLocalStudySnapshot(owner,value.bundle,prior.snapshot.revision);
  for(const bundle of value.bundles){if(!current())return[];if(bundle.snapshot.snapshotId!==value.bundle.snapshot.snapshotId)await cacheLocalStudySnapshot(owner,bundle);}
  return materializeStudyHistory(owner,value.bundle.snapshot.libraryId,value.bundles,value.records,value.writebacks,current);
}
export async function projectAccountSource(owner:string,value:AccountStudyLoaded,options:{day:string;deviceId:string;journal:SubmissionJournal}){
  let projection:Awaited<ReturnType<typeof rebuildEventProgress>>|null=null;
  let history:StudyEventV3[]=[],evidenceHash:string|null=null,pendingKeys=new Set<string>(),pendingIds=new Set<string>();
  try{
    const local=await readAccountLocalPractice(owner,value.bundle.snapshot.libraryId,options.journal);pendingKeys=local.pendingKeys;pendingIds=local.pendingIds;
    const bundles=[...new Map([...value.bundles,...local.bundles].map(bundle=>[bundle.snapshot.snapshotId,bundle])).values()];
    const composed=await composeAccountPlanningInput({day:options.day,catalog:value.catalog,facts:value.facts,bundle:value.bundle,bundles,records:value.records,localPracticeRecords:local.records,eventThrough:value.eventThrough,taskThrough:value.taskThrough,previous:null});
    const visible=new Set([...value.records.map(row=>row.record),...local.records].filter(record=>record.provenanceMode!=='task'&&(record.originDeviceId===options.deviceId||record.event.attempt.correct&&record.event.attempt.stageAfter===3)).map(record=>record.event.eventId));
    history=composed.events;projection=await rebuildEventProgress(composed.events.filter(event=>event.eventType!=='practice-attempt'||visible.has(event.eventId)));
    evidenceHash=await studyHash(projection.events.map(event=>[event.eventId,event.coreHash]));
  }catch{/* Incomplete/conflicting evidence cannot replace proven local progress. */}
  const cachedProgress=await loadAccountProgress(owner,value.bundle.snapshot.libraryId).catch(()=>null);
  return{projection,history,evidenceHash,pendingKeys,pendingIds,cachedProgress};
}
export type AccountSourceProjection=Awaited<ReturnType<typeof projectAccountSource>>;
