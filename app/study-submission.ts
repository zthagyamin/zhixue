import type {LocalStudyEventRecord} from './local-study-events';
import type {StudyBundle} from './account-study-content';
import type {PluginType} from './plugin-routing';
import type {AssistanceObservation} from './assistance-summary';
import type {StudySubmissionV1,SubmissionJournal,SubmissionRoute,CorePersistenceState} from './study-submission-journal';
// @ts-expect-error TS5097: standalone Node contracts.
import {prepareAccountStudyRecord} from './account-study-record-client.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {sealAssistanceSummary} from './assistance-summary.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseNativeAttemptBinding,parseStudySubmission} from './study-submission-journal.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {putLocalStudyEvent,getLocalStudyEvent,isStudyStorageFailure} from './local-study-events.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {putLocalStudyRecord} from './local-account-study.ts';

export type StudySubmissionFrame={kind:'account';practiceMode:PluginType;bundle:StudyBundle;originDeviceId:string;
  legacyResume?:{stage:1|2;anchorEventId:string|null;anchorCoreHash:string|null}}
  |{kind:'local';practiceMode:PluginType;contentHash?:string;localBindingHash?:string};
/** Capture this at the accepted UI submission boundary, before creating/hashing
 * the core. A later tab, source refresh or mode choice cannot alter the frame. */
export function captureSubmissionFrame(frame:StudySubmissionFrame):StudySubmissionFrame{return structuredClone(frame);}
export async function prepareStudySubmission(rawCore:LocalStudyEventRecord,rawFrame:StudySubmissionFrame,rawObservation:AssistanceObservation|null,
  journal:Pick<SubmissionJournal,'relatedAccountRecords'>):Promise<StudySubmissionV1>{
  const core=structuredClone(rawCore),frame=captureSubmissionFrame(rawFrame),observation=structuredClone(rawObservation);
  if(core.event.eventType!=='practice-attempt')throw new Error('submission-requires-attempt');
  let route:SubmissionRoute;
  if(frame.kind==='account'){
    let pendingRecords:Awaited<ReturnType<SubmissionJournal['relatedAccountRecords']>>=[];
    try{pendingRecords=await journal.relatedAccountRecords(core.workspaceId,frame.bundle.snapshot.libraryId,core.event.item.key);}
    catch(error){if(error instanceof Error&&/conflict|integrity|binding|^invalid-/.test(error.message))throw error;}
    const record=await prepareAccountStudyRecord({workspaceId:core.workspaceId,bundle:frame.bundle,event:core.event,originDeviceId:frame.originDeviceId,practiceMode:frame.practiceMode,legacyResume:frame.legacyResume,pendingRecords});
    route={kind:'account',record};
  }else{
    const binding=frame.contentHash&&frame.localBindingHash?parseNativeAttemptBinding({schemaVersion:1,eventId:core.eventId,coreHash:core.event.coreHash,contentHash:frame.contentHash,localBindingHash:frame.localBindingHash,practiceMode:frame.practiceMode}):null;
    route={kind:'local',binding};
  }
  const summary=observation?await sealAssistanceSummary({schemaVersion:observation.recallPolicy?2:1,attemptEventId:core.eventId,attemptCoreHash:core.event.coreHash,practiceMode:frame.practiceMode,...observation}):null;
  return parseStudySubmission({schemaVersion:1,workspaceId:core.workspaceId,eventId:core.eventId,core,route,summary});
}
/** Original stores are idempotent dispatch destinations of the durable journal.
 * Retain their original core/diagnostic metadata and independent delivery flags. */
export async function persistOriginalSubmission(payload:StudySubmissionV1):Promise<CorePersistenceState>{
  if(payload.route.kind==='local'){
    const outcome=await putLocalStudyEvent(payload.core);if(outcome==='conflict')throw new Error('study-event-conflict');return{};
  }
  // A portable account envelope already contains the complete immutable V3 core
  // and source association. Store it before its redundant legacy V3 mirror.
  let mirrorConflict=false;
  try{const old=await getLocalStudyEvent(payload.workspaceId,payload.eventId);if(old&&old.event.coreHash!==payload.core.event.coreHash)throw new Error('study-event-conflict');mirrorConflict=old?.cloud==='conflict';}
  catch(error){if(!isStudyStorageFailure(error))throw error;}
  await putLocalStudyRecord(payload.workspaceId,payload.route.record);
  if(mirrorConflict)return{mirror:'conflict',localMetadataSaved:false};
  try{const outcome=await putLocalStudyEvent(payload.core);return outcome==='conflict'?{mirror:'conflict',localMetadataSaved:false}:{};}
  catch(error){return{mirror:isStudyStorageFailure(error)?'pending':error instanceof Error&&/conflict|integrity|binding|^invalid-|冲突/i.test(error.message)?'conflict':'failed',localMetadataSaved:false};}
}
