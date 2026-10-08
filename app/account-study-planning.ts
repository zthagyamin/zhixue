import type {CloudAction,CloudUnit,CloudSubject,CloudCatalogBody,CloudPlanningCatalogV1,LocalPlanningMaterials,PlanningFactsBody,CloudPlanningFactsV1,CloudTask,CloudPlanBody,CloudTaskPlanV1} from '../src/domain/planning';
export type {CloudPlanningCatalogV1,LocalPlanningMaterial,LocalPlanningMaterials,CloudPlanningFactsV1,CloudTaskPlanV1} from '../src/domain/planning';
import type {DailyTask,LearningUnit,PlanningCatalog,PlanningSubject,TaskAction,TaskPlanV2} from './task-plan-types';
import type {StudyBundle} from './account-study-content';
import type {CurrentSourceReview,TimedReviewDemand} from './task-plan-types';
import type {StudyEventV3} from './study-event-v3';
import type {TaskEventV1} from './task-plan-types';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {studyCount,studyDigest,studyHash,studyId,studyObject,studySize,studyText} from './account-study-content.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {parseDailyTask,parseTaskPlan,parseWordSnapshot,validPlanDay} from './task-plan-types.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {hashTaskPlan} from './task-plan-engine.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {taskSourceHash} from './task-plan-edit.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {parseCloudStudyEventV3} from './study-event-v3.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {validateTaskEvent} from './task-event-v1.ts';














function textList(value:unknown,label:string):string[] {
  if(!Array.isArray(value)) throw new Error(`invalid-${label}`);
  value.forEach(child=>studyText(child,label));if(new Set(value).size!==value.length) throw new Error(`duplicate-${label}`);
  return value as string[];
}
function cloudAction(value:unknown):CloudAction {
  if(!value||typeof value!=='object'||Array.isArray(value)) throw new Error('invalid-cloud-action');
  const kind=(value as {kind?:unknown}).kind;
  if(kind==='practice') {const v=studyObject(value,['kind','itemKeys']);textList(v.itemKeys,'item-keys');if(!(v.itemKeys as unknown[]).length) throw new Error('invalid-item-keys');return structuredClone(v) as CloudAction;}
  if(kind==='open-material'){const v=studyObject(value,['kind','materialId']);studyId(v.materialId,'material');return structuredClone(v) as CloudAction;}
  if(kind==='manual'){studyObject(value,['kind']);return {kind};}
  throw new Error('invalid-cloud-action');
}
function validateCloudUnit(raw:unknown):CloudUnit {
  const value=studyObject(raw,['unitId','subjectId','title','order','sourceHash','prerequisites','action','completionRule','formalComplete'],
    ['estimatedMinutes','stateHandle','abilityId','planningLabel','taskComplete']);
  for(const key of ['unitId','subjectId']) studyId(value[key],key);studyText(value.title,'unit-title');studyDigest(value.sourceHash);
  studyCount(value.order,'unit-order');textList(value.prerequisites,'prerequisites');cloudAction(value.action);
  if(typeof value.formalComplete!=='boolean') throw new Error('invalid-formal-complete');
  if(!['three-stage','graded-practice','self-report','formal-mastered','formal-done','formal-completed-reference'].includes(String(value.completionRule))) throw new Error('invalid-completion-rule');
  if(value.estimatedMinutes!==undefined) studyCount(value.estimatedMinutes,'estimated-minutes');
  for(const key of ['stateHandle','abilityId','planningLabel']) if(value[key]!==undefined) studyText(value[key],key);
  if(value.taskComplete!==undefined&&typeof value.taskComplete!=='boolean') throw new Error('invalid-task-complete');
  return structuredClone(value) as CloudUnit;
}
function validateGoal(raw:unknown):PlanningSubject['goals'][number] {
  const value=studyObject(raw,['goalId','subjectId','title','kind','targetCount','unitIds','startOn','priority','required','completionBasis'],['dueOn']);
  for(const key of ['goalId','subjectId']) studyId(value[key],key);studyText(value.title,'goal-title');studyCount(value.targetCount,'target-count',1);studyCount(value.priority,'priority',1);
  if((value.priority as number)>5||!['daily','weekly','deadline'].includes(String(value.kind))||!validPlanDay(value.startOn)||(value.dueOn!==undefined&&!validPlanDay(value.dueOn))) throw new Error('invalid-cloud-goal');
  textList(value.unitIds,'unit-ids');if(typeof value.required!=='boolean'||!['practice-round','self-report','formal-state'].includes(String(value.completionBasis))) throw new Error('invalid-cloud-goal');
  return structuredClone(value) as PlanningSubject['goals'][number];
}
function validateCatalogBody(raw:unknown,hasHash:boolean):CloudCatalogBody {
  const value=studyObject(raw,['schemaVersion','libraryId','snapshotId','sourceHash','subjects','practiceSources','diagnostics','contentRefs'],hasHash?['catalogHash']:[]);
  if(value.schemaVersion!==1) throw new Error('unsupported-cloud-catalog-version');studyId(value.libraryId,'library');studyId(value.snapshotId,'snapshot');studyDigest(value.sourceHash);
  if(hasHash) studyDigest(value.catalogHash);
  if(!Array.isArray(value.subjects)||!Array.isArray(value.practiceSources)||!Array.isArray(value.diagnostics)) throw new Error('invalid-cloud-catalog');
  const subjects=(value.subjects as unknown[]).map(rawSubject=>{
    const subject=studyObject(rawSubject,['subjectId','name','priority','words','units','goals'],['lastProgressAt','planningStatus']);
    studyId(subject.subjectId,'subject');studyText(subject.name,'subject-name');studyCount(subject.priority,'priority',1);if((subject.priority as number)>5) throw new Error('invalid-priority');
    if(!Array.isArray(subject.words)||!Array.isArray(subject.units)||!Array.isArray(subject.goals)) throw new Error('invalid-cloud-subject');
    const words=subject.words.map(parseWordSnapshot),units=subject.units.map(validateCloudUnit),goals=subject.goals.map(validateGoal);
    if(subject.lastProgressAt!==undefined) studyText(subject.lastProgressAt,'last-progress');
    if(subject.planningStatus!==undefined&&!['none','ready','invalid'].includes(String(subject.planningStatus))) throw new Error('invalid-planning-status');
    return {...structuredClone(subject),words,units,goals} as CloudSubject;
  });
  const practiceSources=(value.practiceSources as unknown[]).map(rawSource=>{
    const source=studyObject(rawSource,['itemKey','subjectId','title','sourceHash','completionRule']);
    studyId(source.itemKey,'item');studyId(source.subjectId,'subject');studyText(source.title,'practice-title');studyDigest(source.sourceHash);
    if(!['three-stage','graded-practice','self-report','formal-mastered','formal-done','formal-completed-reference'].includes(String(source.completionRule))) throw new Error('invalid-completion-rule');
    return structuredClone(source) as NonNullable<PlanningCatalog['practiceSources']>[number];
  });
  const diagnostics=(value.diagnostics as unknown[]).map(rawDiagnostic=>{const d=studyObject(rawDiagnostic,['code'],['subjectId']);studyText(d.code,'diagnostic-code',200);if(d.subjectId!==undefined)studyId(d.subjectId,'subject');return structuredClone(d) as {code:string;subjectId?:string};});
  if(!value.contentRefs||typeof value.contentRefs!=='object'||Array.isArray(value.contentRefs)) throw new Error('invalid-content-refs');
  const contentRefs:Record<string,string>={};for(const [key,digest] of Object.entries(value.contentRefs as Record<string,unknown>)){studyId(key,'item');studyDigest(digest);contentRefs[key]=digest as string;}
  const ids=subjects.map(s=>s.subjectId);if(new Set(ids).size!==ids.length) throw new Error('duplicate-cloud-subject');
  studySize(value,2*1024*1024);
  return {schemaVersion:1,libraryId:value.libraryId as string,snapshotId:value.snapshotId as string,sourceHash:value.sourceHash as string,subjects,practiceSources,diagnostics,contentRefs};
}
export async function parseCloudPlanningCatalog(raw:unknown):Promise<CloudPlanningCatalogV1> {
  const body=validateCatalogBody(raw,true),catalogHash=(raw as CloudPlanningCatalogV1).catalogHash;
  if(await studyHash(body)!==catalogHash) throw new Error('cloud-catalog-integrity');return {...body,catalogHash};
}
export async function toCloudPlanningCatalog(native:PlanningCatalog,bundle:StudyBundle):Promise<{catalog:CloudPlanningCatalogV1;materials:LocalPlanningMaterials}> {
  const refs=new Map(bundle.items.map(item=>[item.itemKey,item.contentHash]));
  const materials:LocalPlanningMaterials={},subjects:CloudSubject[]=[];
  for(const subject of native.subjects) {
    const words=subject.words.map(word=>{
    const content=refs.get(word.itemKey);if(!content) throw new Error('planning-content-membership');return {...word,sourceHash:content};}),
      units:CloudUnit[]=[];
    for(const unit of subject.units) {
      if(unit.action.kind==='open-note') {
        const materialId=`material:${await studyHash([unit.unitId,unit.sourceHash,'material'])}`;
        materials[materialId]={materialId,subjectId:unit.subjectId,unitId:unit.unitId,contentRef:unit.action.contentRef,sourceHash:unit.sourceHash,
          ...(unit.stateRef===undefined?{}:{stateRef:unit.stateRef}),...(unit.abilityId===undefined?{}:{abilityId:unit.abilityId})};
        const nativeCopy=structuredClone(unit);delete nativeCopy.stateRef;
        const copy={...nativeCopy,action:{kind:'open-material' as const,materialId}};
        if(unit.stateRef!==undefined) (copy as CloudUnit).stateHandle=`state:${await studyHash([unit.unitId,unit.sourceHash,unit.stateRef,unit.abilityId??''])}`;
        units.push(copy as CloudUnit);continue;
      }
      if(unit.action.kind==='practice'&&unit.action.itemKeys.some(key=>!refs.has(key))) throw new Error('planning-content-membership');
      const nativeCopy=structuredClone(unit);delete nativeCopy.stateRef;
      const copy={...nativeCopy,action:structuredClone(unit.action) as CloudAction};units.push(copy as CloudUnit);
    }
    subjects.push({...structuredClone(subject),words,units});
  }
  const practiceSources=(native.practiceSources??[]).map(source=>{const content=refs.get(source.itemKey);if(!content) throw new Error('planning-content-membership');return {...source,sourceHash:content};});
  const contentRefs=Object.fromEntries([...refs]);
  const partial={schemaVersion:1 as const,libraryId:bundle.snapshot.libraryId,snapshotId:bundle.snapshot.snapshotId,subjects,practiceSources,
    diagnostics:native.diagnostics.map(d=>({code:d.code,...(d.subjectId?{subjectId:d.subjectId}:{})})),contentRefs};
  const sourceHash=await studyHash({subjects,practiceSources,diagnostics:partial.diagnostics,contentRefs}),body={...partial,sourceHash};
  const normalized=validateCatalogBody(body,false);return {catalog:{...normalized,catalogHash:await studyHash(normalized)},materials};
}
export async function toEnginePlanningCatalog(raw:unknown):Promise<PlanningCatalog> {
  const cloud=await parseCloudPlanningCatalog(raw);
  return {schemaVersion:1,sourceHash:cloud.sourceHash,subjects:cloud.subjects.map(subject=>({...structuredClone(subject),units:subject.units.map(unit=>{
    const copy={...structuredClone(unit),action:unit.action.kind==='open-material'?{kind:'open-note' as const,contentRef:unit.action.materialId}:structuredClone(unit.action) as TaskAction};delete (copy as Partial<CloudUnit>).stateHandle;return copy as LearningUnit;
  })})),practiceSources:structuredClone(cloud.practiceSources),diagnostics:cloud.diagnostics.map(d=>({...d,message:'规划来源需要在本机检查。'}))};
}
function sourceReview(raw:unknown):CurrentSourceReview {
  const value=studyObject(raw,['itemKey','subjectId','completionRule','sourceHash','state']);studyId(value.itemKey);studyId(value.subjectId);studyDigest(value.sourceHash);
  if(!['three-stage','graded-practice','self-report','formal-mastered','formal-done','formal-completed-reference'].includes(String(value.completionRule))) throw new Error('invalid-completion-rule');
  const state=studyObject(value.state,['enabled','dueAt']);if(typeof state.enabled!=='boolean'||state.dueAt!==null&&typeof state.dueAt!=='string')throw new Error('invalid-source-review');
  if(typeof state.dueAt==='string')studyText(state.dueAt,'due-at');return structuredClone(value) as CurrentSourceReview;
}
function captureReview(raw:unknown):TimedReviewDemand {
  const value=studyObject(raw,['roundId','itemKey','subjectId','dueAt','observedAt','completionRule'],['blockedReason']);
  for(const key of ['roundId','itemKey','subjectId'])studyId(value[key]);for(const key of ['dueAt','observedAt'])studyText(value[key],key);
  if(!['three-stage','graded-practice','self-report','formal-mastered','formal-done','formal-completed-reference'].includes(String(value.completionRule)))throw new Error('invalid-completion-rule');
  if(value.blockedReason!==undefined)studyText(value.blockedReason,'blocked-reason');return structuredClone(value) as TimedReviewDemand;
}
async function planningFactsBody(raw:unknown,hasHash:boolean):Promise<PlanningFactsBody> {
  const value=studyObject(raw,['schemaVersion','libraryId','snapshotId','catalogHash','observedAt','nativePlanRevision','sourceReviews','captureReviews','legacyEvents','legacyTaskEvents','contentCandidates','historyComplete'],hasHash?['factsHash']:[]);
  if(value.schemaVersion!==1)throw new Error('unsupported-planning-facts-version');studyId(value.libraryId);studyId(value.snapshotId);studyDigest(value.catalogHash);
  if(hasHash)studyDigest(value.factsHash);studyText(value.observedAt,'observed-at');studyCount(value.nativePlanRevision,'native-plan-revision');
  if(!Array.isArray(value.sourceReviews)||!Array.isArray(value.captureReviews)||!Array.isArray(value.legacyEvents)||!Array.isArray(value.legacyTaskEvents)||!Array.isArray(value.contentCandidates)||typeof value.historyComplete!=='boolean')throw new Error('invalid-planning-facts');
  const sourceReviews=value.sourceReviews.map(sourceReview),captureReviews=value.captureReviews.map(captureReview);
  const legacyEvents:StudyEventV3[]=[];for(const event of value.legacyEvents)legacyEvents.push(await parseCloudStudyEventV3(event));
  const legacyTaskEvents:TaskEventV1[]=[];for(const event of value.legacyTaskEvents)legacyTaskEvents.push(await validateTaskEvent(event));
  const contentCandidates=value.contentCandidates.map(rawCandidate=>{const candidate=studyObject(rawCandidate,['candidateId','kind','label','contentHash'],['oldLabel']);studyId(candidate.candidateId);studyText(candidate.label,'candidate-label',200);studyDigest(candidate.contentHash);if(!['added','modified','removed','renamed'].includes(String(candidate.kind)))throw new Error('invalid-content-candidate');if(candidate.oldLabel!==undefined)studyText(candidate.oldLabel,'old-label',200);return structuredClone(candidate) as PlanningFactsBody['contentCandidates'][number];});
  if(new Set(legacyEvents.map(e=>e.eventId)).size!==legacyEvents.length||new Set(legacyTaskEvents.map(e=>e.eventId)).size!==legacyTaskEvents.length)throw new Error('duplicate-planning-fact-event');
  studySize(value,2*1024*1024);return {schemaVersion:1,libraryId:value.libraryId as string,snapshotId:value.snapshotId as string,catalogHash:value.catalogHash as string,
    observedAt:value.observedAt as string,nativePlanRevision:value.nativePlanRevision as number,sourceReviews,captureReviews,legacyEvents,legacyTaskEvents,contentCandidates,historyComplete:value.historyComplete};
}
export async function sealCloudPlanningFacts(raw:unknown):Promise<CloudPlanningFactsV1>{const body=await planningFactsBody(raw,false);return {...body,factsHash:await studyHash(body)};}
export async function parseCloudPlanningFacts(raw:unknown):Promise<CloudPlanningFactsV1>{const body=await planningFactsBody(raw,true),factsHash=(raw as CloudPlanningFactsV1).factsHash;if(await studyHash(body)!==factsHash)throw new Error('planning-facts-integrity');return {...body,factsHash};}
function cloudTask(task:DailyTask):CloudTask {
  return {...structuredClone(task),action:task.action.kind==='open-note'?{kind:'open-material',materialId:task.action.contentRef}:structuredClone(task.action)} as CloudTask;
}
function engineTask(task:CloudTask):DailyTask {
  return {...structuredClone(task),action:task.action.kind==='open-material'?{kind:'open-note',contentRef:task.action.materialId}:structuredClone(task.action)} as DailyTask;
}
function cloudPlanBody(raw:unknown,hasHash:boolean):CloudPlanBody {
  const value=studyObject(raw,['schemaVersion','day','catalogHash','factsHash','eventThrough','taskThrough','nativeBaseRevision','enginePlanHash','inputHash','sourceHash','draftVersion','tasks','vocabulary','manual','baseRevision'],[...(hasHash?['cloudPlanHash']:[]),'optionalMinutes','longTermAllocation']);
  if(value.schemaVersion!==1||!validPlanDay(value.day)) throw new Error('invalid-cloud-plan');for(const key of ['catalogHash','factsHash','enginePlanHash','inputHash','sourceHash'])studyDigest(value[key]);
  studyCount(value.eventThrough,'event-through');studyCount(value.taskThrough,'task-through');studyCount(value.nativeBaseRevision,'native-base-revision');
  studyCount(value.draftVersion,'draft-version');studyCount(value.baseRevision,'base-revision');if(value.optionalMinutes!==undefined)studyCount(value.optionalMinutes,'optional-minutes');
  if(hasHash)studyDigest(value.cloudPlanHash);if(!Array.isArray(value.tasks))throw new Error('invalid-cloud-tasks');
  const tasks=(value.tasks as unknown[]).map(rawTask=>{const copy=structuredClone(rawTask) as Record<string,unknown>;const action=cloudAction(copy.action);copy.action=action;parseDailyTask({...copy,action:action.kind==='open-material'?{kind:'open-note',contentRef:action.materialId}:action});return copy as CloudTask;});
  const engine={schemaVersion:2,day:value.day,planHash:value.enginePlanHash,inputHash:value.inputHash,sourceHash:value.sourceHash,draftVersion:value.draftVersion,
    tasks:tasks.map(engineTask),vocabulary:value.vocabulary,manual:value.manual,...(value.longTermAllocation===undefined?{}:{longTermAllocation:value.longTermAllocation as TaskPlanV2['longTermAllocation']}),...(value.optionalMinutes===undefined?{}:{optionalMinutes:value.optionalMinutes})};
  parseTaskPlan(engine);studySize(value,2*1024*1024);
  return {schemaVersion:1,day:value.day as string,catalogHash:value.catalogHash as string,factsHash:value.factsHash as string,eventThrough:value.eventThrough as number,taskThrough:value.taskThrough as number,nativeBaseRevision:value.nativeBaseRevision as number,enginePlanHash:value.enginePlanHash as string,inputHash:value.inputHash as string,sourceHash:value.sourceHash as string,
    draftVersion:value.draftVersion as number,tasks,vocabulary:structuredClone(value.vocabulary) as TaskPlanV2['vocabulary'],manual:structuredClone(value.manual) as TaskPlanV2['manual'],baseRevision:value.baseRevision as number,
    ...(value.longTermAllocation===undefined?{}:{longTermAllocation:value.longTermAllocation as TaskPlanV2['longTermAllocation']}),...(value.optionalMinutes===undefined?{}:{optionalMinutes:value.optionalMinutes as number})};
}
async function checkEngineHash(body:CloudPlanBody):Promise<void> {
  const engine={schemaVersion:2 as const,day:body.day,inputHash:body.inputHash,sourceHash:body.sourceHash,draftVersion:body.draftVersion,tasks:body.tasks.map(engineTask),
    vocabulary:body.vocabulary,manual:body.manual,...(body.longTermAllocation===undefined?{}:{longTermAllocation:body.longTermAllocation as TaskPlanV2['longTermAllocation']}),...(body.optionalMinutes===undefined?{}:{optionalMinutes:body.optionalMinutes})};
  if(await hashTaskPlan(engine)!==body.enginePlanHash) throw new Error('cloud-plan-engine-integrity');
}
export async function sealCloudTaskPlan(raw:TaskPlanV2,catalog:CloudPlanningCatalogV1,context:{baseRevision:number;factsHash:string;eventThrough:number;taskThrough:number;nativeBaseRevision:number}):Promise<CloudTaskPlanV1> {
  const plan=parseTaskPlan(raw),checked=await parseCloudPlanningCatalog(catalog);studyCount(context.baseRevision,'base-revision');studyDigest(context.factsHash);studyCount(context.eventThrough,'event-through');studyCount(context.taskThrough,'task-through');studyCount(context.nativeBaseRevision,'native-base-revision');
  if(plan.sourceHash!==checked.sourceHash) throw new Error('cloud-plan-source-mismatch');
  const body=cloudPlanBody({schemaVersion:1,day:plan.day,catalogHash:checked.catalogHash,factsHash:context.factsHash,eventThrough:context.eventThrough,taskThrough:context.taskThrough,nativeBaseRevision:context.nativeBaseRevision,
    enginePlanHash:plan.planHash,inputHash:plan.inputHash,sourceHash:plan.sourceHash,draftVersion:plan.draftVersion,tasks:plan.tasks.map(cloudTask),vocabulary:plan.vocabulary,manual:plan.manual,baseRevision:context.baseRevision,...(plan.longTermAllocation===undefined?{}:{longTermAllocation:plan.longTermAllocation as TaskPlanV2['longTermAllocation']}),...(plan.optionalMinutes===undefined?{}:{optionalMinutes:plan.optionalMinutes})},false);
  await checkEngineHash(body);return {...body,cloudPlanHash:await studyHash(body)};
}
export async function parseCloudTaskPlan(raw:unknown,catalog:CloudPlanningCatalogV1):Promise<CloudTaskPlanV1> {
  const body=cloudPlanBody(raw,true),cloudPlanHash=(raw as CloudTaskPlanV1).cloudPlanHash,checked=await parseCloudPlanningCatalog(catalog);
  if(body.sourceHash!==checked.sourceHash||body.catalogHash!==checked.catalogHash||await studyHash(body)!==cloudPlanHash) throw new Error('cloud-plan-integrity');await checkEngineHash(body);return {...body,cloudPlanHash};
}
export async function toEngineTaskPlan(raw:unknown,catalog:CloudPlanningCatalogV1):Promise<TaskPlanV2>{
  const cloud=await parseCloudTaskPlan(raw,catalog);return parseTaskPlan({schemaVersion:2,day:cloud.day,planHash:cloud.enginePlanHash,inputHash:cloud.inputHash,
    sourceHash:cloud.sourceHash,draftVersion:cloud.draftVersion,tasks:cloud.tasks.map(engineTask),vocabulary:cloud.vocabulary,manual:cloud.manual,
    ...(cloud.longTermAllocation===undefined?{}:{longTermAllocation:cloud.longTermAllocation as TaskPlanV2['longTermAllocation']}),...(cloud.optionalMinutes===undefined?{}:{optionalMinutes:cloud.optionalMinutes})});
}
export async function materializeCloudTaskPlan(raw:unknown,native:PlanningCatalog,materials:LocalPlanningMaterials):Promise<{cloudPlanHash:string;nativePlan:TaskPlanV2}> {
  const cloudCatalogSource=(raw as CloudTaskPlanV1)?.sourceHash;if(typeof cloudCatalogSource!=='string') throw new Error('invalid-cloud-plan');
  const body=cloudPlanBody(raw,true),cloudPlanHash=(raw as CloudTaskPlanV1).cloudPlanHash;if(await studyHash(body)!==cloudPlanHash)throw new Error('cloud-plan-integrity');await checkEngineHash(body);
  const tasks:DailyTask[]=[];
  for(const task of body.tasks) {
    let action:TaskAction=structuredClone(task.action) as TaskAction;
    if(task.action.kind==='open-material') {
      const material=materials[task.action.materialId];
      if(!material||task.unitIds.length!==1||material.unitId!==task.unitIds[0]||material.subjectId!==task.subjectId) throw new Error('local-material-binding');
      action={kind:'open-note',contentRef:material.contentRef};
    }
    const mapped={...structuredClone(task),action} as DailyTask;mapped.sourceHash=await taskSourceHash(mapped,native);tasks.push(mapped);
  }
  const nativeWords=new Map(native.subjects.flatMap(s=>s.words).map(word=>[word.itemKey,word]));
  const vocabulary=structuredClone(body.vocabulary);if(vocabulary.snapshot) vocabulary.snapshot=vocabulary.snapshot.map(word=>nativeWords.get(word.itemKey)??word);
  const partial={schemaVersion:2 as const,day:body.day,inputHash:body.inputHash,sourceHash:native.sourceHash,draftVersion:body.draftVersion,tasks,vocabulary,manual:body.manual,
    ...(body.longTermAllocation===undefined?{}:{longTermAllocation:body.longTermAllocation as TaskPlanV2['longTermAllocation']}),...(body.optionalMinutes===undefined?{}:{optionalMinutes:body.optionalMinutes})};
  const nativePlan=parseTaskPlan({...partial,planHash:await hashTaskPlan(partial)});return {cloudPlanHash,nativePlan};
}
