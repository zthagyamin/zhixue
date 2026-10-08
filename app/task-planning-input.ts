// @ts-expect-error TS5097: standalone Node contracts.
import {studyDayBounds,sourceReviewDueAt,completionDay} from '../src/domain/planning/index.ts';
import type {PlanningInputFacts,CompletionFacts} from '../src/domain/planning';
export type {PlanningHistoryStatus,PlanningInputFacts} from '../src/domain/planning';
import type {StudyAttemptEventV3,StudyEventV3} from './study-event-v3';
import type {DailyPlanningInput,PlanningCatalog,PlanningWord,ReviewObligation,
  TaskCompletion,TaskEventV1,TaskPlanV2} from './task-plan-types';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {validPlanDay} from './task-plan-types.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {parsePlanningContext,parsePlanningRecord} from './planning-context.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {validateTaskEvent} from './task-event-v1.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {uniqueStudyEvents,projectVocabulary,studyDay,lexemeKey,compareEvidenceText} from './vocabulary-learning.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {projectReviewObligations} from './task-review-projection.ts';
function completeAttempts(events:StudyEventV3[]):StudyAttemptEventV3[] {
  return events.filter((event):event is StudyAttemptEventV3=>event.eventType==='practice-attempt' && event.attempt.correct && event.attempt.stageAfter===3);
}
/** Explicit aliases only, and never credit a reused/ambiguous physical key. */
function physicalKeys(identities:PlanningWord[]):(key:string)=>string|undefined {
  const owners=new Map<string,Set<string>>(),lexemes=new Map<string,Set<string>>();
  for(const word of identities) {
    const identity=word.language.trim()?`${word.subjectId}:${lexemeKey(word)}`:`unknown:${word.itemKey}`;
    for(const key of [word.itemKey,...word.legacyKeys??[]]) {
      const items=owners.get(key)??new Set<string>();items.add(word.itemKey);owners.set(key,items);
      const meanings=lexemes.get(key)??new Set<string>();meanings.add(identity);lexemes.set(key,meanings);
    }
  }
  return key=>!owners.has(key)?key:owners.get(key)!.size===1 && lexemes.get(key)!.size===1?[...owners.get(key)!][0]:undefined;
}
function previousReviews(plan:TaskPlanV2|null):ReviewObligation[] {
  return plan?.tasks.flatMap(task=>task.category==='review' && task.reviewRoundId && task.action.kind==='practice'
    ? [{roundId:task.reviewRoundId,itemKey:task.action.itemKeys[0],subjectId:task.subjectId,completionRule:task.completionRule,
      dueAt:sourceReviewDueAt(`${plan.day}T00:00:00+08:00`),completed:false,blockedReason:task.blockedReason}]:[])??[];
}
export function projectUnitCompletions(catalog:PlanningCatalog,events:StudyEventV3[],reports:TaskEventV1[],identities:PlanningWord[]):TaskCompletion[] {
  const keyFor=physicalKeys(identities),days=new Map<string,Map<string,string>>();
  for(const event of completeAttempts(events)) {
    const key=keyFor(event.item.key);if (!key) continue;
    const day=studyDay(event.occurredAt),keys=days.get(day)??new Map<string,string>();
    // First completed round for a physical item in each day is sufficient for one unit.
    if (!keys.has(key) || event.occurredAt<keys.get(key)!) keys.set(key,event.occurredAt);
    days.set(day,keys);
  }
  const result:TaskCompletion[]=[];
  for(const subject of catalog.subjects) for(const unit of subject.units) {
    if (unit.completionRule==='self-report') {
      for(const report of reports) if(report.source==='self-report' && report.subjectId===subject.subjectId && report.unitIds.includes(unit.unitId)) {
        result.push({taskId:report.taskId,unitId:unit.unitId,occurredAt:report.occurredAt,day:report.day,basis:'self-report'});
      }
    } else if (['three-stage','graded-practice'].includes(unit.completionRule) && unit.action.kind==='practice') {
      const required=unit.action.itemKeys.map(keyFor);
      if (required.some(key=>!key)) continue;
      for(const [day,keys] of days) if(required.every(key=>keys.has(key!))) {
        result.push({taskId:`practice:${unit.unitId}:${day}`,unitId:unit.unitId,
          occurredAt:required.map(key=>keys.get(key!)!).sort(compareEvidenceText).at(-1)!,basis:'practice-round'});
      }
    }
    // formalComplete is a current canonical state, not a dated completion event.
  }
  return result.sort((a,b)=>compareEvidenceText(a.occurredAt,b.occurredAt)||compareEvidenceText(a.taskId,b.taskId));
}
export function completedPlanTaskIds(plan:TaskPlanV2|null,facts:CompletionFacts):string[] {
  if (!plan) return [];
  const keyFor=physicalKeys(facts.identities);
  const completedKeys=new Set(completeAttempts(facts.events).filter(event=>studyDay(event.occurredAt)===plan.day).map(event=>keyFor(event.item.key)).filter(Boolean));
  return plan.tasks.filter(task=>{
    if (task.category==='review') return facts.reviews.some(round=>round.completed
      && (round.roundId===task.reviewRoundId || round.aliasRoundIds?.includes(task.reviewRoundId??'')));
    if (task.completionRule.startsWith('formal-')) return task.unitIds.length>0 && task.unitIds.every(id=>facts.catalog.subjects
      .find(subject=>subject.subjectId===task.subjectId)?.units.some(unit=>unit.unitId===id && unit.completionRule===task.completionRule && unit.formalComplete));
    if (task.completionRule==='self-report') {
      if (task.unitIds.length) return task.unitIds.every(id=>facts.completions.some(done=>done.unitId===id && done.basis==='self-report' && completionDay(done)===plan.day));
      return facts.taskEvents.some(event=>event.source==='self-report' && event.day===plan.day && event.subjectId===task.subjectId && event.taskId===task.taskId);
    }
    return task.action.kind==='practice' && task.action.itemKeys.every(key=>Boolean(keyFor(key)) && completedKeys.has(keyFor(key)));
  }).map(task=>task.taskId);
}

/** Compose only complete, integrity-checked channels; failures never become empty progress. */
export async function buildDailyPlanningInput(facts:PlanningInputFacts):Promise<{input:DailyPlanningInput;events:StudyEventV3[];completedTaskIds:string[];taskEvents:TaskEventV1[]}> {
  if (['local','companion','tasks'].some(key=>facts.history[key as keyof typeof facts.history]!=='complete')
    || !['complete','not-applicable'].includes(facts.history.cloud)) throw new Error('planning-history-not-ready');
  if (!validPlanDay(facts.day)) throw new Error('invalid-plan-day');
  const {end}=studyDayBounds(facts.day);
  const context=parsePlanningContext(facts.context);
  const records=await Promise.all(facts.companionRecords.map(parsePlanningRecord));
  const events=(await uniqueStudyEvents([...facts.localEvents,...records.map(row=>row.event)]))
    .filter(event=>event.eventType==='review-baseline' || Date.parse(event.occurredAt)<end);
  const live=context.catalog.subjects.flatMap(subject=>subject.words);
  const historical=records.filter(row=>Date.parse(row.event.occurredAt)<end).flatMap(row=>row.planningEvidence?.word?[row.planningEvidence.word]:[]);
  const descriptors=[...live,...historical,...facts.previous?.vocabulary.snapshot??[]];
  const identities=[...new Map(descriptors.map(word=>[JSON.stringify([word.subjectId,word.itemKey,word.word,word.language,word.legacyKeys??[]]),word])).values()];
  const words=await projectVocabulary(identities,events,{complete:true,legacyItemKeys:facts.legacyItemKeys});
  const reports=new Map<string,TaskEventV1>();
  for(const raw of facts.taskEvents) {
    const report=await validateTaskEvent(raw),previous=reports.get(report.eventId);
    if (previous && previous.coreHash!==report.coreHash) throw new Error('task-event-conflict');
    if (Date.parse(report.occurredAt)<end) reports.set(report.eventId,report);
  }
  const taskEvents=[...reports.values()];
  const reviews=await projectReviewObligations({day:facts.day,words,events,previous:previousReviews(facts.previous),catalog:context.catalog,
    sourceHistory:records.filter(row=>Date.parse(row.event.occurredAt)<end),currentSourceReviews:context.sourceReviews,
    sourceObservedAt:context.observedAt,timedSourceReviews:context.captureReviews});
  const completions=projectUnitCompletions(context.catalog,events,taskEvents,identities);
  const input:DailyPlanningInput={day:facts.day,catalog:context.catalog,words,reviews,completions,previous:facts.previous,
    wordIdentities:identities,...(facts.optionalMinutes===undefined?{}:{optionalMinutes:facts.optionalMinutes})};
  return {input,events,taskEvents,completedTaskIds:completedPlanTaskIds(facts.previous,{catalog:context.catalog,events,completions,reviews,identities,taskEvents})};
}
