export type PlanningStudySubject={id:string;legacyIds?:string[];items:Array<{accountItemKey?:string;word?:string;abilityId?:string;itemId?:string;id?:string;contentHash?:string}>};
import type {PlanCandidate} from './daily-plan';
import type {StudyEventV3} from '../evidence';
import type {PlanningCatalog,ReviewObligation,TaskPlanV2,WordLearning,SuggestionRequest,SuggestionResponse,DailyTask} from './task-plan-types';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {countNewWords,lexemeKey,studyDay} from './vocabulary-learning.ts';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {hashTaskPlan} from './task-plan-engine.ts';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {parseTaskPlan} from './task-plan-types.ts';
// @ts-expect-error Node source tests.
import {planningUnitAlreadyScheduled} from './task-plan-overlap.ts';

export type TaskPlanSummary={newDone:number;newTarget:number;newMissing:number;reviewDone:number;reviewTotal:number};
export function summarizeTaskPlan(plan:TaskPlanV2,words:WordLearning[],reviews:ReviewObligation[]):TaskPlanSummary {
  const newDone=countNewWords(plan.day,words),selected=new Set<string>();
  const completed=new Set(words.filter(word=>word.firstLearnedAt && studyDay(word.firstLearnedAt)===plan.day).map(word=>word.lexemeKey));
  const snapshots=new Map((plan.vocabulary.snapshot??[]).map(word=>[word.itemKey,word]));
  for(const task of plan.tasks) if(task.category==='new-word' && task.required && !task.blockedReason && task.action.kind==='practice') {
    for(const key of task.action.itemKeys) {const word=snapshots.get(key);if(word) selected.add(lexemeKey(word));}
  }
  for(const key of completed) selected.add(key);
  const rounds=[...new Map(reviews.map(round=>[round.roundId,round])).values()];
  return {newDone,newTarget:plan.vocabulary.target,newMissing:Math.max(0,plan.vocabulary.target-selected.size),reviewDone:rounds.filter(round=>round.completed).length,reviewTotal:rounds.length};
}

/** Temporary legacy-engine adapter, never another saved authoritative plan. */
export function practicePlanForTask(plan:TaskPlanV2,taskId:string,catalog:PlanningCatalog):PlanCandidate {
  const task=plan.tasks.find(task=>task.taskId===taskId);
  if (!task) throw new Error('找不到这项今日任务。');
  if (task.blockedReason) throw new Error(task.blockedReason);
  if (task.action.kind!=='practice') throw new Error('task-not-practice');
  const subject=catalog.subjects.find(subject=>subject.subjectId===task.subjectId);
  const keys=task.action.itemKeys;
  const vocabulary=keys.every(key=>subject?.words.some(word=>word.itemKey===key || word.legacyKeys?.includes(key)));
  const common={kind:task.category==='review'?'review' as const:'study' as const,domain:task.subjectId,estimatedMinutes:0,reasons:[],title:task.title};
  const items:PlanCandidate['items']=vocabulary
    ? [{...common,itemKey:task.taskId,practice:{kind:'vocab-group',subjectId:task.subjectId,count:keys.length,itemKeys:[...keys],groupIndex:0,groupQuota:keys.length}}]
    : keys.map(key=>({...common,itemKey:key,practice:{kind:'question',subjectId:task.subjectId,count:1,itemKeys:[key],
      ...(key.startsWith('practice:')?{itemIds:[key.slice(9)]}:{})}}));
  return {day:plan.day,planHash:plan.planHash,inputHash:plan.inputHash,items,totalMinutes:task.estimatedMinutes??0,overloaded:false,skipped:[]};
}

/** Task review stages begin after their immutable learning/review anchor, not a daily stage cache. */
export function taskWordStages(task:DailyTask,round:ReviewObligation|undefined,events:StudyEventV3[],stages:Record<string,number>,catalog:PlanningCatalog):Record<string,number> {
  if(task.category!=='review' || task.action.kind!=='practice') return stages;
  const result={...stages},anchor=events.find(event=>event.eventId===round?.anchorEventId);
  const after=anchor?.eventType==='practice-attempt'?Date.parse(anchor.occurredAt):round?.observedAt?Date.parse(round.observedAt):-Infinity;
  for(const key of task.action.itemKeys){
    const word=catalog.subjects.find(subject=>subject.subjectId===task.subjectId)?.words.find(word=>word.itemKey===key || word.legacyKeys?.includes(key));
    const aliases=new Set([key,...(word?[word.itemKey]:[]),...word?.legacyKeys??[]]);
    const attempts=events.filter(event=>event.eventType==='practice-attempt' && aliases.has(event.item.key) && Date.parse(event.occurredAt)>after)
      .sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)||a.eventId.localeCompare(b.eventId));
    const latest=attempts.at(-1),stage=latest?.eventType==='practice-attempt' && latest.attempt.correct?latest.attempt.stageAfter:0;
    for(const alias of aliases) result[alias]=stage;
  }
  return result;
}

/** The catalog and displayed questions must describe the same content, not just the same IDs. */
export function assertPlanningStudySources(catalog:PlanningCatalog,subjects:PlanningStudySubject[],task?:DailyTask):void {
  if(task && task.action.kind!=='practice') return;
  const wanted=task?.action.kind==='practice'?new Set(task.action.itemKeys):null;
  const expected:Array<{itemKey:string;subjectId:string;sourceHash:string;aliases:string[]}>=catalog.subjects.flatMap(subject=>subject.words.map(word=>({...word,aliases:word.legacyKeys??[]})));
  expected.push(...(catalog.practiceSources??[]).map(source=>({...source,aliases:[]})));
  let checked=0;
  for(const reference of expected){
    if(wanted && ![reference.itemKey,...reference.aliases].some(key=>wanted.has(key))) continue;
    if(task && reference.subjectId!==task.subjectId) continue;
    const actual=subjects.filter(subject=>subject.id===reference.subjectId || subject.legacyIds?.includes(reference.subjectId)).flatMap(subject=>subject.items)
      .filter(item=>(typeof item.accountItemKey==='string'?item.accountItemKey:item.word?item.abilityId:`practice:${item.itemId??item.id??''}`)===reference.itemKey);
    if(actual.length!==1 || actual[0].contentHash!==reference.sourceHash) throw new Error('计划与练习资料版本不一致，请同步学习资料后再开始。');
    checked++;
  }
  if(wanted && checked!==wanted.size) throw new Error('任务资料引用不完整，请同步学习知识库。');
}

async function sealTaskPlan(plan:TaskPlanV2):Promise<TaskPlanV2> {
  const body={...plan};delete (body as Partial<TaskPlanV2>).planHash;
  return parseTaskPlan({...body,planHash:await hashTaskPlan(body)});
}
/** Refresh only replaceable suggestions; manual, started and completed work always stays. */
export async function prepareTaskSuggestion(value:TaskPlanV2,intent:SuggestionRequest['intent'],completedIds:string[]):Promise<TaskPlanV2> {
  if (intent==='more') return value;
  const protectedIds=new Set([...value.manual.lockedTaskIds,...completedIds]);
  const removed=value.tasks.filter(task=>!task.required && ['ai','fallback'].includes(task.origin) && !protectedIds.has(task.taskId));
  if (!removed.length) return value;
  const plan=structuredClone(value),ids=new Set(removed.map(task=>task.taskId));
  plan.tasks=plan.tasks.filter(task=>!ids.has(task.taskId));
  if (intent==='less') plan.manual.excludedUnitIds=[...new Set([...plan.manual.excludedUnitIds,...removed.flatMap(task=>task.unitIds)])];
  if (plan.manual.order) plan.manual.order=plan.manual.order.filter(id=>!ids.has(id));
  plan.draftVersion++;
  return sealTaskPlan(plan);
}
export async function applyTaskSuggestions(value:TaskPlanV2,response:SuggestionResponse,catalog:PlanningCatalog):Promise<TaskPlanV2> {
  if (value.day!==response.day || value.sourceHash!==response.sourceHash || value.sourceHash!==catalog.sourceHash || value.draftVersion!==response.draftVersion) throw new Error('stale-suggestion');
  const plan=structuredClone(value),selected=new Set(plan.tasks.flatMap(task=>task.unitIds));
  const ids=response.selections.flatMap(selection=>selection.unitIds);
  if (ids.length>3 || new Set(ids).size!==ids.length) throw new Error('invalid-suggestion-count');
  for(const id of ids) {
    const subject=catalog.subjects.find(subject=>subject.units.some(unit=>unit.unitId===id)),unit=subject?.units.find(unit=>unit.unitId===id);
    if (!unit || !subject) throw new Error('unknown-suggestion-unit');
    if (subject.goals.length || subject.planningStatus==='invalid' || unit.formalComplete || unit.taskComplete || selected.has(id) || plan.manual.excludedUnitIds.includes(id)||planningUnitAlreadyScheduled(unit,plan.tasks)) throw new Error('ineligible-suggestion-unit');
    plan.tasks.push({taskId:`suggestion:${plan.day}:${id}`,subjectId:subject.subjectId,title:unit.title,category:'subject',origin:response.mode==='ai'?'ai':'fallback',
      required:false,unitIds:[id],quantity:1,action:structuredClone(unit.action),completionRule:unit.completionRule,sourceHash:unit.sourceHash,
      ...(unit.estimatedMinutes===undefined?{}:{estimatedMinutes:unit.estimatedMinutes})});
  }
  if (!ids.length) return value;
  plan.draftVersion++;
  return sealTaskPlan(plan);
}
