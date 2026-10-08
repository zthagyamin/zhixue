// @ts-expect-error TS5097: standalone Node source contracts.
import {drainAccountRecords} from '../src/application/sync/index.ts';
import type {PluginType} from './plugin-routing';
import type {StudyBundle} from './account-study-content';
import type {StudyEventV3} from './study-event-v3';
import type {StudyRecordEnvelope} from './account-study-record';
import type {CloudTaskPlanV1} from './account-study-planning';
import type {DailyTask} from './task-plan-types';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {sealStudyRecord,parseStudyRecord,checkStudyRecordBinding} from './account-study-record.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {applyLocalStudyReceipt,getLocalStudyRecord,listLocalStudyItemRecords,listLocalStudyRecords,putLocalStudyRecord} from './local-account-study.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {compareEvidenceText} from './vocabulary-learning.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {hashTaskEvent} from './task-event-v1.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {studyHash} from './account-study-content.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {getLocalStudyEvent,isStudyStorageFailure} from './local-study-events.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {studyDay} from './vocabulary-learning.ts';
// @ts-expect-error TS5097: Node contract tests use explicit TypeScript extensions.
import {parseCloudStudyEventV3} from './study-event-v3.ts';

export type AccountRecordPreparationInput={workspaceId:string;bundle:StudyBundle;event:StudyEventV3;originDeviceId:string;practiceMode:PluginType;pendingRecords?:StudyRecordEnvelope[];
  legacyResume?:{stage:1|2;anchorEventId:string|null;anchorCoreHash:string|null}};
export async function prepareAccountStudyRecord(raw:AccountRecordPreparationInput):Promise<StudyRecordEnvelope>{
  // Capture only the displayed item and immutable snapshot header, not the full
  // question bank. Never consult a newer page's mode/source after an await.
  const input={...raw,event:structuredClone(raw.event),bundle:{snapshot:{...raw.bundle.snapshot},items:raw.bundle.items.filter(item=>item.itemKey===raw.event.item.key).map(item=>structuredClone(item))},
    legacyResume:structuredClone(raw.legacyResume),pendingRecords:structuredClone(raw.pendingRecords??[])};
  const event=await parseCloudStudyEventV3(input.event);if(event.eventType!=='practice-attempt')throw new Error('account-attempt-required');
  const item=input.bundle.items.find(item=>item.itemKey===event.item.key);if(!item)throw new Error('account-content-membership');
  const pending=new Map<string,StudyRecordEnvelope>();
  for(const raw of input.pendingRecords){const record=await parseStudyRecord(raw);if(record.libraryId!==input.bundle.snapshot.libraryId)continue;
    const prior=pending.get(record.event.eventId);if(prior&&prior.envelopeHash!==record.envelopeHash)throw new Error('account-event-conflict');pending.set(record.event.eventId,record);}
  const existing=await getLocalStudyRecord(input.workspaceId,input.bundle.snapshot.libraryId,event.eventId);
  const journaled=pending.get(event.eventId);
  if(existing&&journaled&&existing.record.envelopeHash!==journaled.envelopeHash)throw new Error('account-event-conflict');
  const prior=existing?.record??journaled;
  if(prior){
    if(prior.event.coreHash!==event.coreHash)throw new Error('account-event-conflict');
    if(prior.provenanceMode==='task'||prior.snapshotId!==input.bundle.snapshot.snapshotId||prior.contentHash!==item.contentHash||prior.practiceMode!==input.practiceMode||prior.originDeviceId!==input.originDeviceId)throw new Error('account-event-source-binding');
    return prior;
  }
  const rows=await listLocalStudyItemRecords(input.workspaceId,input.bundle.snapshot.libraryId,event.item.key);
  const records=new Map(rows.map(row=>[row.record.event.eventId,row.record]));
  for(const record of pending.values()){
    const prior=records.get(record.event.eventId);if(prior&&prior.envelopeHash!==record.envelopeHash)throw new Error('account-event-conflict');records.set(record.event.eventId,record);}
  const candidates=[...records.values()].filter((record):record is Exclude<StudyRecordEnvelope,{provenanceMode:'task'}>=>record.provenanceMode!=='task'
    &&record.snapshotId===input.bundle.snapshot.snapshotId&&record.contentHash===item.contentHash&&record.originDeviceId===input.originDeviceId&&record.practiceMode===input.practiceMode
    &&record.event.item.key===item.itemKey);
  let roundId=crypto.randomUUID(),parentEventId:string|null=null,legacy:Extract<StudyRecordEnvelope,{provenanceMode:'legacy-continuation'}>|null=null;
  if(input.practiceMode==='three-stage'&&event.attempt.stageBefore>0){
    const parents=candidates.filter(record=>record.event.attempt.stageAfter===event.attempt.stageBefore&&!candidates.some(child=>child.parentEventId===record.event.eventId))
      .sort((a,b)=>compareEvidenceText(b.event.occurredAt,a.event.occurredAt)||compareEvidenceText(b.event.eventId,a.event.eventId));
    if(parents.length===1){parentEventId=parents[0].event.eventId;if(parents[0].provenanceMode==='verified-round')roundId=parents[0].roundId;else legacy=parents[0];}
    else if(input.legacyResume?.stage===event.attempt.stageBefore){const resumeId=`resume:${await studyHash([input.originDeviceId,item.itemKey,item.contentHash,input.legacyResume.stage,input.legacyResume.anchorEventId,input.legacyResume.anchorCoreHash])}`;
      legacy={schemaVersion:1,libraryId:input.bundle.snapshot.libraryId,snapshotId:input.bundle.snapshot.snapshotId,contentHash:item.contentHash,originDeviceId:input.originDeviceId,
        provenanceMode:'legacy-continuation',practiceMode:'three-stage',resumeId,resumeStateHash:await studyHash([resumeId,input.legacyResume]),legacyStage:input.legacyResume.stage,
        legacyAnchorEventId:input.legacyResume.anchorEventId,attemptId:'placeholder',parentEventId:null,event,envelopeHash:'placeholder'};
    }else throw new Error('account-legacy-resume-required');
  }
  const common={schemaVersion:1,libraryId:input.bundle.snapshot.libraryId,snapshotId:input.bundle.snapshot.snapshotId,
    contentHash:item.contentHash,originDeviceId:input.originDeviceId,practiceMode:input.practiceMode,attemptId:crypto.randomUUID(),parentEventId,event};
  const record=await sealStudyRecord(legacy?{...common,provenanceMode:'legacy-continuation',resumeId:legacy.resumeId,resumeStateHash:legacy.resumeStateHash,
    legacyStage:legacy.legacyStage,legacyAnchorEventId:legacy.legacyAnchorEventId}:{...common,provenanceMode:'verified-round',roundId});
  if(checkStudyRecordBinding(record,item,candidates)==='pending-parent')throw new Error('account-legacy-resume-required');
  return record;
}
export async function ensureAccountStudyRecord(input:AccountRecordPreparationInput):Promise<StudyRecordEnvelope>{
  const workspaceId=input.workspaceId,record=await prepareAccountStudyRecord(input);await putLocalStudyRecord(workspaceId,record);return record;
}
export async function flushAccountStudyRecords(workspaceId:string,libraryId:string,send:(records:StudyRecordEnvelope[])=>Promise<{results:Array<{eventId:string;durable:boolean;receipt?:unknown}>}>):Promise<void>{
  return drainAccountRecords(workspaceId,libraryId,{list:listLocalStudyRecords,mirror:getLocalStudyEvent,storageFailure:isStudyStorageFailure,send,receipt:applyLocalStudyReceipt});
}
export async function createAccountTaskRecord(input:{workspaceId:string;bundle:StudyBundle;plan:CloudTaskPlanV1;task:DailyTask;originDeviceId:string}):Promise<StudyRecordEnvelope>{
  if(input.task.completionRule!=='self-report'||input.task.required&&input.task.completionRule.startsWith('formal-'))throw new Error('account-task-evidence-required');
  const occurredAt=new Date().toISOString(),day=studyDay(occurredAt);if(input.plan.day!==day)throw new Error('今日日期已变化，请刷新计划后重新标记；未新增完成记录。');
  const eventId=crypto.randomUUID(),body={schemaVersion:1 as const,eventType:'task-completed' as const,eventId,taskId:input.task.taskId,
    subjectId:input.task.subjectId,day,occurredAt,unitIds:input.task.unitIds,source:'self-report' as const,evidenceRefs:[] as string[]};
  const event={...body,coreHash:await hashTaskEvent(body)},record=await sealStudyRecord({schemaVersion:1,libraryId:input.bundle.snapshot.libraryId,snapshotId:input.bundle.snapshot.snapshotId,
    originDeviceId:input.originDeviceId,provenanceMode:'task',planHash:input.plan.cloudPlanHash,assignmentId:input.task.taskId,
    completionKey:`completion:${await studyHash([input.plan.cloudPlanHash,input.task.taskId,input.task.unitIds,day])}`,event});
  await putLocalStudyRecord(input.workspaceId,record);return record;
}
