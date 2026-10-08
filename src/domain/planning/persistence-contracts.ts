import type {PlanCandidate} from './daily-plan';
import type {PlanDocument,TaskPlanV2,PlanningContext,PlanningCatalog,PlanningEvidenceRecord,PlanningWord,TaskEventV1,TaskCompletion,ReviewObligation,DailyPlanningInput} from './task-plan-types';
import type {StudyEventV3} from '../evidence';
// @ts-expect-error TS5097: standalone Node source contracts.
import {parseTaskPlan} from './task-plan-types.ts';
export type TaskDraft={plan:TaskPlanV2;baseRevision:number;dirty:boolean};
export function parseTaskDraft(value:unknown):TaskDraft {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('invalid-task-draft');
  const draft=value as TaskDraft;
  if (Object.keys(draft).some(key=>!['plan','baseRevision','dirty'].includes(key)) || !Number.isSafeInteger(draft.baseRevision)
    || draft.baseRevision<0 || typeof draft.dirty!=='boolean') throw new Error('invalid-task-draft');
  return {plan:parseTaskPlan(draft.plan),baseRevision:draft.baseRevision,dirty:draft.dirty};
}
export type PlanningHistoryStatus='complete'|'not-applicable'|'loading'|'failed';
export type PlanningInputFacts={
  day:string;context:PlanningContext;localEvents:StudyEventV3[];companionRecords:PlanningEvidenceRecord[];taskEvents:TaskEventV1[];
  history:Record<'local'|'cloud'|'companion'|'tasks',PlanningHistoryStatus>;legacyItemKeys:string[];
  previous:TaskPlanV2|null;optionalMinutes?:number;
};
export type CompletionFacts={catalog:PlanningCatalog;events:StudyEventV3[];completions:TaskCompletion[];reviews:ReviewObligation[];
  identities:PlanningWord[];taskEvents:TaskEventV1[]};
export type PlanHistoryEntry<T extends PlanDocument = PlanCandidate> = {
  sequence?: number;
  revision: number;
  decision?: "applied" | "rejected" | "restored" | "migrated";
  inputHash?: string;
  reason?: string;
  undoTarget?: number | null;
  appliedAt?: string;
  after?: T | null;
};
export type CurrentPlanPayload = { revision: number; candidate: PlanCandidate | null; history: PlanHistoryEntry[] };
export type PlanDocumentPayload = {
  revision:number;candidate:PlanDocument|null;
  history:Array<Omit<PlanHistoryEntry,'after'> & {after?:PlanDocument|null}>;
};
export type MutationResult<T extends PlanDocument = PlanCandidate> = { status: "ok" | "stale"; revision?: PlanHistoryEntry<T>; message?: string };
export type PlanningInputComposition={input:DailyPlanningInput;events:StudyEventV3[];completedTaskIds:string[];taskEvents:TaskEventV1[]};
