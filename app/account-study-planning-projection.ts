// @ts-expect-error TS5097: standalone Node contracts.
import {acceptsRecordedStudyDay} from '../src/domain/planning/index.ts';
import type {CloudPlanningCatalogV1,CloudPlanningFactsV1,CloudTaskPlanV1} from './account-study-planning';
import type {StudyBundle,StudyItemVersion} from './account-study-content';
import type {StudyRecordEnvelope} from './account-study-record';
import type {TaskPlanV2} from './task-plan-types';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {parseCloudPlanningCatalog,parseCloudPlanningFacts,toEnginePlanningCatalog,toEngineTaskPlan} from './account-study-planning.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {studyCount,studyHash,studyObject,validateStudyBundle} from './account-study-content.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {checkStudyRecordBinding,compareStudyRecord,parseStudyRecord} from './account-study-record.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {buildDailyPlanningInput} from './task-planning-input.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {studyDay} from './vocabulary-learning.ts';

export type StoredAccountRecord={sequence:number;record:StudyRecordEnvelope};
type Input={day:string;catalog:CloudPlanningCatalogV1;facts:CloudPlanningFactsV1;bundle:StudyBundle;records:StoredAccountRecord[];
  bundles?:StudyBundle[];eventThrough:number;taskThrough:number;previous:TaskPlanV2|null;optionalMinutes?:number;localPracticeRecords?:StudyRecordEnvelope[]};

function roundKey(record:StudyRecordEnvelope):string {
  if(record.provenanceMode==='task') return `task:${record.event.eventId}`;
  const identity=record.provenanceMode==='verified-round'?record.roundId:record.resumeId;
  return [record.libraryId,record.originDeviceId,record.provenanceMode,identity].join('\u0000');
}
function subjectFor(item:StudyItemVersion,catalog:Awaited<ReturnType<typeof toEnginePlanningCatalog>>):string {
  const subject=catalog.subjects.find(subject=>subject.subjectId===item.subjectId);
  if(!subject) throw new Error('account-planning-content-subject');return subject.subjectId;
}
export async function composeAccountPlanningInput(raw:Input):Promise<Awaited<ReturnType<typeof buildDailyPlanningInput>>>{
  const localPractice=structuredClone(raw.localPracticeRecords??[]);
  const catalogWire=await parseCloudPlanningCatalog(raw.catalog),facts=await parseCloudPlanningFacts(raw.facts),bundle=await validateStudyBundle(raw.bundle),bundles=await Promise.all((raw.bundles??[raw.bundle]).map(validateStudyBundle)),bySnapshot=new Map(bundles.map(value=>[value.snapshot.snapshotId,value]));
  if(catalogWire.libraryId!==bundle.snapshot.libraryId||catalogWire.snapshotId!==bundle.snapshot.snapshotId||facts.libraryId!==catalogWire.libraryId
    ||facts.snapshotId!==catalogWire.snapshotId||facts.catalogHash!==catalogWire.catalogHash) throw new Error('account-planning-facts-binding');
  studyCount(raw.eventThrough,'event-through');studyCount(raw.taskThrough,'task-through');
  // Practice and task envelopes share one immutable sequence. A task fence below
  // the event fence would silently omit already-observed task completions.
  if(raw.taskThrough!==raw.eventThrough) throw new Error('account-planning-fence');
  if(!bySnapshot.has(bundle.snapshot.snapshotId)||bundles.some(value=>value.snapshot.libraryId!==catalogWire.libraryId))throw new Error('account-planning-history-binding');
  const unique=new Map<string,{sequence:number;record:StudyRecordEnvelope}>();
  let previous=0;
  for(const stored of raw.records) {
    const value=studyObject(stored,['sequence','record']);studyCount(value.sequence,'record-sequence',1);
    if((value.sequence as number)<=previous||(value.sequence as number)>raw.eventThrough) throw new Error('account-planning-fence');previous=value.sequence as number;
    const record=await parseStudyRecord(value.record);if(record.libraryId!==catalogWire.libraryId||!bySnapshot.has(record.snapshotId))throw new Error('account-planning-record-binding');
    const old=unique.get(record.event.eventId);
    if(old&&compareStudyRecord(old.record,record)!=='duplicate') throw new Error('account-planning-event-conflict');
    unique.set(record.event.eventId,{sequence:value.sequence as number,record});
  }
  if((raw.eventThrough===0)!==(raw.records.length===0)||(raw.eventThrough!==0&&previous!==raw.eventThrough)) throw new Error('account-planning-fence');
  // Local durability is a separate input, never a fabricated remote sequence.
  // The remote fence above must still be complete. Shared-plan mutations use
  // remote-only composition until these records are received by the account.
  const combined=new Map([...unique.values()].map(row=>[row.record.event.eventId,row.record]));
  for(const raw of localPractice){const record=await parseStudyRecord(raw);
    if(record.provenanceMode==='task')throw new Error('account-local-practice-required');
    if(record.libraryId!==catalogWire.libraryId||!bySnapshot.has(record.snapshotId))throw new Error('account-planning-record-binding');
    const prior=combined.get(record.event.eventId);if(prior&&compareStudyRecord(prior,record)!=='duplicate')throw new Error('account-planning-event-conflict');combined.set(record.event.eventId,record);
  }
  const records=[...combined.values()],taskRecords=records.filter((record):record is Extract<StudyRecordEnvelope,{provenanceMode:'task'}>=>record.provenanceMode==='task'),practiceRecords=records.filter((record):record is Exclude<StudyRecordEnvelope,{provenanceMode:'task'}>=>record.provenanceMode!=='task'),
    groups=new Map<string,Exclude<StudyRecordEnvelope,{provenanceMode:'task'}>[]>();
  for(const record of practiceRecords) groups.set(roundKey(record),[...(groups.get(roundKey(record))??[]),record]);
  const accepted:Exclude<StudyRecordEnvelope,{provenanceMode:'task'}>[]=[];
  for(const group of groups.values()) {
    for(const record of group) {
      const item=bySnapshot.get(record.snapshotId)!.items.find(item=>item.itemKey===record.event.item.key&&item.contentHash===record.contentHash);if(!item) throw new Error('account-planning-content-membership');
      try {if(checkStudyRecordBinding(record,item,group)!=='ready') throw new Error('ancestry');}
      catch(error){const message=error instanceof Error?error.message:'';throw new Error(message.includes('fork')?'account-planning-round-fork':'account-planning-history-ancestry');}
    }
    accepted.push(...group);
  }
  const catalog=await toEnginePlanningCatalog(catalogWire),companionRecords=(await Promise.all(accepted.map(async record=>{
    const item=bySnapshot.get(record.snapshotId)!.items.find(item=>item.itemKey===record.event.item.key&&item.contentHash===record.contentHash)!;
    if(!catalog.subjects.some(subject=>subject.subjectId===item.subjectId))return null;let planningEvidence;
    if(item.kind==='word'){const word={itemKey:item.itemKey,subjectId:item.subjectId,word:item.word.word,language:item.language,sourceHash:item.sourceHash,completionRule:item.completionRule},body={schemaVersion:1 as const,eventId:record.event.eventId,coreHash:record.event.coreHash,word};planningEvidence={...body,evidenceHash:await studyHash(body)};}
    return {event:record.event,subjectId:subjectFor(item,catalog),...(planningEvidence?{planningEvidence}:{})};
  }))).filter((value):value is NonNullable<typeof value>=>value!==null);
  const context={catalog,sourceReviews:facts.sourceReviews,captureReviews:facts.captureReviews,observedAt:facts.observedAt,
    planRevision:facts.nativePlanRevision,capabilities:['task-planning-v1']};
  return buildDailyPlanningInput({day:raw.day,context,localEvents:facts.legacyEvents,companionRecords,taskEvents:[...facts.legacyTaskEvents,...taskRecords.map(record=>record.event)],
    history:{local:facts.historyComplete?'complete':'failed',cloud:'not-applicable',companion:'complete',tasks:'complete'},legacyItemKeys:[],previous:raw.previous,
    ...(raw.optionalMinutes===undefined?{}:{optionalMinutes:raw.optionalMinutes})});
}

async function readAccountTaskActivity(plan:CloudTaskPlanV1,catalog:CloudPlanningCatalogV1,bundlesRaw:StudyBundle[],stored:StoredAccountRecord[],localRecords:StudyRecordEnvelope[]=[]):Promise<{completedTaskIds:string[];startedTaskIds:string[];pendingItemByTask:Record<string,string>;itemProgressByTask:Record<string,{completed:number;total:number}>;completedItemKeysByTask:Record<string,string[]>}>{
  const engine=await toEngineTaskPlan(plan,catalog),bundles=await Promise.all(bundlesRaw.map(validateStudyBundle)),bySnapshot=new Map(bundles.map(value=>[value.snapshot.snapshotId,value])),unique=new Map<string,StudyRecordEnvelope>();
  for(const raw of [...stored.map(row=>row.record),...localRecords]){const record=await parseStudyRecord(raw),prior=unique.get(record.event.eventId);if(record.libraryId!==catalog.libraryId||bySnapshot.get(record.snapshotId)?.snapshot.libraryId!==catalog.libraryId)throw new Error('account-task-history-binding');if(prior&&compareStudyRecord(prior,record)!=='duplicate')throw new Error('account-task-history-conflict');unique.set(record.event.eventId,record);}
  const records=[...unique.values()],taskIds=new Set<string>(),groups=new Map<string,Exclude<StudyRecordEnvelope,{provenanceMode:'task'}>[]>();
  for(const record of records)if(record.provenanceMode==='task'&&record.planHash===plan.cloudPlanHash&&record.event.day===plan.day){
    const event=record.event,task=engine.tasks.find(task=>task.taskId===event.taskId);
    if(!task||task.completionRule!=='self-report'||record.assignmentId!==task.taskId||record.snapshotId!==catalog.snapshotId||event.subjectId!==task.subjectId||JSON.stringify(event.unitIds)!==JSON.stringify(task.unitIds)||event.source!=='self-report'||event.evidenceRefs.length||!acceptsRecordedStudyDay(event.occurredAt,plan.day)||record.completionKey!==`completion:${await studyHash([plan.cloudPlanHash,task.taskId,task.unitIds,event.day])}`)throw new Error('account-task-history-binding');
    taskIds.add(task.taskId);
  }
  for(const record of records)if(record.provenanceMode!=='task')groups.set(roundKey(record),[...(groups.get(roundKey(record))??[]),record]);const completedKeys=new Set<string>(),startedKeys=new Set<string>();
  for(const group of groups.values()){try{for(const record of group){const item=bySnapshot.get(record.snapshotId)?.items.find(value=>value.itemKey===record.event.item.key&&value.contentHash===record.contentHash);if(!item||checkStudyRecordBinding(record,item,group)!=='ready')throw new Error('incomplete');}for(const record of group)if(studyDay(record.event.occurredAt)===plan.day){const key=`${record.event.item.key}\u0000${record.contentHash}`;startedKeys.add(key);if(record.event.attempt.correct&&record.event.attempt.stageAfter===3)completedKeys.add(key);}}catch{/* Conflicting/incomplete raw evidence never checks a task. */}}
  for(const task of engine.tasks){if(task.completionRule==='self-report'&&taskIds.has(task.taskId))continue;if(task.action.kind==='practice'&&task.action.itemKeys.length&&task.action.itemKeys.every(key=>Boolean(catalog.contentRefs[key])&&completedKeys.has(`${key}\u0000${catalog.contentRefs[key]}`)))taskIds.add(task.taskId);}
  const startedTaskIds:string[]=[],pendingItemByTask:Record<string,string>={};
  for(const task of engine.tasks)if(task.action.kind==='practice'&&!taskIds.has(task.taskId)){
    if(task.action.itemKeys.some(key=>Boolean(catalog.contentRefs[key])&&startedKeys.has(`${key}\u0000${catalog.contentRefs[key]}`)))startedTaskIds.push(task.taskId);
    const pending=task.action.itemKeys.find(key=>Boolean(catalog.contentRefs[key])&&!completedKeys.has(`${key}\u0000${catalog.contentRefs[key]}`));if(pending)pendingItemByTask[task.taskId]=pending;
  }
  const itemProgressByTask:Record<string,{completed:number;total:number}>={};
  for(const task of engine.tasks)if(task.action.kind==='practice'){
    const keys=[...new Set(task.action.itemKeys)];
    itemProgressByTask[task.taskId]={total:keys.length,completed:keys.filter(key=>Boolean(catalog.contentRefs[key])&&completedKeys.has(`${key}\u0000${catalog.contentRefs[key]}`)).length};
  }
  const completedItemKeysByTask:Record<string,string[]>={};
  for(const task of engine.tasks)if(task.action.kind==='practice')completedItemKeysByTask[task.taskId]=task.action.itemKeys.filter(key=>Boolean(catalog.contentRefs[key])&&completedKeys.has(`${key}\u0000${catalog.contentRefs[key]}`));
  return {completedTaskIds:[...taskIds],startedTaskIds,pendingItemByTask,itemProgressByTask,completedItemKeysByTask};
}

export async function accountTaskActivity(...args:Parameters<typeof readAccountTaskActivity>){
 const full=await readAccountTaskActivity(...args);
 return {completedTaskIds:full.completedTaskIds,startedTaskIds:full.startedTaskIds,pendingItemByTask:full.pendingItemByTask,itemProgressByTask:full.itemProgressByTask};
}
export async function accountTaskCompletedItems(...args:Parameters<typeof readAccountTaskActivity>){return (await readAccountTaskActivity(...args)).completedItemKeysByTask;}
export async function accountCompletedTaskIds(plan:CloudTaskPlanV1,catalog:CloudPlanningCatalogV1,bundlesRaw:StudyBundle[],stored:StoredAccountRecord[]):Promise<string[]>{
  return (await accountTaskActivity(plan,catalog,bundlesRaw,stored)).completedTaskIds;
}
