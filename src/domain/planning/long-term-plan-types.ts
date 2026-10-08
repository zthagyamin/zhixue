import type {PracticeBudgetGroup} from './practice-budget';
// @ts-expect-error TS5097: standalone Node source contracts.
import {parsePracticeBudgetGroups} from './practice-budget.ts';
/** Versioned projection contract. No field grants mastery or changes an actual due date. */
export interface LongTermPlanSpec {
  planId: string;
  startDate: string;
  targetDeadline: string;
  dailyMinutesBudget: { workdayMin: number; workdayMax: number; weekendMax: number; minReviewRatio: number };
  timeBudgetMode?: 'advisory' | 'limit';
  subjectsConfig: Array<{ subjectId: string; priority: number; dailyQuotaTarget?: number; dailyMinimumTarget?: number; completionCriteria: 'all-mastered' | 'fixed-rounds'; requiredRounds?: number; forecastRetention?: number }>;
  bufferRatio: number;
  /** Preferred daily review count; extra due work remains visible and can be added by the learner. */
  dailyReviewTarget?: number;
  practiceBudgetGroups?: PracticeBudgetGroup[];
}
export interface LongTermInventoryItem {
  itemId: string; subjectId: string; sourceHash: string; estimatedMinutes: number;
  reviewMinutes?: number; mastered?: boolean; completedRounds?: number;
  blockedReason?: string; prerequisiteItemIds?: string[];
}
export interface LongTermScheduleOptions {
  asOfDate: string; generatedAt: string; requestRetention?: number;
  requestRetentionBySubject?: Record<string,number>;
  maxProposalExtensionDays?: number; maxProposalExtraMinutes?: number;
}
export interface LongTermHistoryEntry {
  itemId: string; sourceHash: string; date: string; completedRounds?: number; mastered?: boolean;
}
export interface DailyScheduleSlot {
  timeBudgetMode?: 'advisory' | 'limit';
  dayIndex: number; date: string; phase: 'learning' | 'consolidation' | 'final-sprint';
  expectedNewItems: Record<string, number>; projectedReviews: Record<string, number>; isBufferDay: boolean;
  newItemIds: string[]; reviewItemIds: string[]; budgetMinutes: number; learningMinutes: number;
  newItemSourceHashes: Record<string, string>;
  reviewMinutes: number; reviewReserveMinutes: number; unservedReviewMinutes: number; warnings: string[];
}
export interface LongTermAdjustmentProposal {
  kind: 'extend-deadline' | 'increase-budget'; targetDeadline?: string; extraDailyMinutes?: number;
  feasible: boolean; remainingBacklogCount: number;
}
export interface LongTermPlanSnapshot {
  schemaVersion: 1; spec: LongTermPlanSpec; totalInventoryCount: number; estimatedTotalDays: number;
  schedule: DailyScheduleSlot[]; lastRebalancedAt: string; activeDriftDays: number; asOfDate: string;
  inventory: LongTermInventoryItem[];
  backlog: Array<{itemId: string; subjectId: string; sourceHash: string; estimatedMinutes: number; reason: string}>;
  excludedItemIds: string[]; learningCompletedItemIds: string[];
  remainingRequiredRounds: Record<string, number>;
  warnings: string[]; adjustmentProposals: LongTermAdjustmentProposal[];
  forecastAssumptions: {model: 'ts-fsrs'; rating: 'Good'; requestRetention: number; requestRetentionBySubject?:Record<string,number>; enableFuzz: false; granularity: 'daily'; projectionOnly: true};
}
export const MAX_LONG_TERM_DAYS = 730;
export function assertPlan(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`invalid-long-term-plan: ${message}`);
}
export function parsePlanDate(value: unknown): string {
  assertPlan(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.startsWith('0000'), 'date');
  const date = new Date(`${value}T00:00:00.000Z`);
  assertPlan(Number.isFinite(date.valueOf()) && date.toISOString().slice(0,10) === value, 'date');
  return value;
}
export function dateOffset(date: string, days: number): string {
  return new Date(new Date(`${parsePlanDate(date)}T00:00:00Z`).valueOf() + days * 86400000).toISOString().slice(0,10);
}
export function daysBetween(start: string, end: string): number {
  return (Date.parse(`${parsePlanDate(end)}T00:00:00Z`) - Date.parse(`${parsePlanDate(start)}T00:00:00Z`))/86400000;
}
function record(value: unknown): asserts value is Record<string, unknown> { assertPlan(value !== null && typeof value === 'object' && !Array.isArray(value), 'object'); }
function id(value: unknown): asserts value is string { assertPlan(typeof value === 'string' && value.trim().length > 0 && value.length <= 500 && !['__proto__','constructor','prototype'].includes(value), 'id'); }
function num(value: unknown, max = 1e9): asserts value is number { assertPlan(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max, 'number'); }
function integer(value: unknown, max = 1e9): asserts value is number { num(value,max); assertPlan(Number.isInteger(value),'integer'); }
function strings(value: unknown): asserts value is string[] { assertPlan(Array.isArray(value),'array'); value.forEach(id); }
function timestamp(value: unknown) { assertPlan(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value)), 'timestamp'); parsePlanDate(value.slice(0,10)); assertPlan(Number(value.slice(11,13))<24 && Number(value.slice(14,16))<60 && Number(value.slice(17,19))<60,'timestamp'); }
export function parseLongTermPlanSpec(value: unknown): LongTermPlanSpec {
  record(value); id(value.planId); parsePlanDate(value.startDate); parsePlanDate(value.targetDeadline);
  const days = daysBetween(value.startDate as string,value.targetDeadline as string)+1;
  assertPlan(days>0 && days<=MAX_LONG_TERM_DAYS,'horizon'); record(value.dailyMinutesBudget);
  const b=value.dailyMinutesBudget; num(b.workdayMin,1440);num(b.workdayMax,1440);num(b.weekendMax,1440);num(b.minReviewRatio,1);
  assertPlan(b.workdayMin<=b.workdayMax,'minimum budget');num(value.bufferRatio,1);
  if(value.timeBudgetMode!==undefined)assertPlan(['advisory','limit'].includes(value.timeBudgetMode as string),'time budget mode');
  if(value.dailyReviewTarget!==undefined)integer(value.dailyReviewTarget,10000);
  if(value.practiceBudgetGroups!==undefined)parsePracticeBudgetGroups(value.practiceBudgetGroups);
  assertPlan(Array.isArray(value.subjectsConfig),'subjects'); const ids=new Set();
  for(const s of value.subjectsConfig) {record(s);id(s.subjectId);assertPlan(!ids.has(s.subjectId),'duplicate subject');ids.add(s.subjectId);integer(s.priority,5);assertPlan(s.priority>=1,'priority');if(s.forecastRetention!==undefined){num(s.forecastRetention,.99);assertPlan(s.forecastRetention>=.7,'retention');}if(s.dailyQuotaTarget!==undefined)integer(s.dailyQuotaTarget);if(s.requiredRounds!==undefined){integer(s.requiredRounds,1000);assertPlan(s.requiredRounds>0,'rounds');}assertPlan(['all-mastered','fixed-rounds'].includes(s.completionCriteria as string),'criteria');}
  for(const s of value.subjectsConfig)if(s.dailyMinimumTarget!==undefined){integer(s.dailyMinimumTarget,10000);assertPlan(s.dailyMinimumTarget<=(s.dailyQuotaTarget??Infinity),'minimum exceeds cap');}
  return structuredClone(value) as unknown as LongTermPlanSpec;
}
export function parseLongTermInventory(value: unknown, spec?: LongTermPlanSpec): LongTermInventoryItem[] {
  assertPlan(Array.isArray(value) && value.length<=100000,'inventory');const ids=new Set();
  for(const i of value){record(i);id(i.itemId);id(i.subjectId);id(i.sourceHash);assertPlan(!ids.has(i.itemId),'duplicate item');ids.add(i.itemId);num(i.estimatedMinutes);assertPlan(i.estimatedMinutes>0,'item minutes');if(i.reviewMinutes!==undefined){num(i.reviewMinutes);assertPlan(i.reviewMinutes>0,'review minutes');}if(i.completedRounds!==undefined)integer(i.completedRounds);if(i.mastered!==undefined)assertPlan(typeof i.mastered==='boolean','mastered');if(spec)assertPlan(spec.subjectsConfig.some(s=>s.subjectId===i.subjectId),'unconfigured subject');}
  for(const i of value){if(i.blockedReason!==undefined)id(i.blockedReason);if(i.prerequisiteItemIds!==undefined){strings(i.prerequisiteItemIds);assertPlan(new Set(i.prerequisiteItemIds).size===i.prerequisiteItemIds.length,'duplicate prerequisite');for(const key of i.prerequisiteItemIds)assertPlan(ids.has(key)&&key!==i.itemId,'prerequisite');}}
  return structuredClone(value) as LongTermInventoryItem[];
}
export function parseLongTermScheduleOptions(value: LongTermScheduleOptions): LongTermScheduleOptions {
  record(value);parsePlanDate(value.asOfDate);timestamp(value.generatedAt);
  if(value.requestRetention!==undefined){num(value.requestRetention, .99);assertPlan(value.requestRetention>=.7,'retention');}
  if(value.requestRetentionBySubject!==undefined){record(value.requestRetentionBySubject);for(const [key,retention]of Object.entries(value.requestRetentionBySubject)){id(key);num(retention,.99);assertPlan(retention>=.7,'retention');}}
  if(value.maxProposalExtensionDays!==undefined)integer(value.maxProposalExtensionDays,MAX_LONG_TERM_DAYS);
  if(value.maxProposalExtraMinutes!==undefined)integer(value.maxProposalExtraMinutes,1440);
  return structuredClone(value);
}
export function parseLongTermHistory(value: unknown): LongTermHistoryEntry[] {
  assertPlan(Array.isArray(value),'history');for(const e of value){record(e);id(e.itemId);id(e.sourceHash);parsePlanDate(e.date);if(e.completedRounds!==undefined)integer(e.completedRounds);if(e.mastered!==undefined)assertPlan(typeof e.mastered==='boolean','mastered');}return structuredClone(value) as LongTermHistoryEntry[];
}
export function parseLongTermPlanSnapshot(value: unknown): LongTermPlanSnapshot {
  record(value); assertPlan(value.schemaVersion===1,'schema version');const spec=parseLongTermPlanSpec(value.spec);const inventory=parseLongTermInventory(value.inventory,spec);
  parsePlanDate(value.asOfDate);timestamp(value.lastRebalancedAt);assertPlan(typeof value.activeDriftDays==='number' && Number.isFinite(value.activeDriftDays),'drift');
  assertPlan(value.totalInventoryCount===inventory.length,'inventory total');const n=daysBetween(spec.startDate,spec.targetDeadline)+1;assertPlan(value.estimatedTotalDays===n,'days');
  strings(value.excludedItemIds);strings(value.learningCompletedItemIds);strings(value.warnings);record(value.remainingRequiredRounds);
  const byId=new Map(inventory.map(i=>[i.itemId,i])); const seen=new Set<string>();
  const take=(key: string)=>{assertPlan(byId.has(key) && !seen.has(key),'active item accounting');seen.add(key);};
  value.learningCompletedItemIds.forEach(take);assertPlan(new Set(value.excludedItemIds).size===value.excludedItemIds.length,'duplicate excluded');value.excludedItemIds.forEach(key=>assertPlan((value.learningCompletedItemIds as string[]).includes(key),'excluded acquisition'));
  const completedIds=value.learningCompletedItemIds, excludedIds=value.excludedItemIds;
  for(const item of inventory) {
    const subject=spec.subjectsConfig.find(s=>s.subjectId===item.subjectId)!;
    assertPlan(completedIds.includes(item.itemId)===Boolean(item.mastered||(item.completedRounds??0)>0),'completion evidence');
    assertPlan(excludedIds.includes(item.itemId)===Boolean(item.mastered||(subject.completionCriteria==='fixed-rounds'&&(item.completedRounds??0)>=(subject.requiredRounds??1))),'exclusion evidence');
  }
  assertPlan(Array.isArray(value.schedule) && value.schedule.length===n,'schedule');
  for(const [index,s] of value.schedule.entries()) {
    record(s);assertPlan(s.date===dateOffset(spec.startDate,index) && s.dayIndex===index+1,'slot date');assertPlan(['learning','consolidation','final-sprint'].includes(s.phase as string),'phase');assertPlan(typeof s.isBufferDay==='boolean','buffer');
    strings(s.newItemIds);strings(s.reviewItemIds);strings(s.warnings);record(s.expectedNewItems);record(s.projectedReviews);
    record(s.newItemSourceHashes);assertPlan(Object.keys(s.newItemSourceHashes).length===s.newItemIds.length,'assignment sources');
    for(const key of s.newItemIds){assertPlan(Object.hasOwn(s.newItemSourceHashes,key),'assignment source');id(s.newItemSourceHashes[key]);}
    for(const key of ['budgetMinutes','learningMinutes','reviewMinutes','reviewReserveMinutes','unservedReviewMinutes'])num(s[key]);
    if(s.timeBudgetMode!==undefined)assertPlan(['advisory','limit'].includes(s.timeBudgetMode as string),'slot budget mode');
    if(s.timeBudgetMode!=='advisory')assertPlan((s.learningMinutes as number)+(s.reviewMinutes as number)<=(s.budgetMinutes as number)+1e-8,'capacity');
    if((s.date as string)>=(value.asOfDate as string)) {
      const weekend=[0,6].includes(new Date(`${s.date}T00:00:00Z`).getUTCDay());
      const budget=weekend?spec.dailyMinutesBudget.weekendMax:spec.dailyMinutesBudget.workdayMax;
      for(const key of s.newItemIds)assertPlan(s.newItemSourceHashes[key]===byId.get(key)?.sourceHash,'active assignment source');
      assertPlan(s.budgetMinutes===budget && Math.abs((s.reviewReserveMinutes as number)-budget*spec.dailyMinutesBudget.minReviewRatio)<1e-8,'declared budget');
      assertPlan((s.timeBudgetMode??'limit')===(spec.timeBudgetMode??'limit'),'slot budget policy');
      if(spec.timeBudgetMode!=='advisory')assertPlan((s.learningMinutes as number)+Math.max(s.reviewMinutes as number,s.reviewReserveMinutes as number)<=budget+1e-8,'reserved capacity');
      if(s.isBufferDay)for(const subject of spec.subjectsConfig)assertPlan((Object.hasOwn(s.expectedNewItems,subject.subjectId)?s.expectedNewItems[subject.subjectId] as number:0)<=(subject.dailyMinimumTarget??0),'buffer learning');
      for(const key of s.newItemIds){const item=byId.get(key);assertPlan(item&&!item.blockedReason&&(item.prerequisiteItemIds??[]).every(p=>seen.has(p)),'learning eligibility');take(key);}assertPlan(new Set(s.reviewItemIds).size===s.reviewItemIds.length,'duplicate review');
      const count=(keys:string[])=>{const result:Record<string,number>=Object.create(null);for(const key of keys){const item=byId.get(key);assertPlan(item,'unknown item');result[item.subjectId]=(result[item.subjectId]??0)+1;}return result;};
      const sameCounts=(a:Record<string,unknown>,b:Record<string,number>)=>{Object.values(a).forEach(v=>integer(v));assertPlan(Object.keys(a).length===Object.keys(b).length && Object.entries(b).every(([k,v])=>a[k]===v),'counts');};
      sameCounts(s.expectedNewItems,count(s.newItemIds));sameCounts(s.projectedReviews,count(s.reviewItemIds));
      const minimumRemaining=new Map(spec.subjectsConfig.map(subject=>[subject.subjectId,subject.dailyMinimumTarget??0]));let minimumMinutes=0;
      for(const key of s.newItemIds){const item=byId.get(key)!;const left=minimumRemaining.get(item.subjectId)??0;if(left>0){minimumMinutes+=item.estimatedMinutes;minimumRemaining.set(item.subjectId,left-1);}}
      if(spec.timeBudgetMode==='advisory')assertPlan((s.learningMinutes as number)-minimumMinutes<=Math.max(0,budget-Math.max(s.reviewMinutes as number,s.reviewReserveMinutes as number))+1e-8,'optional estimate capacity');
      for(const subject of spec.subjectsConfig)if((subject.dailyMinimumTarget??0)>(Object.hasOwn(s.expectedNewItems,subject.subjectId)?s.expectedNewItems[subject.subjectId] as number:0))assertPlan(s.warnings.includes(`minimum-shortfall:${subject.subjectId}`),'minimum shortfall warning');
      for(const subject of spec.subjectsConfig)assertPlan((Object.hasOwn(s.expectedNewItems,subject.subjectId)?s.expectedNewItems[subject.subjectId] as number:0)<=(subject.dailyQuotaTarget??Infinity),'subject quota');
      assertPlan(Math.abs(s.newItemIds.reduce((sum,key)=>sum+byId.get(key)!.estimatedMinutes,0)-(s.learningMinutes as number))<1e-8,'learning minutes');
      assertPlan(Math.abs(s.reviewItemIds.reduce((sum,key)=>sum+(byId.get(key)!.reviewMinutes??2),0)-(s.reviewMinutes as number))<1e-8,'review minutes');
    }
  }
  assertPlan(Array.isArray(value.backlog),'backlog');for(const b of value.backlog){record(b);id(b.itemId);take(b.itemId);const item=byId.get(b.itemId)!;assertPlan(b.subjectId===item.subjectId&&b.sourceHash===item.sourceHash&&b.estimatedMinutes===item.estimatedMinutes,'backlog identity');id(b.reason);}
  assertPlan(seen.size===inventory.length,'missing active items');
  assertPlan(Object.keys(value.remainingRequiredRounds).length===inventory.length,'round coverage');for(const i of inventory){integer(value.remainingRequiredRounds[i.itemId]);const subject=spec.subjectsConfig.find(s=>s.subjectId===i.subjectId)!;assertPlan(value.remainingRequiredRounds[i.itemId]===Math.max(0,(subject.requiredRounds??1)-(i.completedRounds??0)),'round count');}
  assertPlan(Array.isArray(value.adjustmentProposals),'proposals');for(const p of value.adjustmentProposals){record(p);assertPlan(typeof p.feasible==='boolean','proposal feasibility');integer(p.remainingBacklogCount);assertPlan(!p.feasible||p.remainingBacklogCount===0,'proposal backlog');if(p.kind==='extend-deadline'){parsePlanDate(p.targetDeadline);assertPlan((p.targetDeadline as string)>spec.targetDeadline && daysBetween(spec.startDate,p.targetDeadline as string)<MAX_LONG_TERM_DAYS && p.extraDailyMinutes===undefined,'proposal deadline');}else{assertPlan(p.kind==='increase-budget','proposal kind');integer(p.extraDailyMinutes,1440);assertPlan(p.extraDailyMinutes>0 && p.targetDeadline===undefined,'proposal budget');}}
  record(value.forecastAssumptions);const a=value.forecastAssumptions;assertPlan(a.model==='ts-fsrs'&&a.rating==='Good'&&a.enableFuzz===false&&a.granularity==='daily'&&a.projectionOnly===true,'assumptions');num(a.requestRetention,.99);assertPlan(a.requestRetention>=.7,'retention');
  if(a.requestRetentionBySubject!==undefined){record(a.requestRetentionBySubject);for(const [key,retention]of Object.entries(a.requestRetentionBySubject)){id(key);num(retention,.99);assertPlan(retention>=.7,'retention');}}
  for(const subject of spec.subjectsConfig)if(subject.forecastRetention!==undefined)assertPlan((a.requestRetentionBySubject as Record<string,number>|undefined)?.[subject.subjectId]===subject.forecastRetention,'subject retention assumption');
  return structuredClone(value) as unknown as LongTermPlanSnapshot;
}
