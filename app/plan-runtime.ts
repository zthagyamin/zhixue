// @ts-expect-error TS5097: standalone Node contracts.
import {studyDay} from '../src/domain/planning/index.ts';
import type { PlanCandidate, PlanInput } from './daily-plan';
import type { DynamicStudyItem, DynamicSubject } from './dynamic-ui-model';
import type { PracticeItem } from './companion-plan-client';
import type { CloudProgress } from './cloud-sync-types';
import type { StudyEventV3 } from './study-event-v3';
import type { VocabServe } from './vocab-pacing';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extension.
import { isVocabularySubject } from './plugin-routing.ts';
// @ts-expect-error TS5097: Node source contracts.
import {checkContentQuality} from '../src/domain/assessment/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {hasExecutableCodeMaterial} from '../src/domain/content/index.ts';

type Entry = PlanCandidate['items'][number];
type Reference = NonNullable<PlanInput['pool'][number]['practice']>;
const bare = (key: string) => key.replace(/^(practice:|word:|topic:)/, '');
const sameKey = (left: string, right: string) => left === right || bare(left) === bare(right);
const keysOf = (item: DynamicStudyItem): string[] => typeof item.accountItemKey==='string'&&item.accountItemKey.length>0?[item.accountItemKey]:[item.abilityId, item.itemId, item.id, item.allowLegacyAliases !== false && item.word && `word:${item.word}`, item.allowLegacyAliases !== false && item.topic && `topic:${item.topic}`].filter((key): key is string => typeof key === 'string' && key.length > 0);
const matchesKey=(item:DynamicStudyItem,key:string)=>typeof item.accountItemKey==='string'&&item.accountItemKey.length>0?item.accountItemKey===key:keysOf(item).some(actual=>sameKey(actual,key));

export function selectEffectivePlan(day: string, draft: PlanCandidate | null, current: PlanCandidate | null): PlanCandidate | null {
  return draft?.day === day ? draft : current?.day === day ? current : null;
}

export function resolvePlanPractice(entry: Entry, subjects: DynamicSubject[], quota = 20): Reference | undefined {
  if (entry.practice) return entry.practice;
  const group = /^vocab-group:(.+):(\d+)$/.exec(entry.itemKey);
  if (group) {
    const subject = subjects.find((s) => s.id === group[1]);
    const groupIndex = Number(group[2]);
    const size = Number.isInteger(quota) && quota > 0 ? quota : 20;
    const items = subject?.items.filter((item) => item.word).slice(groupIndex * size, (groupIndex + 1) * size) ?? [];
    return {kind:'vocab-group',subjectId:group[1],groupIndex,groupQuota:size,count:items.length,itemKeys:items.map((i)=>i.abilityId || `word:${i.word}`)};
  }
  const matches = subjects.flatMap((subject) => subject.items.filter((item) => matchesKey(item,entry.itemKey)).map((item) => ({subject,item})));
  if (matches.length === 1) {
    const {subject,item} = matches[0];
    return {kind:isVocabularySubject(subject) ? 'vocab-group' : 'question',subjectId:subject.id,count:1,itemKeys:[entry.itemKey],itemIds:item.itemId ? [item.itemId] : undefined};
  }
  if (entry.itemKey.startsWith('practice:')) return {kind:'question',subjectId:'',count:1,itemKeys:[entry.itemKey],itemIds:[entry.itemKey.slice(9)]};
  return undefined;
}

function matchesEntry(entry: Entry, item: DynamicStudyItem, subject: DynamicSubject, subjects: DynamicSubject[]): boolean {
  const ref = resolvePlanPractice(entry, subjects);
  if (!ref) return false;
  if (ref?.subjectId && ref.subjectId !== subject.id && !subject.legacyIds?.includes(ref.subjectId)) return false;
  if(typeof item.accountItemKey==='string'&&item.accountItemKey.length>0)return (ref.itemKeys??[entry.itemKey]).includes(item.accountItemKey);
  if (ref.itemIds?.length) return Boolean((item.itemId || item.id) && ref.itemIds.includes(item.itemId || item.id!));
  const wanted = ref?.itemKeys ?? [entry.itemKey];
  return wanted.some((key) => keysOf(item).some((actual) => sameKey(key, actual)));
}

export function filterPlanSubject(subject: DynamicSubject, plan: PlanCandidate, subjects: DynamicSubject[]): DynamicStudyItem[] {
  return subject.items.filter((item) => plan.items.some((entry) => matchesEntry(entry,item,subject,subjects)));
}

export function selectPlannedPractice(entry: Entry, subjects: DynamicSubject[], remote: PracticeItem[]): PracticeItem[] {
  const ref = resolvePlanPractice(entry, subjects);
  const ids = ref?.itemIds ?? (entry.itemKey.startsWith('practice:') ? [entry.itemKey.slice(9)] : []);
  const exact = ids.length ? remote.filter((item)=>ids.includes(item.itemId)) : remote.filter((item)=>sameKey(item.itemId,entry.itemKey));
  if (exact.length === 1) return exact;
  if (exact.length > 1) throw new Error('计划条目匹配到多个题目，请重新生成计划。');
  const sources=subjects.flatMap((subject)=>subject.items.filter((item)=>matchesEntry(entry,item,subject,subjects)).map((item)=>({subject,item})));
  if (sources.length === 1) {
    const {subject,item}=sources[0];
    if(subject.pluginType==='paper')throw new Error('论文精读请从工坊打开，不产生评分事件。');
    if (item.practiceItem && typeof item.practiceItem === 'object') return [item.practiceItem as PracticeItem];
    const itemId=item.itemId || item.abilityId || item.id || entry.itemKey;
    const options=Array.isArray(item.options) ? item.options.map(String) : undefined;
    const answer=options && typeof item.answer==='string' ? options.indexOf(item.answer) : item.answer;
    return [{itemId,abilityId:item.abilityId || entry.itemKey,domain:String(item.domain || subject.domain || entry.domain),sourceNote:String(item.sourceNote || ''),stateRef:String(item.stateRef || ''),questionType:subject.pluginType === 'spelling' ? 'recall' : subject.pluginType,prompt:String(item.prompt || item.front || item.topic || item.word || ''),options,answer:typeof answer==='number' || typeof answer==='string' ? answer : undefined,explanation:String(item.explanation || item.back || item.reviewPoint || ''),fingerprint:String(item.fingerprint || itemId),sourceLabel:subject.name,
      ...(typeof item.initialCode === 'string' ? {initialCode:item.initialCode} : {}),
      ...(typeof item.testCode === 'string' ? {testCode:item.testCode} : {}),
      ...(typeof item.solutionCode === 'string' ? {solutionCode:item.solutionCode} : {}),
      ...(typeof item.accountItemKey==='string'?{accountItemKey:item.accountItemKey}:{}),
      ...(typeof item.accountSnapshotId==='string'?{accountSnapshotId:item.accountSnapshotId}:{}),
      ...(item.learningSupport?{learningSupport:item.learningSupport}:{}),
      ...(typeof item.contentHash==='string'?{contentHash:item.contentHash}:{}),
    }];
  }
  const aliases = remote.filter((item)=>sameKey(item.abilityId,entry.itemKey));
  if (ids.length === 0 && sources.length === 0 && aliases.length === 1) return aliases;
  throw new Error('找不到唯一匹配的计划题目，请同步资料或重新生成计划。');
}

function stageOf(item: DynamicStudyItem, stages: Record<string,number>): number {
  const primary=item.abilityId || (item.word ? `word:${item.word}` : item.topic ? `topic:${item.topic}` : item.itemId || item.id || '');
  if (stages[primary] !== undefined) return stages[primary];
  const legacy=item.allowLegacyAliases !== false && item.word ? `word:${item.word.trim().toLocaleLowerCase('en-US')}` : '';
  return stages[legacy] ?? 0;
}

export function isPlanEntryDone(entry: Entry, subjects: DynamicSubject[], progress: Pick<CloudProgress,'itemStages'>, events: StudyEventV3[], day: string): boolean {
  const ref=resolvePlanPractice(entry,subjects);
  if (ref?.kind==='vocab-group') {
    const stages = planItemStages(entry, subjects, progress, events, day);
    return ref.itemKeys.length > 0 && ref.itemKeys.every((key)=>{
      const item=subjects.find(s=>s.id===ref.subjectId)?.items.find(i=>keysOf(i).some(k=>sameKey(k,key)));
      return item ? stageOf(item,stages)>=3 : (stages[key]??0)>=3;
    });
  }
  const aliases=new Set(ref?.itemIds?.length ? ref.itemIds : [entry.itemKey,...(ref?.itemKeys??[])]);
  for (const subject of subjects) for (const item of subject.items) {
    if (!ref?.itemIds?.length && matchesEntry(entry,item,subject,subjects)) keysOf(item).forEach(key=>aliases.add(key));
  }
  const latest = todayEvents(events,day).filter(event=>[...aliases].some(key=>sameKey(key,event.item.key))).at(-1);
  return latest?.attempt.correct === true && ['good','easy'].includes(latest.attempt.rating);
}

type PracticeEvent = Extract<StudyEventV3, {eventType: 'practice-attempt'}>;
function todayEvents(events: StudyEventV3[], day: string): PracticeEvent[] {
  return events.filter((event): event is PracticeEvent => event.eventType === 'practice-attempt' && Number.isFinite(Date.parse(event.occurredAt))
    && studyDay(event.occurredAt) === day)
    .sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt) || String(a.eventId).localeCompare(String(b.eventId)));
}

/** A scheduled vocabulary review starts a new local round, without resetting FSRS. */
export function planItemStages(entry: Entry | undefined, subjects: DynamicSubject[], progress: Pick<CloudProgress,'itemStages'>, events: StudyEventV3[], day: string): Record<string,number> {
  if (!entry || !['review','overdue'].includes(entry.kind)) return progress.itemStages;
  const ref = resolvePlanPractice(entry,subjects);
  if (ref?.kind !== 'vocab-group') return progress.itemStages;
  const stages = {...progress.itemStages};
  const today = todayEvents(events,day);
  for (const key of ref.itemKeys) {
    const source = subjects.find(subject=>subject.id===ref.subjectId)?.items.find(item=>keysOf(item).some(alias=>sameKey(alias,key)));
    const aliases = [key,...(source ? keysOf(source) : [])];
    if (source?.word && source.allowLegacyAliases !== false) aliases.push(`word:${source.word.trim().toLowerCase()}`);
    const latest = today.filter(event=>aliases.some(alias=>sameKey(alias,event.item.key))).at(-1);
    const stage = latest?.attempt.correct ? latest.attempt.stageAfter : 0;
    for (const alias of aliases) stages[alias] = stage;
  }
  return stages;
}

/** Every new round honors the same effective plan as its first question. */
export function practiceForPlan(plan: PlanCandidate | null, subjects: DynamicSubject[], remote: PracticeItem[]): PracticeItem[] {
  const ready=(item:PracticeItem)=>item.questionType!=='recall'||checkContentQuality('recall',item).capabilities.canSelfCheck;
  if (!plan) return remote.filter(ready);
  const selected = plan.items.flatMap(entry=>resolvePlanPractice(entry,subjects)?.kind === 'vocab-group' ? [] : selectPlannedPractice(entry,subjects,remote));
  return selected.filter((item,index)=>ready(item)&&selected.findIndex(other=>other.itemId===item.itemId)===index);
}

export async function loadPlannedPractice(plan: PlanCandidate | null, subjects: DynamicSubject[], deps: {
  loadRemote?: () => Promise<PracticeItem[]>;
  readCache: () => Promise<PracticeItem[]>;
  writeCache: (items: PracticeItem[]) => Promise<void>;
}): Promise<{items: PracticeItem[]; offline: boolean}> {
  let items: PracticeItem[];
  let offline = false;
  try {
    if (!deps.loadRemote) throw new Error('Companion 未连接。');
    items = await deps.loadRemote();
    await deps.writeCache(items);
  } catch {
    offline = true;
    items = await deps.readCache();
  }
  return {items:practiceForPlan(plan,subjects,items),offline};
}

/** Result-card practice is a real source of playable content, including before its first event. */
export function studySubjectsWithPractice(subjects: DynamicSubject[], practice: PracticeItem[]): DynamicSubject[] {
  const result = subjects.map(subject=>({...subject,items:[...subject.items]}));
  for (const item of practice) {
    const reading = item.questionType === 'quiz' && ['ielts','paper'].includes(item.domain);
    const paper = item.questionType === 'recall' && item.domain === 'paper';
    const type = item.questionType === 'three-stage' || (item.questionType === 'code' && !hasExecutableCodeMaterial(item)) ? 'flashcard' : item.questionType;
    const id = reading ? 'reading-comprehension' : paper ? 'paper-core-viewpoints' : `learning-vault-${item.domain}-${type}`;
    let subject = result.find(source=>source.items.some(sourceItem=>sourceItem.itemId===item.itemId)) ?? result.find(source=>source.id===id);
    if (!subject) {
      subject = {id,name:reading?'阅读理解专项':paper?'论文核心观点':`学习库复习 · ${item.domain}`,pluginType:type,domain:item.domain,items:[]};
      result.push(subject);
    }
    const converted: DynamicStudyItem = {...item,id:item.itemId,topic:item.sourceLabel || item.prompt,
      pluginType:type,front:item.prompt,back:item.questionType==='flashcard'?(String(item.answer ?? '')||item.explanation):item.explanation || String(item.answer ?? ''),
      answer:item.questionType==='quiz' && typeof item.answer==='number' ? item.options?.[item.answer] : item.answer,
      practiceItem:item,
    };
    const index = subject.items.findIndex(source=>source.itemId===item.itemId);
    if (index < 0) subject.items.push(converted);
    else subject.items[index] = {...subject.items[index],practiceItem:item};
  }
  return result;
}

export function isCarriedGroup(day: string, served: VocabServe, group: number, items: DynamicStudyItem[], progress: Pick<CloudProgress,'itemStages'>): boolean {
  const yesterday=new Date(Date.parse(`${day}T00:00:00Z`)-86400000).toISOString().slice(0,10);
  if (served.dayKey !== yesterday) return false;
  return items.some(item=>stageOf(item,progress.itemStages)<3 && (served.itemKeys?.length
    ? keysOf(item).some(key=>served.itemKeys!.some(previous=>sameKey(previous,key)))
    : served.group===group));
}

/** Demo completion is deliberately separate from immutable personal learning events. */
export function isDemoPlanEntryDone(entry:Entry,subjects:DynamicSubject[],progress:Pick<CloudProgress,'itemStages'>,items:PracticeItem[]):boolean{
  if(resolvePlanPractice(entry,subjects)?.kind==='vocab-group')return isPlanEntryDone(entry,subjects,progress,[],'');
  try{return selectPlannedPractice(entry,subjects,items).every(item=>(progress.itemStages['practice:'+item.itemId]??0)>=3);}catch{return false;}
}
