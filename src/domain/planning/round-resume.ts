// @ts-expect-error TS5097: standalone Node contracts.
import {studyDay} from './study-day.ts';
import type {SubjectRound} from './subject-round';
import type {StudyEventV3} from '../evidence';
import type {DailyTask,ReviewObligation} from './task-plan-types';
// @ts-expect-error TS5097: standalone Node source contracts.
import {settledSubjectKeys} from './subject-round.ts';
export function restoredSubjectRound(keys:readonly string[]):SubjectRound{return {correctKeys:[...new Set(keys)],wrongKeys:[],resets:0};}
export function taskRoundIdentity(owner:string,library:string,day:string,task:Pick<DailyTask,'taskId'|'sourceHash'|'reviewRoundId'|'action'>):string{
 return JSON.stringify([owner,library,day,task.taskId,task.sourceHash,task.reviewRoundId??null,task.action]);
}
export function firstPendingRoundIndex(keys:readonly string[],round:SubjectRound,preferred?:string):number{
 const selected=preferred===undefined?-1:keys.indexOf(preferred);
 if(selected>=0&&!settledSubjectKeys(round).includes(keys[selected]))return selected;
 return Math.max(0,keys.findIndex(key=>!settledSubjectKeys(round).includes(key)));
}
export function nativeTaskCompletedKeys(task:DailyTask,obligation:ReviewObligation|undefined,events:readonly StudyEventV3[],day:string):string[]{
 if(task.action.kind!=='practice')return [];
 const anchor=events.find(event=>event.eventId===obligation?.anchorEventId);
 const after=task.category==='review'?Date.parse(anchor?.occurredAt??obligation?.observedAt??''): -Infinity;
 if(task.category==='review'&&!Number.isFinite(after))return [];
 return task.action.itemKeys.filter(key=>{
  const candidates=events.filter(event=>event.eventType==='practice-attempt'&&event.item.key===key&&Date.parse(event.occurredAt)>after&&studyDay(event.occurredAt)===day);
  const latest=[...candidates].sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt)||a.eventId.localeCompare(b.eventId)).at(-1);
  return latest?.eventType==='practice-attempt'&&latest.attempt.correct&&latest.attempt.stageAfter===3;
 });
}
