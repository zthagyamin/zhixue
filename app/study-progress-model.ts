import type {StudyEventV3} from './study-event-v3';
import type {AssistanceHistoryEntry} from './assistance-history';
import type {StudyRecordEnvelope} from './account-study-record';

export function progressScopeSummary(keys:readonly string[],stages:Record<string,number>,ready:boolean,threeStage:boolean){
  const unique=[...new Set(keys)],stage=(key:string)=>Math.max(stages[key]??0,stages[key.startsWith('word:')?key:`word:${key}`]??0);
  const evidence=ready?unique.filter(key=>stage(key)>0).length:null;
  const completed=ready&&threeStage&&unique.length>0?unique.filter(key=>stage(key)>=3).length:null;
  return{total:unique.length,completed,percent:completed!==null&&unique.length?Math.round(completed/unique.length*100):null,evidence};
}
export function progressRecordRows(input:{events:readonly StudyEventV3[];keys:readonly string[];labels:Record<string,string>;assistance:readonly AssistanceHistoryEntry[];accountRecords:ReadonlyArray<{record:StudyRecordEnvelope}>;accountItems?:ReadonlyArray<{itemKey:string;contentHash:string;title:string}>}){
  const keys=new Set(input.keys),assist=new Map(input.assistance.map(row=>[row.eventId,row]));
  const originalTitles=new Map((input.accountItems??[]).map(item=>[`${item.itemKey}\u0000${item.contentHash}`,item.title]));
  const received=new Map(input.accountRecords.map(row=>[row.record.event.eventId,row.record]));
  const unique=new Map(input.events.filter(event=>event.eventType==='practice-attempt'&&keys.has(event.item.key)).map(event=>[event.eventId,event]));
  return [...unique.values()].filter(event=>event.eventType==='practice-attempt').sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)||b.eventId.localeCompare(a.eventId)).map(event=>{
    const assistance=assist.get(event.eventId)??null,record=received.get(event.eventId);
    return{id:event.eventId,occurredAt:event.occurredAt,title:record&&record.provenanceMode!=='task'?(originalTitles.get(`${event.item.key}\u0000${record.contentHash}`)??'历史练习内容'):input.labels[event.item.key]??'历史练习内容',
      correct:event.attempt.correct,stage:event.attempt.stageAfter,
      mode:record&&record.provenanceMode!=='task'?record.practiceMode:assistance?.summary?.practiceMode??null,
      accountReceived:Boolean(record),assistance};
  });
}
export type ProgressRecordRow=ReturnType<typeof progressRecordRows>[number];

export function orderProgressModules<T extends {id:string}>(modules:readonly T[],subjectOrder:readonly string[]):T[]{
 const rank=new Map([...new Set(subjectOrder)].map((id,index)=>[id,index]));
 return [...modules].sort((a,b)=>(rank.get(a.id)??Infinity)-(rank.get(b.id)??Infinity));
}
