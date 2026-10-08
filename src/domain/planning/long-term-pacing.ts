import type { CloudFSRSData } from '../evidence';
import type { LongTermInventoryItem, LongTermPlanSpec, LongTermScheduleOptions, LongTermPlanSnapshot, DailyScheduleSlot, LongTermHistoryEntry } from './long-term-plan-types';
// @ts-expect-error Node strip-types tests require the source extension.
import { assertPlan, dateOffset, daysBetween, parseLongTermPlanSpec, parseLongTermInventory, parseLongTermScheduleOptions, parseLongTermPlanSnapshot, parseLongTermHistory, MAX_LONG_TERM_DAYS } from './long-term-plan-types.ts';

import type {LongTermReviewFactory} from './forecast-contracts';

export function createLongTermScheduling(createLongTermReviewForecaster:LongTermReviewFactory){
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const sum=(items:LongTermInventoryItem[])=>items.reduce((n,i)=>n+(i.reviewMinutes??2),0);
function build(inventory:LongTermInventoryItem[],spec:LongTermPlanSpec,fsrsMap:Record<string,CloudFSRSData>,options:LongTermScheduleOptions,past:DailyScheduleSlot[]=[],drift=0,missed=false):LongTermPlanSnapshot {
  const n=daysBetween(spec.startDate,spec.targetDeadline)+1, subjects=new Map(spec.subjectsConfig.map(s=>[s.subjectId,s]));
  const completed=inventory.filter(i=>i.mastered||(i.completedRounds??0)>0).map(i=>i.itemId);
  const excluded=inventory.filter(i=>i.mastered||(subjects.get(i.subjectId)!.completionCriteria==='fixed-rounds'&&(i.completedRounds??0)>=(subjects.get(i.subjectId)!.requiredRounds??1))).map(i=>i.itemId);
  const todo=inventory.filter(i=>!completed.includes(i.itemId));
  const retentionBySubject=Object.fromEntries(spec.subjectsConfig.filter(subject=>subject.forecastRetention!==undefined).map(subject=>[subject.subjectId,subject.forecastRetention!]));
  const engine=createLongTermReviewForecaster(inventory,fsrsMap,{...options,requestRetentionBySubject:{...options.requestRetentionBySubject,...retentionBySubject}});
  const acquired=new Set(completed);
  const schedule=structuredClone(past);const spent:Record<string,number>=Object.create(null);const bufferCount=Math.floor(n*spec.bufferRatio);
  // Missing cards on genuinely completed items use a clearly labelled seed projection.
  for(const item of inventory.filter(i=>completed.includes(i.itemId)))engine.learn(item.itemId,options.asOfDate);
  for(let index=past.length;index<n;index++) {
    const date=dateOffset(spec.startDate,index), weekend=[0,6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
    const budget=weekend?spec.dailyMinutesBudget.weekendMax:spec.dailyMinutesBudget.workdayMax;
    const buffer=Math.floor((index+1)*bufferCount/n)>Math.floor(index*bufferCount/n);
    const reserve=budget*spec.dailyMinutesBudget.minReviewRatio;
    const slot:DailyScheduleSlot={dayIndex:index+1,date,phase:index/n>=.9?'final-sprint':index/n>=.75?'consolidation':'learning',expectedNewItems:Object.create(null),projectedReviews:Object.create(null),isBufferDay:buffer,newItemIds:[],newItemSourceHashes:Object.create(null),reviewItemIds:[],budgetMinutes:budget,learningMinutes:0,reviewMinutes:0,reviewReserveMinutes:reserve,unservedReviewMinutes:0,warnings:[]};
    if(spec.timeBudgetMode)slot.timeBudgetMode=spec.timeBudgetMode;
    if(date<options.asOfDate){slot.warnings.push('elapsed-without-projection');schedule.push(slot);continue;}
    for(const item of engine.pending(date)) {const minutes=item.reviewMinutes??2;if((spec.timeBudgetMode==='advisory'||slot.reviewMinutes+minutes<=budget)&&slot.reviewItemIds.length<(spec.dailyReviewTarget??Infinity)){slot.reviewItemIds.push(item.itemId);slot.reviewMinutes+=minutes;slot.projectedReviews[item.subjectId]=(slot.projectedReviews[item.subjectId]??0)+1;engine.review(item.itemId,date);}}
    slot.unservedReviewMinutes=sum(engine.pending(date));
    const learningCapacity=Math.max(0,budget-Math.max(reserve,slot.reviewMinutes));
    const eligible=(i:LongTermInventoryItem)=>!i.blockedReason&&(i.prerequisiteItemIds??[]).every(key=>acquired.has(key));
    const fits=(i:LongTermInventoryItem)=>i.estimatedMinutes+slot.learningMinutes<=learningCapacity+1e-8;
    const take=(item:LongTermInventoryItem)=>{slot.newItemIds.push(item.itemId);slot.newItemSourceHashes[item.itemId]=item.sourceHash;acquired.add(item.itemId);slot.learningMinutes+=item.estimatedMinutes;slot.expectedNewItems[item.subjectId]=(slot.expectedNewItems[item.subjectId]??0)+1;spent[item.subjectId]=(spent[item.subjectId]??0)+item.estimatedMinutes;todo.splice(todo.indexOf(item),1);engine.learn(item.itemId,date);};
    while(true){
      const required=todo.filter(i=>eligible(i)&&(slot.expectedNewItems[i.subjectId]??0)<(subjects.get(i.subjectId)!.dailyMinimumTarget??0)&&(spec.timeBudgetMode==='advisory'||fits(i)))
        .sort((a,b)=>subjects.get(b.subjectId)!.priority-subjects.get(a.subjectId)!.priority||compare(a.itemId,b.itemId));
      if(required.length){take(required[0]);continue;}
      const candidates=todo.filter(i=>!buffer&&eligible(i)&&fits(i)&&(slot.expectedNewItems[i.subjectId]??0)<(subjects.get(i.subjectId)!.dailyQuotaTarget??Infinity));
      candidates.sort((a,b)=>(spent[a.subjectId]??0)/subjects.get(a.subjectId)!.priority-(spent[b.subjectId]??0)/subjects.get(b.subjectId)!.priority||subjects.get(b.subjectId)!.priority-subjects.get(a.subjectId)!.priority||compare(a.itemId,b.itemId));
      const item=candidates[0];if(!item)break;
      take(item);
    }
    for(const subject of spec.subjectsConfig)if((slot.expectedNewItems[subject.subjectId]??0)<(subject.dailyMinimumTarget??0))slot.warnings.push(`minimum-shortfall:${subject.subjectId}`);
    if(slot.learningMinutes+Math.max(reserve,slot.reviewMinutes)>budget+1e-8)slot.warnings.push('estimate-over-budget');
    if(slot.unservedReviewMinutes>0)slot.warnings.push('review-overflow');
    if(!weekend&&!buffer&&slot.learningMinutes+slot.reviewMinutes<spec.dailyMinutesBudget.workdayMin)slot.warnings.push('underfilled-workday');schedule.push(slot);
  }
  return {schemaVersion:1,spec:structuredClone(spec),totalInventoryCount:inventory.length,estimatedTotalDays:n,schedule,lastRebalancedAt:options.generatedAt,activeDriftDays:drift,asOfDate:options.asOfDate,inventory:structuredClone(inventory),backlog:todo.map(i=>({itemId:i.itemId,subjectId:i.subjectId,sourceHash:i.sourceHash,estimatedMinutes:i.estimatedMinutes,reason:i.blockedReason??'insufficient-learning-capacity'})),excludedItemIds:excluded,learningCompletedItemIds:completed,remainingRequiredRounds:Object.fromEntries(inventory.map(i=>[i.itemId,Math.max(0,(subjects.get(i.subjectId)!.requiredRounds??1)-(i.completedRounds??0))])),warnings:[...(todo.length?['unassigned-backlog']:[]),...(missed?['three-missed-days']:[]),...(inventory.some(i=>completed.includes(i.itemId)&&(!Object.hasOwn(fsrsMap,i.itemId)||!fsrsMap[i.itemId]))?['completed-without-fsrs-seed-assumption']:[])],adjustmentProposals:[],forecastAssumptions:engine.assumptions};
}
function proposals(plan:LongTermPlanSnapshot,fsrsMap:Record<string,CloudFSRSData>,options:LongTermScheduleOptions,past:DailyScheduleSlot[]=[]) {
  if(!plan.backlog.length&&!plan.schedule.at(-1)!.unservedReviewMinutes)return plan;
  const evaluate=(s:LongTermPlanSpec)=>build(plan.inventory,s,fsrsMap,options,past,plan.activeDriftDays);
  // Proposals are a bounded menu, not a claim of the minimum possible adjustment.
  // If knowledge state blocks work, only show the largest alternative, explicitly infeasible.
  const blocked=plan.backlog.some(b=>plan.inventory.find(i=>i.itemId===b.itemId)?.blockedReason);
  const candidates=(max:number,steps:number[])=>blocked?[max]:[...new Set([...steps.filter(n=>n<max),max])];
  const extension=Math.min(options.maxProposalExtensionDays??60,MAX_LONG_TERM_DAYS-plan.estimatedTotalDays);
  if(extension>0) {let result=plan,selected=extension;for(const days of candidates(extension,[1,3,7,14,30,60,120,365])){selected=days;result=evaluate({...plan.spec,targetDeadline:dateOffset(plan.spec.targetDeadline,days)});if(!result.backlog.length&&!result.schedule.at(-1)!.unservedReviewMinutes)break;}plan.adjustmentProposals.push({kind:'extend-deadline',targetDeadline:dateOffset(plan.spec.targetDeadline,selected),feasible:result.backlog.length===0&&result.schedule.at(-1)!.unservedReviewMinutes===0,remainingBacklogCount:result.backlog.length});}
  const extra=Math.floor(Math.min(options.maxProposalExtraMinutes??120,1440-Math.max(plan.spec.dailyMinutesBudget.workdayMax,plan.spec.dailyMinutesBudget.weekendMax)));
  if(extra>0){let result=plan,selected=extra;for(const minutes of candidates(extra,[5,10,20,30,60,120,240,480])){selected=minutes;result=evaluate({...plan.spec,dailyMinutesBudget:{...plan.spec.dailyMinutesBudget,workdayMax:plan.spec.dailyMinutesBudget.workdayMax+minutes,weekendMax:plan.spec.dailyMinutesBudget.weekendMax+minutes}});if(!result.backlog.length&&!result.schedule.at(-1)!.unservedReviewMinutes)break;}plan.adjustmentProposals.push({kind:'increase-budget',extraDailyMinutes:selected,feasible:result.backlog.length===0&&result.schedule.at(-1)!.unservedReviewMinutes===0,remainingBacklogCount:result.backlog.length});}
  return plan;
}
function generateLongTermSchedule(inventory:LongTermInventoryItem[],spec:LongTermPlanSpec,fsrsMap:Record<string,CloudFSRSData>,options:LongTermScheduleOptions):LongTermPlanSnapshot {
  const s=parseLongTermPlanSpec(spec),o=parseLongTermScheduleOptions(options),items=parseLongTermInventory(inventory,s).sort((a,b)=>compare(a.itemId,b.itemId));
  return parseLongTermPlanSnapshot(proposals(build(items,s,fsrsMap,o),fsrsMap,o));
}
function rebalanceScheduleOnDelta(currentPlan:LongTermPlanSnapshot,newInventory:LongTermInventoryItem[],activeHistory:LongTermHistoryEntry[],fsrsMap:Record<string,CloudFSRSData>,options:LongTermScheduleOptions):LongTermPlanSnapshot {
  const old=parseLongTermPlanSnapshot(currentPlan),o=parseLongTermScheduleOptions(options),history=parseLongTermHistory(activeHistory);
  assertPlan(o.asOfDate>=old.asOfDate,'backward rebalance');
  const items=parseLongTermInventory(newInventory,old.spec).sort((a,b)=>compare(a.itemId,b.itemId));
  for(const item of items){const matching=history.filter(e=>e.itemId===item.itemId&&e.sourceHash===item.sourceHash&&e.date<=o.asOfDate);item.completedRounds=Math.max(item.completedRounds??0,...matching.map(e=>e.completedRounds??0));if(matching.some(e=>e.mastered))item.mastered=true;}
  const past=old.schedule.filter(s=>s.date<o.asOfDate);
  const currentHashes=new Map(items.map(i=>[i.itemId,i.sourceHash]));
  const retainedAssignments=(slot:DailyScheduleSlot)=>slot.newItemIds.filter(key=>currentHashes.get(key)===slot.newItemSourceHashes[key]);
  const plannedIds=new Set([...old.schedule.flatMap(retainedAssignments),...old.backlog.filter(i=>currentHashes.get(i.itemId)===i.sourceHash).map(i=>i.itemId)]);
  const expected=new Set(past.flatMap(retainedAssignments)).size;
  const actual=items.filter(i=>plannedIds.has(i.itemId)&&(i.mastered||(i.completedRounds??0)>0)).length;
  // Historical assignment provenance and rate are stable on same-date replay.
  // Recomputed future capacity must not change the measured historical deficit.
  const assigned=past.reduce((n,s)=>n+retainedAssignments(s).length,0);
  const rate=assigned/Math.max(1,past.filter(s=>retainedAssignments(s).length>0).length)||1;
  const drift=(actual-expected)/rate;
  const missed=[1,2,3].every(d=>{const date=dateOffset(o.asOfDate,-d);return date>=old.spec.startDate&&!history.some(e=>e.date===date&&items.some(i=>i.itemId===e.itemId&&i.sourceHash===e.sourceHash)&&((e.completedRounds??0)>0||e.mastered));});
  return parseLongTermPlanSnapshot(proposals(build(items,old.spec,fsrsMap,o,past,drift,missed),fsrsMap,o,past));
}

  return {generateLongTermSchedule,rebalanceScheduleOnDelta};
}
export type LongTermScheduling=ReturnType<typeof createLongTermScheduling>;
