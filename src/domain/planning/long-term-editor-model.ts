import type {LongTermPlanSpec,LongTermPlanSnapshot,LongTermHistoryEntry} from './long-term-plan-types';
import type {LongTermPlanningSource} from './long-term-planning-input';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {dateOffset,parseLongTermPlanSpec,parseLongTermPlanSnapshot} from './long-term-plan-types.ts';

export type LongTermEditorSubject={subjectId:string;name:string;priority:number};
export type LongTermEditorSource=LongTermPlanningSource&{subjects:LongTermEditorSubject[];history:LongTermHistoryEntry[];stamp?:string;todayLocked?:boolean};
export function defaultLongTermSpec(today:string,subjects:LongTermEditorSubject[],planId:string):LongTermPlanSpec{
  const startDate=dateOffset(today,1);
  return{planId,startDate,targetDeadline:dateOffset(startDate,59),timeBudgetMode:'advisory',dailyMinutesBudget:{workdayMin:30,workdayMax:60,weekendMax:90,minReviewRatio:.35},bufferRatio:.15,
    subjectsConfig:subjects.map(subject=>({subjectId:subject.subjectId,priority:subject.priority,completionCriteria:'fixed-rounds'}))};
}
import type {LongTermScheduling} from './long-term-pacing';
export function createLongTermPreview(scheduling:LongTermScheduling){
  const {generateLongTermSchedule,rebalanceScheduleOnDelta}=scheduling;
function previewLongTermPlan(input:{spec:LongTermPlanSpec;previous:LongTermPlanSnapshot|null;source:LongTermEditorSource;today:string;generatedAt:string;preserveToday?:boolean}):LongTermPlanSnapshot{
  const tomorrow=dateOffset(input.today,1),previous=input.previous?.spec.planId===input.spec.planId?input.previous:null;
  const effectiveDay=previous&&input.preserveToday===false&&input.source.todayLocked===false?input.today:tomorrow;
  const asOfDate=previous&&previous.asOfDate>effectiveDay?previous.asOfDate:effectiveDay;
  if(!previous&&input.spec.startDate<tomorrow)throw new Error('long-term-start-tomorrow');
  if(input.spec.targetDeadline<asOfDate)throw new Error('long-term-deadline-future');
  if(previous&&input.spec.startDate!==previous.spec.startDate)throw new Error('long-term-original-start');
  const spec=structuredClone(input.spec),known=new Set(spec.subjectsConfig.map(subject=>subject.subjectId));
  const added=input.source.subjects.filter(subject=>!known.has(subject.subjectId));
  spec.subjectsConfig.push(...added.map(subject=>({subjectId:subject.subjectId,priority:subject.priority,completionCriteria:'fixed-rounds' as const})));
  parseLongTermPlanSpec(spec);
  const options={asOfDate,generatedAt:input.generatedAt};
  const result=generateLongTermSchedule(input.source.inventory,spec,input.source.fsrsMap,options);
  if(previous){
    const frozen=new Map(previous.schedule.filter(slot=>slot.date<asOfDate).map(slot=>[slot.date,slot]));
    result.schedule=result.schedule.map(slot=>structuredClone(frozen.get(slot.date)??slot));
    const oldSubjects=new Set(previous.spec.subjectsConfig.map(subject=>subject.subjectId));
    if(input.source.inventory.every(item=>oldSubjects.has(item.subjectId)))result.activeDriftDays=rebalanceScheduleOnDelta(previous,input.source.inventory,input.source.history,input.source.fsrsMap,{...options,maxProposalExtensionDays:0,maxProposalExtraMinutes:0}).activeDriftDays;
    else{result.activeDriftDays=previous.activeDriftDays;result.warnings.push('drift-context-changed');}
  }
  if(added.length)result.warnings.push('new-subjects-included');
  return parseLongTermPlanSnapshot(result);
}
  return previewLongTermPlan;
}
export type LongTermPreviewInput=Parameters<ReturnType<typeof createLongTermPreview>>[0];
