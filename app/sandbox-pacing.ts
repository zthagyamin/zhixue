import type {LongTermInventoryItem,LongTermPlanSpec} from './long-term-plan-types';
// @ts-expect-error Node source tests.
import {dateOffset} from './long-term-plan-types.ts';
// @ts-expect-error Node source tests.
import {generateLongTermSchedule,rebalanceScheduleOnDelta} from './long-term-pacing.ts';
// @ts-expect-error Node source tests.
import {createLongTermReviewForecaster} from './long-term-review-forecast.ts';

export type SandboxScenario='normal'|'add'|'miss';
export const sandboxItemId=(subjectId:string,index:number)=>`demo:${subjectId}:${String(index).padStart(2,'0')}`;
const subjects=[{id:'ielts-vocabulary',count:12},{id:'python-basics',count:6}];
/** Public fixtures only. No transport, persistence, learner history or imported note data. */
export function simulateSandboxPacing({today,days,quota,scenario,wordQuota,practiceQuota,reviewTarget}:{today:string;days:number;quota:number;scenario:SandboxScenario;wordQuota?:number;practiceQuota?:number;reviewTarget?:number}){
 if(![3,7,14].includes(days)||![3,6,9].includes(quota)||!['normal','add','miss'].includes(scenario))throw new Error('invalid sandbox controls');
 for(const value of [wordQuota,practiceQuota,reviewTarget])if(value!==undefined&&(!Number.isInteger(value)||value<0||value>10000))throw new Error('invalid sandbox controls');
 const inventory:LongTermInventoryItem[]=subjects.flatMap(s=>Array.from({length:s.count},(_,index)=>({itemId:sandboxItemId(s.id,index),subjectId:s.id,sourceHash:'public-demo-v1',estimatedMinutes:s.id==='ielts-vocabulary'?1:4,reviewMinutes:s.id==='ielts-vocabulary' ? 0.5 : 2})));
 const spec:LongTermPlanSpec={planId:'public-sandbox',startDate:today,targetDeadline:dateOffset(today,days-1),dailyMinutesBudget:{workdayMin:0,workdayMax:45,weekendMax:45,minReviewRatio:.3},subjectsConfig:subjects.map((s,index)=>({subjectId:s.id,priority:3,dailyQuotaTarget:index===0?(wordQuota??quota*2/3):(practiceQuota??quota/3),completionCriteria:'fixed-rounds',requiredRounds:1})),bufferRatio:0,...(reviewTarget===undefined?{}:{dailyReviewTarget:reviewTarget})};
 const options={asOfDate:today,generatedAt:`${today}T00:00:00Z`,requestRetention:.9,maxProposalExtensionDays:14,maxProposalExtraMinutes:15};
 const baseline=generateLongTermSchedule(inventory,spec,{},options);
 let snapshot=baseline;
 if(scenario!=='normal'){
  const engine=createLongTermReviewForecaster(inventory,{},options);
  const first=baseline.schedule[0].newItemIds;
  first.forEach(id=>engine.learn(id,today));
  const history=first.map(itemId=>({itemId,sourceHash:'public-demo-v1',date:today,completedRounds:1}));
  const extra=scenario==='add'?subjects.flatMap((s,index)=>Array.from({length:index===0?4:2},(_,i)=>({itemId:`extra:${s.id}:${i}`,subjectId:s.id,sourceHash:'hypothetical-note',estimatedMinutes:index===0?1:4,reviewMinutes:index===0 ? 0.5 : 2}))):[];
  snapshot=rebalanceScheduleOnDelta(baseline,[...inventory,...extra],history,engine.snapshot(),{...options,asOfDate:dateOffset(today,scenario==='miss'?2:1)});
 }
 // Applying always starts with day 1 of the selected rhythm. Scenario days are forecasts only.
 return {snapshot,baseline,playableIds:baseline.schedule[0].newItemIds,missedDate:scenario==='miss'?dateOffset(today,1):null};
}

/** Slice only an exact caller-owned public fixture, never data merely labelled demo. */
export function sandboxVisibleSubjects<T extends {id:string;items:unknown[]}>(current:T[],publicFixtures:T[],selected:string[]|null,allowed:boolean):T[]{
 if(!allowed||!selected||current!==publicFixtures)return current;
 const ids=new Set(selected);
 return current.map(s=>({...s,items:s.items.filter((_,index)=>ids.has(sandboxItemId(s.id,index)))}));
}
