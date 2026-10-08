import type {PlanningWord} from './task-plan-types';
import type {LongTermPlanSpec} from './long-term-plan-types';
// @ts-expect-error TS5097: standalone Node contracts.
import {lexemeKey} from './vocabulary-learning.ts';

export type MinimumProgressPlan={
  vocabulary:{snapshot?:ReadonlyArray<PlanningWord>};
  tasks:ReadonlyArray<{category:string;blockedReason?:string;action:{kind:string;itemKeys?:readonly string[]}}>;
};
export type DailyMinimumProgress={subjectId:string;minimum:number;assigned:number;blocked:number;missing:number};
/** Display contract is separate from the immutable physical allocation count. */
export function dailyMinimumProgress(spec:LongTermPlanSpec|null,plan:MinimumProgressPlan|null,day:string):DailyMinimumProgress[]{
  if(!spec||day<spec.startDate||day>spec.targetDeadline)return [];
  const blocked=new Set(plan?.tasks.filter(t=>t.category==='new-word'&&t.blockedReason).flatMap(t=>t.action.itemKeys??[])??[]);
  const unique=new Map<string,{subjectId:string;blocked:boolean}>();
  for(const word of plan?.vocabulary.snapshot??[])if(!unique.has(lexemeKey(word)))unique.set(lexemeKey(word),{subjectId:word.subjectId,blocked:blocked.has(word.itemKey)});
  return spec.subjectsConfig.filter(s=>(s.dailyMinimumTarget??0)>0).map(subject=>{
    const assigned=[...unique.values()].filter(w=>w.subjectId===subject.subjectId),waiting=assigned.filter(w=>w.blocked).length;
    return {subjectId:subject.subjectId,minimum:subject.dailyMinimumTarget!,assigned:assigned.length,blocked:waiting,
      missing:Math.max(0,subject.dailyMinimumTarget!-assigned.length+waiting)};
  });
}
