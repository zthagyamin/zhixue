import type {PlanningCatalog,PlanningEvidenceRecord,ReviewObligation} from './task-plan-types';
import type {StudyEventV3} from '../evidence';
// @ts-expect-error TS5097: standalone Node source contracts.
import {studyDay} from './study-day.ts';

/** Accepts integrity-checked records; filters only current completion, never stored history. */
export function currentPracticeCompletionEvents(catalog:PlanningCatalog,events:readonly StudyEventV3[],records:readonly PlanningEvidenceRecord[]):StudyEventV3[] {
  const sources=new Map<string,Set<string>>(),words=new Set<string>();
  for(const source of catalog.practiceSources??[]) {
    const identities=sources.get(source.itemKey)??new Set<string>();
    identities.add(JSON.stringify([source.subjectId,source.sourceHash]));sources.set(source.itemKey,identities);
  }
  for(const subject of catalog.subjects) for(const word of subject.words) for(const key of [word.itemKey,...word.legacyKeys??[]]) words.add(key);
  const proofs=new Map<string,PlanningEvidenceRecord[]>();
  for(const record of records) {
    const rows=proofs.get(record.event.eventId)??[];rows.push(record);proofs.set(record.event.eventId,rows);
  }
  return events.filter(event=>{
    const current=sources.get(event.item.key);
    if(!current) return words.has(event.item.key);
    if(current.size!==1) return false;
    const rows=proofs.get(event.eventId)??[];
    return rows.length>0&&rows.every(record=>{
      const evidence=record.planningEvidence,source=evidence?.itemSource;
      return record.event.coreHash===event.coreHash&&record.event.item.key===event.item.key
        &&evidence?.schemaVersion===1&&evidence.eventId===event.eventId&&evidence.coreHash===event.coreHash
        &&source?.itemKey===event.item.key&&source.subjectId===record.subjectId
        &&current.has(JSON.stringify([source.subjectId,source.sourceHash]));
    });
  });
}

/** Keeps replayed due/anchor identity; historical success alone cannot finish a current task. */
export function currentPracticeCompletionReviews(catalog:PlanningCatalog,reviews:readonly ReviewObligation[],events:readonly StudyEventV3[],day:string,anchorEvents:readonly StudyEventV3[]=events):ReviewObligation[] {
  const nonwords=new Set(catalog.practiceSources?.map(source=>source.itemKey)??[]);
  const words=new Set(catalog.subjects.flatMap(subject=>subject.words.flatMap(word=>[word.itemKey,...word.legacyKeys??[]])));
  return reviews.map(round=>{
    if(!nonwords.has(round.itemKey)&&words.has(round.itemKey)) return {...round};
    if(round.completed&&events.some(event=>event.eventType==='practice-attempt'&&event.item.key===round.itemKey
      &&event.attempt.correct&&event.attempt.stageAfter===3&&event.occurredAt===round.completedAt)) return {...round};
    const anchor=anchorEvents.find(event=>event.eventId===round.anchorEventId);
    const after=Date.parse(anchor?.occurredAt??round.observedAt??'')||-Infinity;
    const latest=events.filter(event=>event.eventType==='practice-attempt'&&event.item.key===round.itemKey
      &&Date.parse(event.occurredAt)>after&&studyDay(event.occurredAt)===day)
      .sort((a,b)=>a.occurredAt.localeCompare(b.occurredAt)||a.eventId.localeCompare(b.eventId)).at(-1);
    if(latest?.eventType==='practice-attempt'&&latest.attempt.correct&&latest.attempt.stageAfter===3)
      return {...round,completed:true,completedAt:latest.occurredAt};
    return {...round,completed:false,completedAt:undefined};
  });
}
