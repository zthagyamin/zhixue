import type {LongTermPlanSpec} from './long-term-plan-types';

/** Explicit editor conversion; never runs while loading an existing saved plan. */
export function withMinimumWordTargets(spec:LongTermPlanSpec, wordSubjects:readonly string[]):LongTermPlanSpec {
  const next=structuredClone(spec), ids=new Set(wordSubjects);
  next.timeBudgetMode='advisory';
  for(const subject of next.subjectsConfig)if(ids.has(subject.subjectId)){
    subject.dailyMinimumTarget??=subject.dailyQuotaTarget??0;
    subject.dailyQuotaTarget??=subject.dailyMinimumTarget;
  }
  return next;
}
