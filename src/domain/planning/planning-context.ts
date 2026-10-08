import type {CompletionRule,PlanningContext,PlanningCatalog,LearningUnit,SubjectGoal,PlanningEvidenceRecord,PlanningEvidencePage,SourceReviewState} from './task-plan-types';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {parseDailyTask,parseWordSnapshot,validPlanDay} from './task-plan-types.ts';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {parseCloudStudyEventV3} from '../evidence/index.ts';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {planningHash} from './task-plan-engine.ts';

const rules:CompletionRule[]=['three-stage','graded-practice','self-report','formal-mastered','formal-done','formal-completed-reference'];
function fail():never {throw new Error('invalid-planning-context');}
function object(value:unknown,required:string[],optional:string[]=[]):Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value)) return fail();
  if (required.some(key=>!Object.hasOwn(value,key)) || Object.keys(value).some(key=>![...required,...optional].includes(key))) return fail();
  return value as Record<string,unknown>;
}
function text(value:unknown):asserts value is string {
  if (typeof value!=='string' || !value.trim() || value.length>4000 || [...value].some(char=>char.codePointAt(0)!<32 || char.codePointAt(0)===127)) fail();
}
function hash(value:unknown):asserts value is string {if (typeof value!=='string' || !/^[a-f0-9]{64}$/.test(value)) fail();}
function integer(value:unknown,min=0):asserts value is number {if (!Number.isSafeInteger(value) || (value as number)<min) fail();}
function array(value:unknown):unknown[] {if (!Array.isArray(value)) return fail();return value;}
function strings(value:unknown):string[] {const values=array(value);values.forEach(text);if (new Set(values).size!==values.length) fail();return values as string[];}
function bool(value:unknown):void {if (typeof value!=='boolean') fail();}
function rule(value:unknown):void {if (!rules.includes(value as CompletionRule)) fail();}
export function validPlanningInstant(value:unknown):value is string {
  if (typeof value!=='string') return false;
  const match=/^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{3})?(Z|[+-]\d\d:\d\d)$/.exec(value);
  return Boolean(match && validPlanDay(match[1]) && Number(match[2])<24 && Number(match[3])<60 && Number(match[4])<60 && Number.isFinite(Date.parse(value)));
}
function instant(value:unknown):void {if (!validPlanningInstant(value)) fail();}
export function parseSourceReviewState(value:unknown):SourceReviewState {
  const state=object(value,['enabled','dueAt']);bool(state.enabled);
  if (state.dueAt!==null) instant(state.dueAt);
  return structuredClone(state) as SourceReviewState;
}
function unit(value:unknown):LearningUnit {
  const item=object(value,['unitId','subjectId','title','order','sourceHash','prerequisites','action','completionRule'],['estimatedMinutes','stateRef','abilityId','formalComplete','planningLabel','taskComplete']);
  text(item.unitId);integer(item.order);strings(item.prerequisites);
  for(const key of ['stateRef','abilityId','planningLabel']) if(item[key]!==undefined) text(item[key]);
  for(const key of ['formalComplete','taskComplete']) if(item[key]!==undefined) bool(item[key]);
  parseDailyTask({taskId:item.unitId,subjectId:item.subjectId,title:item.title,category:'subject',origin:'manual',required:false,
    unitIds:[item.unitId],quantity:1,sourceHash:item.sourceHash,action:item.action,completionRule:item.completionRule,
    ...(item.estimatedMinutes===undefined?{}:{estimatedMinutes:item.estimatedMinutes})});
  return structuredClone(item) as LearningUnit;
}
function goal(value:unknown):SubjectGoal {
  const item=object(value,['goalId','subjectId','title','kind','targetCount','unitIds','startOn','priority','required','completionBasis'],['dueOn']);
  for(const key of ['goalId','subjectId','title']) text(item[key]);
  if (!['daily','weekly','deadline'].includes(item.kind as string) || !['practice-round','self-report','formal-state'].includes(item.completionBasis as string)) fail();
  integer(item.targetCount,1);integer(item.priority,1);bool(item.required);
  if (item.priority>5 || !strings(item.unitIds).length || !validPlanDay(item.startOn)) fail();
  if (item.dueOn!==undefined && (!validPlanDay(item.dueOn) || (item.dueOn as string)<(item.startOn as string))) fail();
  if (item.kind==='deadline' && !item.dueOn) fail();
  return structuredClone(item) as SubjectGoal;
}
export function parsePlanningCatalog(value:unknown):PlanningCatalog {
  const catalog=object(value,['schemaVersion','sourceHash','subjects','diagnostics'],['practiceSources']);
  if (catalog.schemaVersion!==1) fail();hash(catalog.sourceHash);
  const subjectIds=new Set<string>(),unitIds=new Set<string>(),goalIds=new Set<string>(),wordIds=new Set<string>();
  for(const raw of array(catalog.subjects)) {
    const subject=object(raw,['subjectId','name','priority','words','units','goals'],['planningStatus','lastProgressAt']);
    text(subject.subjectId);text(subject.name);integer(subject.priority,1);
    if (subjectIds.has(subject.subjectId) || subject.priority>5) fail();subjectIds.add(subject.subjectId);
    if (subject.planningStatus!==undefined && !['none','ready','invalid'].includes(subject.planningStatus as string)) fail();
    if (subject.lastProgressAt!==undefined) instant(subject.lastProgressAt);
    for(const raw of array(subject.words)) {
      if (!raw || typeof raw!=='object' || !('language' in raw) || typeof raw.language!=='string') fail();
      // Unknown language is valid catalog data, but cannot become an assigned identity.
      const word=parseWordSnapshot({...raw,language:raw.language.trim()?raw.language:'und'});
      if (word.subjectId!==subject.subjectId || wordIds.has(word.itemKey)) fail();wordIds.add(word.itemKey);
    }
    for(const raw of array(subject.units)) {
      const parsed=unit(raw);
      if (parsed.subjectId!==subject.subjectId || unitIds.has(parsed.unitId)) fail();unitIds.add(parsed.unitId);
    }
    for(const raw of array(subject.goals)) {
      const parsed=goal(raw);
      if (parsed.subjectId!==subject.subjectId || goalIds.has(parsed.goalId)) fail();goalIds.add(parsed.goalId);
    }
  }
  const practiceIds=new Set<string>();
  for(const raw of array(catalog.practiceSources??[])) {
    const source=object(raw,['itemKey','subjectId','title','sourceHash','completionRule']);
    for(const key of ['itemKey','subjectId','title']) text(source[key]);hash(source.sourceHash);rule(source.completionRule);
    if (!subjectIds.has(source.subjectId as string) || practiceIds.has(source.itemKey as string)) fail();practiceIds.add(source.itemKey as string);
  }
  for(const raw of array(catalog.diagnostics)) {
    const diagnostic=object(raw,['code','message'],['subjectId']);text(diagnostic.code);text(diagnostic.message);
    if (diagnostic.subjectId!==undefined) text(diagnostic.subjectId);
  }
  return structuredClone(catalog) as PlanningCatalog;
}
export function parsePlanningContext(value:unknown):PlanningContext {
  const context=object(value,['catalog','sourceReviews','captureReviews','observedAt','planRevision','capabilities']);
  parsePlanningCatalog(context.catalog);instant(context.observedAt);integer(context.planRevision);strings(context.capabilities);
  for(const raw of array(context.sourceReviews)) {
    const source=object(raw,['itemKey','subjectId','completionRule','sourceHash','state']);
    text(source.itemKey);text(source.subjectId);hash(source.sourceHash);rule(source.completionRule);parseSourceReviewState(source.state);
  }
  for(const raw of array(context.captureReviews)) {
    const source=object(raw,['roundId','itemKey','subjectId','dueAt','observedAt','completionRule'],['blockedReason']);
    for(const key of ['roundId','itemKey','subjectId']) text(source[key]);instant(source.dueAt);instant(source.observedAt);rule(source.completionRule);
    if (source.blockedReason!==undefined) text(source.blockedReason);
  }
  return structuredClone(context) as PlanningContext;
}
export async function parsePlanningRecord(value:unknown):Promise<PlanningEvidenceRecord> {
  const record=object(value,['event','subjectId'],['planningEvidence']);text(record.subjectId);
  const event=await parseCloudStudyEventV3(record.event);
  if (record.planningEvidence!==undefined) {
    const evidence=object(record.planningEvidence,['schemaVersion','eventId','coreHash','evidenceHash'],['word','itemSource','beforeReview','afterReview']);
    if (evidence.schemaVersion!==1 || evidence.eventId!==event.eventId || evidence.coreHash!==event.coreHash) fail();
    hash(evidence.evidenceHash);
    if(evidence.itemSource!==undefined){
      const source=object(evidence.itemSource,['itemKey','subjectId','sourceHash']);text(source.itemKey);text(source.subjectId);hash(source.sourceHash);
      if(source.itemKey!==event.item.key||source.subjectId!==record.subjectId)fail();
    }
    if (evidence.word!==undefined) {
      const raw=evidence.word;
      if (!raw || typeof raw!=='object' || !('language' in raw) || typeof raw.language!=='string') fail();
      // Historical physical identity must survive even when language was never confirmed.
      // Use a temporary validation sentinel only; return/hash the unchanged unknown value.
      const word=parseWordSnapshot({...raw,language:raw.language.trim()?raw.language:'und'});
      if (word.subjectId!==record.subjectId || ![word.itemKey,...(word.legacyKeys??[])].includes(event.item.key)) fail();
    }
    for(const key of ['beforeReview','afterReview']) if(evidence[key]!==undefined) parseSourceReviewState(evidence[key]);
    const body={...evidence};delete body.evidenceHash;
    if (await planningHash(body)!==evidence.evidenceHash) throw new Error('invalid-planning-evidence-hash');
  }
  return {...structuredClone(record),event} as PlanningEvidenceRecord;
}
export async function parsePlanningEvidencePage(value:unknown):Promise<PlanningEvidencePage> {
  const page=object(value,['records','sourceHash','planRevision','snapshotHash','nextCursor']);
  hash(page.sourceHash);hash(page.snapshotHash);integer(page.planRevision);
  if (page.nextCursor!==null) text(page.nextCursor);
  const records=array(page.records);
  if (records.length>100 || (!records.length && page.nextCursor!==null)) fail();
  return {...page,records:await Promise.all(records.map(parsePlanningRecord))} as PlanningEvidencePage;
}
export async function loadPlanningRecords(context:PlanningContext,client:{getPlanningEvidence:(sourceHash:string,planRevision:number,after?:string)=>Promise<unknown>}):Promise<PlanningEvidenceRecord[]> {
  const records:PlanningEvidenceRecord[]=[],cursors=new Set<string>();let after:string|undefined,snapshot:string|undefined;
  do {
    const page=await parsePlanningEvidencePage(await client.getPlanningEvidence(context.catalog.sourceHash,context.planRevision,after));
    if (page.sourceHash!==context.catalog.sourceHash || page.planRevision!==context.planRevision || (snapshot!==undefined && snapshot!==page.snapshotHash)) throw new Error('planning-history-changed');
    snapshot=page.snapshotHash;records.push(...page.records);after=page.nextCursor??undefined;
    if (after && cursors.has(after)) throw new Error('planning-history-cursor-cycle');
    if (after) cursors.add(after);
  } while(after!==undefined);
  const recordsHash=await planningHash(records.map(row=>[row.event.eventId,row.event.coreHash,row.subjectId,row.planningEvidence?.evidenceHash??null]));
  if (await planningHash([context.catalog.sourceHash,context.planRevision,recordsHash])!==snapshot) throw new Error('planning-history-incomplete');
  return records;
}
