import type {StudyEventV3} from '../evidence';
// @ts-expect-error TS5097: standalone Node contracts use TypeScript extensions.
import {studyDay} from './study-day.ts';

type ReviewBoundary={kind:'after';occurredAt:string}|{kind:'day';day:string};

/** A due word gets one short recall only before any attempt in this review round. */
export function isInitialReviewProbe(input:{
  review:boolean;mode:string;completedStage:number;itemKeys:readonly string[];
  events:readonly StudyEventV3[];boundary:ReviewBoundary|null;
}):boolean {
  if(!input.review||input.mode!=='three-stage'||input.completedStage!==0||!input.boundary)return false;
  const keys=new Set(input.itemKeys.filter(Boolean));if(!keys.size)return false;
  const boundary=input.boundary;
  const after=boundary.kind==='after'?Date.parse(boundary.occurredAt):0;
  if(boundary.kind==='after'&&!Number.isFinite(after))return false;
  if(boundary.kind==='day'&&!/^\d{4}-\d{2}-\d{2}$/.test(boundary.day))return false;
  const attempts=input.events.filter(event=>event.eventType==='practice-attempt'&&keys.has(event.item.key));
  const latest=[...attempts].sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt)||a.eventId.localeCompare(b.eventId)).at(-1);
  // An unfinished earlier attempt is relearning evidence, even across 04:00.
  if(latest&&latest.eventType==='practice-attempt'&&latest.attempt.stageAfter<3)return false;
  return !attempts.some(event=>boundary.kind==='after'
    ? Date.parse(event.occurredAt)>after
    : studyDay(event.occurredAt)===boundary.day);
}

export function reviewDisplayStage(completedStage:number,quick:boolean):number {
  return quick?3:Math.min(3,completedStage+1);
}

/** Displaying stage three does not invent stage-one or stage-two evidence. */
export function reviewSubmission(input:{completedStage:number;correct:boolean;quick:boolean}):{
  stageBefore:number;stageAfter:number;practiceMode:'flashcard'|'three-stage';isThreeStage:boolean;repeatCurrent:boolean;
} {
  if(!Number.isInteger(input.completedStage)||input.completedStage<0||input.completedStage>=3||input.quick&&input.completedStage!==0)
    throw new Error('invalid-word-review-stage');
  return {
    stageBefore:input.quick?0:input.completedStage,
    stageAfter:input.correct?(input.quick?3:input.completedStage+1):0,
    practiceMode:input.quick?'flashcard':'three-stage',
    isThreeStage:!input.quick,
    repeatCurrent:input.quick&&!input.correct,
  };
}
