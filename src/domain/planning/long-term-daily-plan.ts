import type {DailyPlanningInput} from './task-plan-types';
import type {LongTermPlanSnapshot} from './long-term-plan-types';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {buildLongTermPlanningInput} from './long-term-planning-input.ts';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {deriveLongTermDailyAllocation,parseLongTermDailyAllocation} from './long-term-daily-allocation.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {reconcileDailyMinimums} from './daily-minimum-reconcile.ts';
export function applyLongTermPlan(input:DailyPlanningInput,snapshot:LongTermPlanSnapshot|null):DailyPlanningInput{
 const {longTermAllocation:old,...base}=input;void old;
 // A day's issued allocation is authoritative for that day. Future edits or pauses cannot replace it.
 // Rebuilding evidence still updates due reviews and validates source identities in the daily engine.
 if(input.previous?.day===input.day)return input.previous.longTermAllocation
  ?{...base,longTermAllocation:parseLongTermDailyAllocation(input.previous.longTermAllocation)}:base;
 const allocation=snapshot?deriveLongTermDailyAllocation(snapshot,buildLongTermPlanningInput(base).bindings,input.day):null;
 const applied=allocation?{...base,longTermAllocation:allocation}:base;
 return allocation&&snapshot?.spec.timeBudgetMode==='advisory'&&snapshot.spec.subjectsConfig.some(s=>s.dailyMinimumTarget!==undefined)
  ?reconcileDailyMinimums(applied,snapshot):applied;
}
