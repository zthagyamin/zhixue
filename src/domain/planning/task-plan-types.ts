import type {LongTermDailyAllocation} from './long-term-daily-allocation';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {parseLongTermDailyAllocation} from './long-term-daily-allocation.ts';
import type { PlanCandidate } from './daily-plan';
import type {StudyEventV3} from '../evidence';

export const TASK_PLANNING_CAPABILITY = 'task-planning-v1';
export type CompletionRule = 'three-stage' | 'graded-practice' | 'self-report'
  | 'formal-mastered' | 'formal-done' | 'formal-completed-reference';
export type TaskAction = {kind:'practice';itemKeys:string[]}
  | {kind:'open-note';contentRef:string} | {kind:'manual'};
export type LearningUnit = {
  unitId:string;subjectId:string;title:string;order:number;sourceHash:string;
  prerequisites:string[];action:TaskAction;completionRule:CompletionRule;
  estimatedMinutes?:number;stateRef?:string;abilityId?:string;formalComplete?:boolean;
  /** Explicit planning metadata only; display titles may be derived from source bodies. */
  planningLabel?:string;
  /** Derived practice/self-report coverage; never substitutes for formalComplete. */
  taskComplete?:boolean;
};
export type SubjectGoal = {
  goalId:string;subjectId:string;title:string;kind:'daily'|'weekly'|'deadline';targetCount:number;
  unitIds:string[];startOn:string;dueOn?:string;priority:number;required:boolean;
  completionBasis:'practice-round'|'self-report'|'formal-state';
};
export type PlanningWord = {
  itemKey:string;subjectId:string;word:string;language:string;sourceHash:string;
  legacyKeys?:string[];
  completionRule:'three-stage'|'graded-practice';
};
export type PlanningSubject = {
  subjectId:string;name:string;priority:number;lastProgressAt?:string;
  planningStatus?:'none'|'ready'|'invalid';
  words:PlanningWord[];units:LearningUnit[];goals:SubjectGoal[];
};
export type PlanningCatalog = {
  schemaVersion:1;sourceHash:string;subjects:PlanningSubject[];
  practiceSources?:PlanningPracticeSource[];
  diagnostics:{code:string;message:string;subjectId?:string}[];
};
export type PlanningPracticeSource={itemKey:string;subjectId:string;title:string;sourceHash:string;completionRule:CompletionRule};
export type SourceReviewState={enabled:boolean;dueAt:string|null};
export type CurrentSourceReview={itemKey:string;subjectId:string;completionRule:CompletionRule;sourceHash:string;state:SourceReviewState};
export type TimedReviewDemand={roundId:string;itemKey:string;subjectId:string;dueAt:string;observedAt:string;completionRule:CompletionRule;blockedReason?:string};
export type PlanningEvidence={schemaVersion:1;eventId:string;coreHash:string;evidenceHash:string;word?:PlanningWord;itemSource?:{itemKey:string;subjectId:string;sourceHash:string};beforeReview?:SourceReviewState;afterReview?:SourceReviewState};
export type PlanningEvidenceRecord={event:StudyEventV3;subjectId:string;planningEvidence?:PlanningEvidence};
export type PlanningContext={catalog:PlanningCatalog;sourceReviews:CurrentSourceReview[];captureReviews:TimedReviewDemand[];observedAt:string;planRevision:number;capabilities:string[]};
export type PlanningEvidencePage={records:PlanningEvidenceRecord[];sourceHash:string;planRevision:number;snapshotHash:string;nextCursor:string|null};
export type WordLearning = {
  lexemeKey:string;itemKeys:string[];status:'unseen'|'initial-in-progress'|'learned'|'history-unknown';
  firstStartedAt?:string;firstLearnedAt?:string;
  firstStartedItemKey?:string;firstLearnedItemKey?:string;
};
export type ReviewObligation = {
  roundId:string;itemKey:string;subjectId:string;dueAt:string;completed:boolean;
  completionRule:CompletionRule;blockedReason?:string;
  retryDueAt?:string;completedAt?:string;anchorEventId?:string;
  /** Other source/capture IDs satisfied by this same physical review round. */
  aliasRoundIds?:string[];
  observedAt?:string;
};
export type TaskCompletion = {
  day?:string;
  taskId:string;unitId?:string;occurredAt:string;basis:'practice-round'|'self-report'|'formal-state';
};
export type DailyTask = {
  taskId:string;subjectId:string;title:string;category:'new-word'|'review'|'subject';
  origin:'fixed'|'goal'|'ai'|'manual'|'fallback';required:boolean;goalId?:string;
  unitIds:string[];quantity:number;action:TaskAction;completionRule:CompletionRule;sourceHash:string;
  estimatedMinutes?:number;reviewRoundId?:string;blockedReason?:string;
};
export type TaskPlanV2 = {
  longTermAllocation?:LongTermDailyAllocation;
  schemaVersion:2;day:string;planHash:string;inputHash:string;sourceHash:string;draftVersion:number;
  tasks:DailyTask[];vocabulary:{target:number;assignedLexemeKeys:string[];manualSelection?:boolean;snapshot?:PlanningWord[];excludedLexemeKeys?:string[];lockedLexemeKeys?:string[];lockedItemKeys?:string[];excludedItemKeys?:string[]};
  manual:{lockedTaskIds:string[];excludedUnitIds:string[];order?:string[]};optionalMinutes?:number;
};
export type PlanDocument = PlanCandidate | TaskPlanV2;
export type DailyPlanningInput = {
  longTermAllocation?:LongTermDailyAllocation;
  day:string;catalog:PlanningCatalog;words:WordLearning[];reviews:ReviewObligation[];
  completions:TaskCompletion[];previous:TaskPlanV2|null;optionalMinutes?:number;
  wordIdentities?:PlanningWord[];
};
export type TaskEventV1 = {
  schemaVersion:1;eventType:'task-completed';eventId:string;coreHash:string;
  taskId:string;subjectId:string;day:string;occurredAt:string;unitIds:string[];
  source:'self-report'|'evidence';evidenceRefs:string[];
};
export type SuggestionRequest = {
  day:string;sourceHash:string;draftVersion:number;excludedUnitIds:string[];selectedUnitIds:string[];
  optionalMinutes?:number;intent:'standard'|'less'|'more';
};
export type SuggestionResponse = {
  day:string;sourceHash:string;draftVersion:number;mode:'ai'|'fallback';
  selections:{unitIds:string[];reason:string}[];message:string;
};

export function supportsTaskPlanning(value:unknown):boolean {
  return Array.isArray(value) && value.includes(TASK_PLANNING_CAPABILITY);
}
export function isTaskPlan(value:unknown):value is TaskPlanV2 {
  return value !== null && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 2;
}

const completionRules:CompletionRule[] = ['three-stage','graded-practice','self-report','formal-mastered','formal-done','formal-completed-reference'];
function fail(code:string):never {throw new Error(code);}
function object(value:unknown,required:string[],optional:string[],code:string):Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`invalid-${code}`);
  const record = value as Record<string,unknown>;
  if (Object.keys(record).some(key=>![...required,...optional].includes(key))) fail(`unknown-${code}-field`);
  if (required.some(key=>record[key] === undefined)) fail(`missing-${code}-field`);
  return record;
}
function text(value:unknown,code:string):asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 4000
    || [...value].some(char=>char.charCodeAt(0)<32 || char.charCodeAt(0)===127)) fail(code);
}
function integer(value:unknown,min:number,code:string):asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) fail(code);
}
function strings(value:unknown,code:string,nonempty=false):string[] {
  if (!Array.isArray(value) || (nonempty && !value.length)) fail(code);
  value.forEach(item=>text(item,code));
  if (new Set(value).size !== value.length) fail('duplicate-plan-value');
  return value as string[];
}
export function validPlanDay(value:unknown):value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const time=Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0,10) === value;
}
function hash(value:unknown):void {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('invalid-plan-hash');
}
function action(value:unknown):void {
  if (!value || typeof value !== 'object' || !('kind' in value)) fail('invalid-task-action');
  if (value.kind === 'practice') {
    const record=object(value,['kind','itemKeys'],[],'action');
    strings(record.itemKeys,'invalid-task-action',true);
  } else if (value.kind === 'open-note') {
    const record=object(value,['kind','contentRef'],[],'action');
    text(record.contentRef,'invalid-task-action');
  } else if (value.kind === 'manual') object(value,['kind'],[],'action');
  else fail('invalid-task-action');
}
export function parseDailyTask(value:unknown):DailyTask {
  const task=object(value,['taskId','subjectId','title','category','origin','required','unitIds','quantity','action','completionRule','sourceHash'],['goalId','estimatedMinutes','reviewRoundId','blockedReason'],'task');
  for (const key of ['taskId','subjectId','title']) text(task[key],`invalid-${key}`);
  if (typeof task.category !== 'string' || !['new-word','review','subject'].includes(task.category)) fail('invalid-task-category');
  if (typeof task.origin !== 'string' || !['fixed','goal','ai','manual','fallback'].includes(task.origin)) fail('invalid-task-origin');
  if (typeof task.required !== 'boolean') fail('invalid-task-required');
  if (!completionRules.includes(task.completionRule as CompletionRule)) fail('invalid-completion-rule');
  integer(task.quantity,1,'invalid-task-quantity');
  strings(task.unitIds,'invalid-task-units');
  action(task.action);hash(task.sourceHash);
  if (task.category === 'review' && (task.required !== true || !task.reviewRoundId)) fail('required-review');
  for (const key of ['goalId','reviewRoundId','blockedReason']) if (task[key] !== undefined) text(task[key],`invalid-${key}`);
  if (task.estimatedMinutes !== undefined) integer(task.estimatedMinutes,0,'invalid-task-estimate');
  return structuredClone(task) as DailyTask;
}
export function parseWordSnapshot(value:unknown):PlanningWord {
  const word=object(value,['itemKey','subjectId','word','language','sourceHash','completionRule'],['legacyKeys'],'word-snapshot');
  for (const key of ['itemKey','subjectId','word','language']) text(word[key],'invalid-word-snapshot');
  hash(word.sourceHash);
  if (typeof word.completionRule!=='string' || !['three-stage','graded-practice'].includes(word.completionRule)) fail('invalid-word-completion-rule');
  if (word.legacyKeys!==undefined) strings(word.legacyKeys,'invalid-word-alias');
  return structuredClone(word) as PlanningWord;
}

/** Strict wire validation. No unknown completion fields can become authoritative. */
export function parseTaskPlan(value:unknown):TaskPlanV2 {
  if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 2) fail('unsupported-task-plan-version');
  const plan=object(value,['schemaVersion','day','planHash','inputHash','sourceHash','draftVersion','tasks','vocabulary','manual'],['optionalMinutes','longTermAllocation'],'plan');
  if (!validPlanDay(plan.day)) fail('invalid-plan-day');
  for (const key of ['planHash','inputHash','sourceHash']) hash(plan[key]);
  integer(plan.draftVersion,0,'invalid-draft-version');
  if (plan.optionalMinutes !== undefined) integer(plan.optionalMinutes,0,'invalid-optional-minutes');
  if (!Array.isArray(plan.tasks)) fail('invalid-plan-tasks');
  const ids=new Set<string>();
  for (const raw of plan.tasks) {
    const task=parseDailyTask(raw);
    if (ids.has(task.taskId)) fail('duplicate-task-id');
    ids.add(task.taskId);
  }
  const vocabulary=object(plan.vocabulary,['target','assignedLexemeKeys'],['manualSelection','snapshot','excludedLexemeKeys','lockedLexemeKeys','lockedItemKeys','excludedItemKeys'],'vocabulary');
  const allocation=plan.longTermAllocation===undefined?undefined:parseLongTermDailyAllocation(plan.longTermAllocation);
  if (allocation && allocation.day!==plan.day) fail('invalid-long-term-allocation-day');
  if (vocabulary.target !== (allocation?.vocabularyTarget??20)) fail('invalid-new-word-target');
  strings(vocabulary.assignedLexemeKeys,'invalid-new-word-assignment');
  if (vocabulary.excludedLexemeKeys!==undefined) strings(vocabulary.excludedLexemeKeys,'invalid-excluded-words');
  if (vocabulary.lockedLexemeKeys!==undefined) strings(vocabulary.lockedLexemeKeys,'invalid-locked-words');
  if (vocabulary.lockedItemKeys!==undefined) strings(vocabulary.lockedItemKeys,'invalid-locked-word-items');
  if (vocabulary.excludedItemKeys!==undefined) strings(vocabulary.excludedItemKeys,'invalid-excluded-word-items');
  if (vocabulary.manualSelection!==undefined && typeof vocabulary.manualSelection!=='boolean') fail('invalid-word-selection-mode');
  if (vocabulary.snapshot!==undefined) {
    if (!Array.isArray(vocabulary.snapshot)) fail('invalid-word-snapshot');
    const words=vocabulary.snapshot.map(parseWordSnapshot);
    if (new Set(words.map(word=>word.itemKey)).size!==words.length) fail('duplicate-word-snapshot');
  }
  const manual=object(plan.manual,['lockedTaskIds','excludedUnitIds'],['order'],'manual');
  const locks=strings(manual.lockedTaskIds,'invalid-task-lock');
  strings(manual.excludedUnitIds,'invalid-task-exclusion');
  if (locks.some(id=>!ids.has(id))) fail('unknown-locked-task');
  if (manual.order!==undefined && strings(manual.order,'invalid-task-order').some(id=>!ids.has(id))) fail('unknown-ordered-task');
  return structuredClone(plan) as TaskPlanV2;
}
