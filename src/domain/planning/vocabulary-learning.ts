import type {PlanningWord,WordLearning} from './task-plan-types';
import type {StudyEventV3,StudyAttemptEventV3} from '../evidence';
// @ts-expect-error TS5097: Node tests use TypeScript extensions.
import {parseCloudStudyEventV3} from '../evidence/index.ts';

// @ts-expect-error TS5097: standalone Node contracts.
import {studyDay} from './study-day.ts';
export {studyDay};
export function lexemeKey(word:PlanningWord):string {
  const language=word.language.trim().toLowerCase();
  if (!language) throw new Error('unknown-word-language');
  let form=word.word.normalize('NFKC').trim();
  if (language==='en') form=form.toLocaleLowerCase('en-US');
  return `${language}:${form}`;
}
export function compareEvidenceText(left:string,right:string):number {
  const a=[...left],b=[...right];
  for (let index=0;index<Math.min(a.length,b.length);index++) {
    const difference=a[index].codePointAt(0)!-b[index].codePointAt(0)!;
    if (difference) return difference;
  }
  return a.length-b.length;
}
export async function uniqueStudyEvents(input:StudyEventV3[]):Promise<StudyEventV3[]> {
  const unique=new Map<string,StudyEventV3>();
  for (const raw of input) {
    const event=await parseCloudStudyEventV3(raw);
    const previous=unique.get(event.eventId);
    if (previous && previous.coreHash!==event.coreHash) throw new Error('event-conflict');
    unique.set(event.eventId,event);
  }
  return [...unique.values()].sort((a,b)=>compareEvidenceText(a.occurredAt,b.occurredAt)||compareEvidenceText(a.eventId,b.eventId));
}
export async function projectVocabulary(words:PlanningWord[],input:StudyEventV3[],history:{complete:boolean;legacyItemKeys:string[]}):Promise<WordLearning[]> {
  const events=await uniqueStudyEvents(input);
  const legacy=new Set(history.legacyItemKeys);
  const groups=new Map<string,{words:PlanningWord[];aliases:Set<string>;unknown:boolean}>();
  const owners=new Map<string,Set<string>>();
  for (const word of words) {
    const unknown=!word.language.trim();
    const key=unknown ? `unknown:${word.subjectId}:${word.itemKey}` : lexemeKey(word);
    const group=groups.get(key) ?? {words:[],aliases:new Set<string>(),unknown};
    group.words.push(word);
    for (const alias of [word.itemKey,...(word.legacyKeys??[])]) {
      group.aliases.add(alias);
      const identities=owners.get(alias)??new Set<string>();
      identities.add(key);owners.set(alias,identities);
    }
    groups.set(key,group);
  }
  const groupedEvents=new Map<string,StudyEventV3[]>();
  for (const event of events) for (const key of owners.get(event.item.key)??[]) {
    const records=groupedEvents.get(key)??[];
    records.push(event);groupedEvents.set(key,records);
  }
  const result:WordLearning[]=[];
  for (const [key,group] of groups) {
    const matching=groupedEvents.get(key)??[];
    const attempts=matching.filter((event):event is StudyAttemptEventV3=>event.eventType==='practice-attempt');
    const first=attempts[0];
    // stageAfter=3 is the existing normalized completed-round signal for all plugins.
    // Three-stage plugins emit it only after their final stage; a reset cannot undo history.
    const completion=attempts.find(event=>event.attempt.correct && event.attempt.stageAfter===3);
    const historyGap=group.words.some(word=>{
      const aliases=new Set([word.itemKey,...(word.legacyKeys??[])]);
      const initial=attempts.find(event=>aliases.has(event.item.key));
      return Boolean(initial && initial.attempt.stageBefore!==0);
    });
    const ambiguous=group.unknown || [...group.aliases].some(alias=>(owners.get(alias)?.size??0)>1);
    const uncertain=ambiguous || !history.complete || [...group.aliases].some(alias=>legacy.has(alias))
      || matching.some(event=>event.eventType==='review-baseline') || historyGap;
    const state:WordLearning={lexemeKey:key,itemKeys:[...new Set(group.words.map(word=>word.itemKey))],
      status:ambiguous?'history-unknown':completion?'learned':uncertain?'history-unknown':first?'initial-in-progress':'unseen'};
    if (!uncertain && first) {state.firstStartedAt=first.occurredAt;state.firstStartedItemKey=first.item.key;}
    if (!uncertain && completion) {state.firstLearnedAt=completion.occurredAt;state.firstLearnedItemKey=completion.item.key;}
    result.push(state);
  }
  return result.sort((a,b)=>compareEvidenceText(a.lexemeKey,b.lexemeKey));
}
export function countNewWords(day:string,words:WordLearning[]):number {
  return new Set(words.filter(word=>word.firstLearnedAt && studyDay(word.firstLearnedAt)===day).map(word=>word.lexemeKey)).size;
}
