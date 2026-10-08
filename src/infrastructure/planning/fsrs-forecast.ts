import { createEmptyCard, fsrs, generatorParameters, Rating, type Card } from 'ts-fsrs';
import type { CloudFSRSData } from '../../domain/evidence';
// @ts-expect-error Node strip-types tests require the source extension.
import { assertPlan, dateOffset, daysBetween, parseLongTermInventory, parseLongTermScheduleOptions, parsePlanDate } from '../../domain/planning/index.ts';
import type { LongTermInventoryItem, LongTermScheduleOptions, LongTermPlanSnapshot } from '../../domain/planning';

/** Isolated mutable simulation; the caller's cards and due queue are never touched. */
export function createLongTermReviewForecaster(inventory: LongTermInventoryItem[], fsrsMap: Record<string,CloudFSRSData>, options: LongTermScheduleOptions) {
  parseLongTermScheduleOptions(options);
  const assumptions:LongTermPlanSnapshot['forecastAssumptions']={model:'ts-fsrs',rating:'Good',requestRetention:options.requestRetention??.9,enableFuzz:false,granularity:'daily',projectionOnly:true};
  if(options.requestRetentionBySubject&&Object.keys(options.requestRetentionBySubject).length)assumptions.requestRetentionBySubject=structuredClone(options.requestRetentionBySubject);
  const schedulers=new Map<number,ReturnType<typeof fsrs>>();
  const schedulerFor=(subjectId:string)=>{const rates=assumptions.requestRetentionBySubject;const retention=rates&&Object.hasOwn(rates,subjectId)?rates[subjectId]:assumptions.requestRetention;let scheduler=schedulers.get(retention);if(!scheduler){scheduler=fsrs(generatorParameters({request_retention:retention,enable_fuzz:false,enable_short_term:false}));schedulers.set(retention,scheduler);}return scheduler;};
  const cards=new Map<string,Card>();const byId=new Map(inventory.map(i=>[i.itemId,i]));
  for(const item of inventory) {
    const c=Object.hasOwn(fsrsMap,item.itemId)?fsrsMap[item.itemId]:undefined;if(!c)continue;
    assertPlan(c && typeof c==='object','FSRS card');parsePlanDate(c.due.slice(0,10));
    const due=new Date(c.due);assertPlan(Number.isFinite(due.valueOf()),'FSRS due');
    if(c.last_review!==undefined){parsePlanDate(c.last_review.slice(0,10));assertPlan(Number.isFinite(Date.parse(c.last_review)),'FSRS last review');}
    for(const field of ['stability','difficulty','elapsed_days','scheduled_days','learning_steps','reps','lapses'] as const)assertPlan(typeof c[field]==='number'&&Number.isFinite(c[field])&&c[field]>=0,'FSRS numeric');
    assertPlan([0,1,2,3].includes(c.state)&&c.difficulty<=10,'FSRS state');
    cards.set(item.itemId,{...c,due,last_review:c.last_review===undefined?undefined:new Date(c.last_review)});
  }
  const advance=(key:string,date:string)=>{
    const now=new Date(`${date}T12:00:00Z`);const card=cards.get(key)??createEmptyCard<Card>(now);
    const result=schedulerFor(byId.get(key)!.subjectId).repeat(card,now)[Rating.Good].card;
    // Daily projections consolidate sub-day learning steps; never create a second same-day unit.
    if(result.due.toISOString().slice(0,10)<=date)result.due=new Date(`${dateOffset(date,1)}T12:00:00Z`);
    cards.set(key,result);
  };
  return {assumptions,
    snapshot():Record<string,CloudFSRSData>{return Object.fromEntries([...cards].map(([id,card])=>[id,{...card,due:card.due.toISOString(),...(card.last_review?{last_review:card.last_review.toISOString()}:{last_review:undefined})}]));},
    pending(date:string){parsePlanDate(date);return [...cards.entries()].filter(([,c])=>c.due.toISOString().slice(0,10)<=date).sort(([a,ca],[b,cb])=>ca.due.valueOf()-cb.due.valueOf()||(a<b?-1:a>b?1:0)).map(([key])=>byId.get(key)!);},
    review:advance,
    learn(key:string,date:string){if(!cards.has(key))advance(key,date);},
  };
}
export function forecastLongTermReviews(inventory:LongTermInventoryItem[],fsrsMap:Record<string,CloudFSRSData>,endDate:string,options:LongTermScheduleOptions) {
  const items=parseLongTermInventory(inventory);parsePlanDate(endDate);const n=daysBetween(options.asOfDate,endDate)+1;assertPlan(n>0&&n<=730,'forecast horizon');
  const engine=createLongTermReviewForecaster(items,fsrsMap,options);const reviews:Array<{date:string;itemId:string;subjectId:string;minutes:number}>=[];
  for(let day=0;day<n;day++){const date=dateOffset(options.asOfDate,day);for(const item of engine.pending(date)){reviews.push({date,itemId:item.itemId,subjectId:item.subjectId,minutes:item.reviewMinutes??2});engine.review(item.itemId,date);}}
  return {assumptions:engine.assumptions,reviews};
}
