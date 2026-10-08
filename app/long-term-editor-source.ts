// @ts-expect-error TS5097: standalone Node contracts.
import {completionDay} from '../src/domain/planning/index.ts';
import {createEmptyCard} from 'ts-fsrs';
import type {DailyPlanningInput,CurrentSourceReview} from './task-plan-types';
import type {StudyEventV3} from './study-event-v3';
import type {LongTermEditorSource} from './long-term-editor-model';
import type {VersionedReviewCard} from './long-term-planning-input';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {buildLongTermPlanningInput} from './long-term-planning-input.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {rebuildEventProgress} from './review-projection.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {toCloudFSRSData} from './fsrs-scheduler.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {studyDay,compareEvidenceText} from './vocabulary-learning.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {projectUnitCompletions} from './task-planning-input.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {completionBasis} from './task-plan-engine.ts';

export type LongTermEditorSourceInput={
  input:DailyPlanningInput;events:StudyEventV3[];
  /** Provenance verified against the immutable record's source snapshot, never the current key alone. */
  sourceHashesByEventId:Record<string,string>;sourceReviews?:CurrentSourceReview[];
  /** Observation time of the source snapshot; omitted means the caller guarantees it is current. */
  sourceReviewsObservedAt?:string;stamp?:string;todayLocked?:boolean;
};
/** Read-only forecast adapter. Returned cards include explicitly labelled conditional seeds and must never be persisted as actual FSRS. */
export async function buildLongTermEditorSource({input,events,sourceHashesByEventId,sourceReviews=[],sourceReviewsObservedAt,stamp,todayLocked}:LongTermEditorSourceInput):Promise<LongTermEditorSource>{
  if(sourceReviewsObservedAt!==undefined&&!Number.isFinite(Date.parse(sourceReviewsObservedAt)))throw new Error('invalid-long-term-source-observation-date');
  const conditionalCard=(dueAt:string)=>{
    if(!Number.isFinite(Date.parse(dueAt)))throw new Error('invalid-long-term-source-review-date');
    const card=toCloudFSRSData(createEmptyCard(new Date(dueAt)));card.due=dueAt;return card;
  };
  const sources=[...input.catalog.subjects.flatMap(subject=>subject.words),...input.catalog.practiceSources??[]];
  const current=new Map(sources.map(source=>[source.itemKey,source]));
  // Validate inventory identities before constructing a key-based provenance lookup.
  buildLongTermPlanningInput(input);
  const matched=events.filter(event=>current.has(event.item.key)
    &&Object.hasOwn(sourceHashesByEventId,event.eventId)&&sourceHashesByEventId[event.eventId]===current.get(event.item.key)!.sourceHash
    &&studyDay(event.occurredAt)<=input.day
    &&(event.eventType!=='practice-attempt'||!event.scheduling||studyDay(event.scheduling.reviewedAt)<=input.day));
  const replay=await rebuildEventProgress(matched);
  const cards:Record<string,VersionedReviewCard>=Object.create(null);
  for(const [key,card] of Object.entries(replay.fsrsData))cards[key]={sourceHash:current.get(key)!.sourceHash,card};
  const conditionalKeys=new Set<string>();
  const unknownKeys=new Set(events.filter(event=>current.has(event.item.key)&&studyDay(event.occurredAt)<=input.day
    &&(!Object.hasOwn(sourceHashesByEventId,event.eventId)||!sourceHashesByEventId[event.eventId])).map(event=>event.item.key));
  for(const review of sourceReviews){
    const source=current.get(review.itemKey);
    if(!source||source.subjectId!==review.subjectId||source.sourceHash!==review.sourceHash||!review.state.enabled||!review.state.dueAt)continue;
    if(!Number.isFinite(Date.parse(review.state.dueAt)))throw new Error('invalid-long-term-source-review-date');
    const saved=cards[review.itemKey]?.card;
    // The daily projector applies a source observation before a scheduling attempt at the same instant.
    // A baseline's last_review alone cannot establish that tie ordering; require the verified attempt itself.
    const attemptAfterObservation=sourceReviewsObservedAt!==undefined&&replay.events.some(event=>event.item.key===review.itemKey
      &&event.eventType==='practice-attempt'&&event.scheduling&&(!event.attempt.correct||event.attempt.stageAfter===3)
      &&Date.parse(event.scheduling.reviewedAt)>=Date.parse(sourceReviewsObservedAt));
    if(saved&&(attemptAfterObservation||(saved.last_review&&sourceReviewsObservedAt&&Date.parse(saved.last_review)>Date.parse(sourceReviewsObservedAt))))continue;
    if(saved&&Date.parse(saved.due)===Date.parse(review.state.dueAt))continue;
    // Empty-card parameters represent uncertainty, not a synthetic completed attempt. The known due instant is retained exactly.
    const card=conditionalCard(review.state.dueAt);
    cards[review.itemKey]={sourceHash:source.sourceHash,card};conditionalKeys.add(review.itemKey);
  }
  // Daily practice completions may predate this version; derive them again from the filtered immutable evidence.
  const completions=[...input.completions.filter(entry=>entry.basis!=='practice-round'),
    ...projectUnitCompletions(input.catalog,replay.events,[],input.catalog.subjects.flatMap(subject=>subject.words))];
  const daysByKey=new Map<string,Set<string>>();
  for(const event of replay.events)if(event.eventType==='practice-attempt'&&event.attempt.correct&&event.attempt.stageAfter===3){
    const days=daysByKey.get(event.item.key)??new Set<string>();days.add(studyDay(event.occurredAt));daysByKey.set(event.item.key,days);
  }
  const completedPracticeDays=Object.fromEntries((input.catalog.practiceSources??[]).map(source=>[source.itemKey,{sourceHash:source.sourceHash,days:[...daysByKey.get(source.itemKey)??[]]}]));
  const result:LongTermEditorSource={...buildLongTermPlanningInput({...input,completions},{fsrsByItemKey:cards,completedPracticeDays}),
    subjects:input.catalog.subjects.map(({subjectId,name,priority})=>({subjectId,name,priority})),history:[],
    ...(stamp===undefined?{}:{stamp}),...(todayLocked===undefined?{}:{todayLocked})};
  if(events.some(event=>current.has(event.item.key)&&!matched.includes(event)))result.assumptions.push('未核实来源版本、旧版本或未来记录不计入当前内容的完成轮次与 FSRS 重建。');
  for(const binding of result.bindings){
    const item=result.inventory.find(entry=>entry.itemId===binding.itemId)!;
    if(binding.itemKeys.some(key=>conditionalKeys.has(key))){
      result.diagnostics.push({code:'conditional-review-seed',itemId:item.itemId,message:'保留来源实际到期时间；后续复习使用初始参数的条件预测，参数不是实际学习状态。'});
    }
    if(binding.kind!=='vocabulary'&&binding.itemKeys.some(key=>unknownKeys.has(key))&&(item.completedRounds??0)===0){
      item.blockedReason=[item.blockedReason,'学习记录的来源版本尚未核实，不能按未学内容重新安排获取。'].filter(Boolean).join(' ');
      result.diagnostics.push({code:'unknown-event-source',itemId:item.itemId,message:'同名物理项目有来源版本未知的活动；未继承其状态或完成轮次。'});
    }
    const days=new Set<string>();
    if(binding.kind==='vocabulary'){
      if((item.completedRounds??0)>0)for(const key of binding.itemKeys)for(const day of daysByKey.get(key)??[])days.add(day);
    }else{
      if(binding.itemKeys.length===1&&current.get(binding.itemKeys[0])?.sourceHash===item.sourceHash)for(const day of daysByKey.get(binding.itemKeys[0])??[])days.add(day);
      for(const unitId of binding.unitIds){
        const unit=input.catalog.subjects.flatMap(subject=>subject.units).find(unit=>unit.unitId===unitId)!;
        if(unit.completionRule.startsWith('formal-'))continue; // Current formal state has no invented completion date.
        for(const entry of completions)if(entry.unitId===unitId&&entry.basis===completionBasis(unit)&&completionDay(entry)<=input.day)days.add(completionDay(entry));
      }
    }
    [...days].sort(compareEvidenceText).forEach((date,index)=>result.history.push({itemId:item.itemId,sourceHash:item.sourceHash,date,completedRounds:binding.kind==='vocabulary'?1:index+1}));
  }
  // Unresolved daily obligations are workload facts even when their source version or activity history is incomplete.
  // Consolidate aliases by physical subject/key at the earliest outstanding due, as the daily projector does.
  const demands=new Map<string,{itemKey:string;subjectId:string;dueAt:string;blockedReasons:Set<string>}>();
  for(const review of input.reviews){
    if(review.completed)continue;
    if(!Number.isFinite(Date.parse(review.dueAt)))throw new Error('invalid-long-term-source-review-date');
    const key=JSON.stringify([review.subjectId,review.itemKey]),previous=demands.get(key);
    if(previous){
      if(Date.parse(review.dueAt)<Date.parse(previous.dueAt))previous.dueAt=review.dueAt;
      if(review.blockedReason)previous.blockedReasons.add(review.blockedReason);
    }else demands.set(key,{itemKey:review.itemKey,subjectId:review.subjectId,dueAt:review.dueAt,blockedReasons:new Set(review.blockedReason?[review.blockedReason]:[])});
  }
  for(const demand of demands.values()){
    const binding=result.bindings.find(entry=>entry.subjectId===demand.subjectId&&entry.itemKeys.length===1&&entry.itemKeys[0]===demand.itemKey);
    let item=binding?result.inventory.find(entry=>entry.itemId===binding.itemId):undefined;
    if(!item){
      const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([demand.subjectId,demand.itemKey])));
      const itemId=`review-obligation:${[...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,'0')).join('')}`;
      const subjectId=demand.subjectId;
      if(!result.subjects.some(subject=>subject.subjectId===subjectId))result.subjects.push({subjectId,name:'待核对的复习来源',priority:1});
      // This sentinel is expressly an unresolved obligation identity, not a fabricated current content hash.
      item={itemId,subjectId,sourceHash:'unverified-review-obligation',estimatedMinutes:2,reviewMinutes:2,completedRounds:0,blockedReason:'复习内容来源尚未核实，仅保留已知到期负担。'};
      result.inventory.push(item);result.bindings.push({itemId,subjectId,title:'待核对的到期复习',kind:'practice',itemKeys:[demand.itemKey],unitIds:[]});
    }
    const saved=result.fsrsMap[item.itemId];
    if(!saved||Date.parse(demand.dueAt)<Date.parse(saved.due)){
      result.fsrsMap[item.itemId]=conditionalCard(demand.dueAt);
      result.diagnostics.push({code:'conditional-review-seed',itemId:item.itemId,message:'保留未完成义务的实际到期时间；后续初始参数只是条件预测，不是已观测 FSRS。'});
      conditionalKeys.add(demand.itemKey);
    }
    const blocked=[...demand.blockedReasons];
    if((item.completedRounds??0)===0&&!item.blockedReason)blocked.push('已有未完成复习义务，但缺少可核验的首次完成证据。');
    if(blocked.length)item.blockedReason=[item.blockedReason,...blocked].filter(Boolean).join(' ');
    const identityNote=item.sourceHash==='unverified-review-obligation'?'来源使用 unverified-review-obligation 占位身份，参数仅供条件预测。':'';
    result.diagnostics.push({code:'unresolved-review-obligation',itemId:item.itemId,message:`保留未完成复习义务（${demand.dueAt}）；来源版本未由此推定，完成轮次不变。${identityNote}${blocked.join(' ')}`});
  }
  if(demands.size)result.assumptions.push('未完成的每日复习义务继续计入负担；同一物理项目的别名合并为最早尚未完成的到期日，不据此推定来源版本、初学完成或掌握。');
  if(conditionalKeys.size)result.assumptions.push('仅有当前来源到期时间的项目保留实际到期日；后续采用 FSRS 初始参数作条件估算，稳定性、难度与次数不是实际观测，也不代表完成或掌握。');
  result.assumptions.push('进度历史只记录已完成轮次的真实日期；三天未完成提示不能据此断言三天没有部分学习活动。');
  result.history.sort((a,b)=>compareEvidenceText(a.date,b.date)||compareEvidenceText(a.itemId,b.itemId));
  return result;
}
