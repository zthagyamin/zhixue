// @ts-expect-error TS5097: standalone Node contracts.
import {studyDayBounds,sourceReviewDueAt} from '../src/domain/planning/index.ts';
import type {CloudFSRSData} from './cloud-sync-types';
import type {StudyAttemptEventV3,StudyEventV3} from './study-event-v3';
import type {PlanningCatalog,ReviewObligation,WordLearning,CompletionRule,PlanningEvidenceRecord,PlanningEvidence,
  CurrentSourceReview,SourceReviewState,TimedReviewDemand} from './task-plan-types';
// @ts-expect-error TS5097: Node tests use TypeScript extensions.
import {uniqueStudyEvents,compareEvidenceText} from './vocabulary-learning.ts';
// @ts-expect-error TS5097: Node tests use TypeScript extensions.
import {fromCanonicalFSRSData} from './review-projection.ts';
// @ts-expect-error TS5097: Node tests use TypeScript extensions.
import {scheduleReviewAt} from './fsrs-scheduler.ts';
// @ts-expect-error TS5097: Node tests use TypeScript extensions.
import {validPlanDay} from './task-plan-types.ts';

const sourceState=(state:SourceReviewState):SourceReviewState=>({...state,dueAt:state.dueAt?sourceReviewDueAt(state.dueAt):state.dueAt});
type Round=ReviewObligation & {anchorEventId:string};
export type ReviewProjectionInput={
  day:string;words:WordLearning[];events:StudyEventV3[];previous:ReviewObligation[];catalog:PlanningCatalog;
  sourceReviews?:ReviewObligation[];
  sourceHistory?:PlanningEvidenceRecord[];
  currentSourceReviews?:CurrentSourceReview[];sourceObservedAt?:string;
  timedSourceReviews?:TimedReviewDemand[];
};
function eventTime(event:StudyAttemptEventV3):number {
  return Date.parse(event.scheduling?.reviewedAt??event.occurredAt);
}
function contextFor(key:string,catalog:PlanningCatalog,previous:ReviewObligation[]):{
  subjectId:string;completionRule:CompletionRule;blockedReason?:string;
} {
  const registered=catalog.practiceSources?.find(source=>source.itemKey===key);
  if (registered) return {subjectId:registered.subjectId,completionRule:registered.completionRule};
  for (const subject of catalog.subjects) {
    const word=subject.words.find(word=>word.itemKey===key || word.legacyKeys?.includes(key));
    if (word) return {subjectId:subject.subjectId,completionRule:word.completionRule};
    const unit=subject.units.find(unit=>unit.action.kind==='practice' && unit.action.itemKeys.includes(key));
    if (unit) return {subjectId:subject.subjectId,completionRule:unit.completionRule};
  }
  const old=previous.find(round=>round.itemKey===key);
  return {subjectId:old?.subjectId??'unmapped',completionRule:old?.completionRule??'graded-practice',blockedReason:'资料引用已失效，请同步学习知识库。'};
}
async function roundId(key:string,anchor:string):Promise<string> {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([key,anchor])));
  return `review:${[...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,'0')).join('')}`;
}

/** Replays original due obligations, not just the remaining FSRS queue. */
export async function projectReviewObligations(input:ReviewProjectionInput):Promise<ReviewObligation[]> {
  if (!validPlanDay(input.day)) throw new Error('invalid-plan-day');
  const {start,end}=studyDayBounds(input.day);
  const events=await uniqueStudyEvents(input.events);
  const byId=new Map(events.map(event=>[event.eventId,event]));
  const observations=new Map<string,PlanningEvidence>();
  for (const record of input.sourceHistory??[]) {
    const metadata=record.planningEvidence;
    if (!metadata?.beforeReview && !metadata?.afterReview) continue;
    const event=byId.get(record.event.eventId);
    if (!event || event.eventType!=='practice-attempt' || event.coreHash!==record.event.coreHash
      || event.item.key!==record.event.item.key || metadata.eventId!==event.eventId || metadata.coreHash!==event.coreHash) {
      throw new Error('source-observation-event-mismatch');
    }
    const previous=observations.get(event.eventId);
    if (previous && JSON.stringify(previous)!==JSON.stringify(metadata)) throw new Error('source-observation-conflict');
    observations.set(event.eventId,metadata);
  }
  const groups=new Map<string,StudyEventV3[]>();
  for (const event of events) {
    const records=groups.get(event.item.key)??[];
    records.push(event);groups.set(event.item.key,records);
  }
  for (const source of [...input.sourceReviews??[],...input.currentSourceReviews??[],...input.timedSourceReviews??[]]) {
    if (!groups.has(source.itemKey)) groups.set(source.itemKey,[]);
  }
  const output:ReviewObligation[]=[];
  const resolved=new Set<string>();
  for (const [key,group] of groups) {
    const baselines=group.filter(event=>event.eventType==='review-baseline');
    if (baselines.length>1) throw new Error('second-baseline');
    const baseline=baselines[0];
    const attempts=group.filter((event):event is StudyAttemptEventV3=>event.eventType==='practice-attempt')
      .sort((a,b)=>eventTime(a)-eventTime(b)||compareEvidenceText(a.eventId,b.eventId));
    const context=contextFor(key,input.catalog,input.previous);
    let fsrs:CloudFSRSData|undefined=baseline ? fromCanonicalFSRSData(baseline.baselineState) : undefined;
    let learnedAnchor=baseline?.eventId;
    let lastCompletion:string|undefined;
    let expectedSource:SourceReviewState|undefined;
    let expectedAfterEventId:string|undefined;
    let current:Round|undefined;
    const rounds:Round[]=[];
    const create=async(anchor:string,dueAt:string):Promise<Round>=>{
      const id=await roundId(key,anchor);
      resolved.add(id);
      return {...context,roundId:id,itemKey:key,dueAt,completed:false,anchorEventId:anchor};
    };
    if (baseline && fsrs) current=await create(baseline.eventId,fsrs.due);
    const requireSource=(raw:ReviewObligation)=>{
      const source={...raw,dueAt:sourceReviewDueAt(raw.dueAt)};
      resolved.add(source.roundId);
      for (const alias of source.aliasRoundIds??[]) resolved.add(alias);
      if (current) {
        const aliases=new Set([...current.aliasRoundIds??[],source.roundId,...source.aliasRoundIds??[]]);
        aliases.delete(current.roundId);
        if (aliases.size) current.aliasRoundIds=[...aliases].sort(compareEvidenceText);
        if (Date.parse(source.dueAt)<Date.parse(current.dueAt)) current.dueAt=source.dueAt;
        if (source.blockedReason) current.blockedReason=source.blockedReason;
      } else {
        current={...context,...source,completed:false,completedAt:undefined,anchorEventId:source.anchorEventId??source.roundId};
      }
      learnedAnchor??=current.anchorEventId;
    };
    const observeSource=async(raw:SourceReviewState)=>{
      const state=sourceState(raw);
      const changed=!expectedSource || state.enabled!==expectedSource.enabled || state.dueAt!==expectedSource.dueAt;
      expectedSource=state;
      if (changed) expectedAfterEventId=undefined;
      const observedNextRound=!current && lastCompletion && expectedAfterEventId===lastCompletion;
      if ((!changed && !observedNextRound) || !state.enabled || !state.dueAt) return;
      requireSource({...context,itemKey:key,completed:false,dueAt:state.dueAt,
        ...(lastCompletion?{anchorEventId:lastCompletion}:{}),
        roundId:await roundId(key,`source:${lastCompletion??'initial'}`)});
    };
    for (const source of input.sourceReviews?.filter(source=>source.itemKey===key)??[]) requireSource(source);
    const activate=(at:number)=>{
      if (current && Date.parse(current.dueAt)<=at && !rounds.includes(current)) rounds.push(current);
    };
    type Entry={at:number;id:string;event?:StudyAttemptEventV3;capture?:TimedReviewDemand;source?:CurrentSourceReview};
    const timeline:Entry[]=attempts.map(event=>({at:eventTime(event),id:event.eventId,event}));
    for (const capture of input.timedSourceReviews?.filter(source=>source.itemKey===key)??[]) {
      timeline.push({at:Date.parse(capture.observedAt),id:capture.roundId,capture});
    }
    if (input.currentSourceReviews?.some(source=>source.itemKey===key) && !input.sourceObservedAt) throw new Error('source-observed-at-required');
    for (const source of input.currentSourceReviews?.filter(source=>source.itemKey===key)??[]) {
      timeline.push({at:Date.parse(input.sourceObservedAt!),id:`current:${key}`,source});
    }
    if (timeline.some(entry=>!Number.isFinite(entry.at))) throw new Error('invalid-source-observation-time');
    // A source request at the same instant is observable before the attempt that fulfills it.
    timeline.sort((a,b)=>a.at-b.at||Number(Boolean(a.event))-Number(Boolean(b.event))||compareEvidenceText(a.id,b.id));
    for (const entry of timeline) {
      const {at,event}=entry;
      if (at>=end || (event && Date.parse(event.occurredAt)>=end)) continue;
      if (entry.capture) {requireSource({...entry.capture,completed:false});continue;}
      if (entry.source) {await observeSource(entry.source.state);continue;}
      if (!event) continue;
      const observation=observations.get(event.eventId);
      if (observation?.beforeReview) await observeSource(observation.beforeReview);
      activate(at);
      const completed=event.attempt.correct && event.attempt.stageAfter===3;
      const schedules=event.scheduling && (!event.attempt.correct || completed);
      if (schedules) fsrs=scheduleReviewAt(fsrs,event.attempt.rating,event.scheduling!.reviewedAt);
      if (completed) {
        if (current && Date.parse(current.dueAt)<end) {
          if (!rounds.includes(current)) rounds.push(current);
          current.completed=true;current.completedAt=event.occurredAt;
        }
        // First completion closes initial learning, not an old-word obligation.
        learnedAnchor=event.eventId;
        lastCompletion=event.eventId;
        current=fsrs ? await create(event.eventId,fsrs.due) : undefined;
      } else if (fsrs) {
        if (current) {
          current.retryDueAt=fsrs.due;
          if (!rounds.includes(current) && Date.parse(fsrs.due)<Date.parse(current.dueAt)) current.dueAt=fsrs.due;
        }
        else if (learnedAnchor) {
          current=await create(learnedAnchor,fsrs.due);
        }
      }
      // Only an observed successful machine write establishes its expected next state.
      // Recomputing this from FSRS or reading today's source would erase manual changes.
      if (observation?.afterReview) {expectedSource=sourceState(observation.afterReview);expectedAfterEventId=event.eventId;}
    }
    activate(end-1);
    output.push(...rounds.filter(round=>round.completed
      ? Boolean(round.completedAt && Date.parse(round.completedAt)>=start && Date.parse(round.completedAt)<end)
      : Date.parse(round.dueAt)<end));
  }
  for (const old of input.previous) {
    const dueAt=sourceReviewDueAt(old.dueAt);
    if (!resolved.has(old.roundId) && !(Date.parse(dueAt)>=end)) {
      output.push({...old,dueAt,completed:false,completedAt:undefined,blockedReason:'复习来源或完整证据缺失，请同步后继续。'});
    }
  }
  const unique=new Map(output.map(round=>[round.roundId,round]));
  return [...unique.values()].sort((a,b)=>compareEvidenceText(a.dueAt,b.dueAt)||compareEvidenceText(a.roundId,b.roundId));
}
