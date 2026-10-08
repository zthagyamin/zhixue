import type {PracticeMode as PluginType} from '../content';
import type {LocalStudyEventRecord} from './delivery-contracts';
import type {AssistanceSummaryV1} from './assistance-summary';
import type {AssistanceReceiptV1} from './assistance-record';
import type {StudyRecordEnvelope} from './account-record';
// @ts-expect-error TS5097: standalone Node source contracts.
import {studyObject,studyId,studyDigest,studyCount,studyText,studyIso,studySize,studyHash} from './validation.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {parseCloudStudyEventV3} from '../evidence/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {parseStudyRecord} from './account-record.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {parseAssistanceSummary,validateAssistanceParent} from './assistance-summary.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {sealAccountAssistance} from './assistance-record.ts';
export type NativeAttemptBindingV1={schemaVersion:1;eventId:string;coreHash:string;contentHash:string;localBindingHash:string;practiceMode:PluginType};

export type SubmissionRoute={kind:'account';record:StudyRecordEnvelope}|{kind:'local';binding:NativeAttemptBindingV1|null};

export type StudySubmissionV1={schemaVersion:1;workspaceId:string;eventId:string;core:LocalStudyEventRecord;route:SubmissionRoute;summary:AssistanceSummaryV1|null};

export type SummaryCloudAck={summaryId:string;summaryHash:string;associationHash:string;sequence:number};

export type SubmissionRow={workspaceId:string;eventId:string;payload:StudySubmissionV1;payloadHash:string;associationHash:string|null;revision:number;coreStored:boolean;
  cloudAck:SummaryCloudAck|null;writeback:{revision:number;receipt:AssistanceReceiptV1}|null;stateHash:string};

export function assertSubmissionWorkspace(workspaceId:string){studyId(workspaceId,'workspace');if(workspaceId!=='guest:local'&&(!workspaceId.startsWith('account:')||workspaceId.length<=8))throw new Error('invalid-submission-workspace');}

export function parseNativeAttemptBinding(raw:unknown):NativeAttemptBindingV1{
  const value=studyObject(raw,['schemaVersion','eventId','coreHash','contentHash','localBindingHash','practiceMode']);
  if(value.schemaVersion!==1)throw new Error('unsupported-native-binding-version');
  studyId(value.eventId,'event');for(const key of ['coreHash','contentHash','localBindingHash'])studyDigest(value[key]);
  if(!['three-stage','quiz','recall','calculation','code','flashcard','spelling'].some(mode=>mode===value.practiceMode))throw new Error('invalid-native-binding-mode');
  return structuredClone(value) as NativeAttemptBindingV1;
}

/** Original local context stays local, outside the summary and cloud envelope. */
export async function parseStudySubmission(raw:unknown):Promise<StudySubmissionV1>{
  studySize(raw,128*1024);const value=structuredClone(studyObject(raw,['schemaVersion','workspaceId','eventId','core','route','summary']));
  if(value.schemaVersion!==1)throw new Error('unsupported-submission-version');studyId(value.workspaceId,'workspace');assertSubmissionWorkspace(value.workspaceId);studyId(value.eventId,'event');
  const core=studyObject(value.core,['workspaceId','eventId','event','cloud','companion','occurredAt','updatedAt'],['localContext']);
  const event=await parseCloudStudyEventV3(core.event);
  if(event.eventType!=='practice-attempt'||core.workspaceId!==value.workspaceId||core.eventId!==value.eventId||event.eventId!==value.eventId||core.occurredAt!==event.occurredAt)throw new Error('submission-core-binding');
  for(const key of ['cloud','companion'])if(!['pending','not-required'].some(status=>status===core[key]))throw new Error('invalid-submission-initial-delivery');
  studyIso(core.updatedAt);
  if(core.localContext!==undefined){const context=studyObject(core.localContext,['title','activityType','durationMin','weakPoints'],['sourceNote','stateRef','abilityId']);
    studyText(context.title,'context-title',4000,true);studyText(context.activityType,'context-type',200);studyCount(context.durationMin,'context-duration');
    if(context.durationMin>1440||!Array.isArray(context.weakPoints)||context.weakPoints.length>100)throw new Error('invalid-submission-context');
    context.weakPoints.forEach(value=>studyText(value,'weak-point',4000,true));for(const key of ['sourceNote','stateRef','abilityId'])if(context[key]!==undefined)studyText(context[key],'context-reference',4000,true);
  }
  // Retain original diagnostic metadata; local hashes allow its finite decimals.
  // Portable envelopes still omit it without altering the immutable V3 core.
  core.event=event;
  const rawRoute=studyObject(value.route,['kind'],['record','binding']);let route:SubmissionRoute;
  const summary=value.summary===null?null:await parseAssistanceSummary(value.summary);
  if(summary&&(summary.attemptEventId!==event.eventId||summary.attemptCoreHash!==event.coreHash))throw new Error('submission-summary-binding');
  if(rawRoute.kind==='account'){
    studyObject(rawRoute,['kind','record']);if(!value.workspaceId.startsWith('account:')||core.companion!=='not-required'||core.cloud!=='pending')throw new Error('invalid-submission-account-route');
    const record=await parseStudyRecord(rawRoute.record);
    if(record.provenanceMode==='task'||record.event.eventId!==event.eventId||record.event.coreHash!==event.coreHash)throw new Error('submission-account-binding');
    if(summary)await validateAssistanceParent(summary,record.event,record.practiceMode);route={kind:'account',record};
  }else if(rawRoute.kind==='local'){
    studyObject(rawRoute,['kind','binding']);const binding=rawRoute.binding===null?null:parseNativeAttemptBinding(rawRoute.binding);
    if(binding&&(binding.eventId!==event.eventId||binding.coreHash!==event.coreHash))throw new Error('submission-native-binding');
    if(summary&&binding)await validateAssistanceParent(summary,event,binding.practiceMode);route={kind:'local',binding};
  }else throw new Error('invalid-submission-route');
  return{schemaVersion:1,workspaceId:value.workspaceId,eventId:value.eventId,core:core as LocalStudyEventRecord,route,summary};
}

export async function submissionAssociationHash(payload:StudySubmissionV1):Promise<string|null>{
  if(!payload.summary)return null;
  if(payload.route.kind==='account')return(await sealAccountAssistance(payload.route.record,payload.summary)).associationHash;
  return payload.route.binding?studyHash({schemaVersion:1,binding:payload.route.binding,summary:payload.summary}):null;
}

export type CorePersistenceState={mirror?:'pending'|'conflict'|'failed';localMetadataSaved?:boolean};
