// @ts-expect-error TS5097: standalone Node contracts.
import {completionDay} from './study-day.ts';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {parseLongTermDailyAllocation,LONG_TERM_PREREQUISITE_BLOCK} from './long-term-daily-allocation.ts';
import type {DailyPlanningInput,DailyTask,LearningUnit,PlanningCatalog,PlanningWord,SubjectGoal,TaskCompletion,TaskPlanV2,WordLearning} from './task-plan-types';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {parseTaskPlan,validPlanDay} from './task-plan-types.ts';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {canonicalizeJson} from '../evidence/index.ts';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {compareEvidenceText,countNewWords,lexemeKey,studyDay} from './vocabulary-learning.ts';

const DAY_MS=86400000;
const dayTime=(day:string)=>Date.parse(`${day}T00:00:00Z`);
const dayAt=(time:number)=>new Date(time).toISOString().slice(0,10);
function monday(day:string):string {
  const weekday=(new Date(dayTime(day)).getUTCDay()+6)%7;
  return dayAt(dayTime(day)-weekday*DAY_MS);
}
export function remainingNewWords(day:string,words:WordLearning[],target=20):number {
  return Math.max(0,target-countNewWords(day,words));
}
function goalWindow(goal:SubjectGoal,day:string):{start:string;days:number;target:number} {
  if (![day,goal.startOn,...(goal.dueOn?[goal.dueOn]:[])].every(validPlanDay)) throw new Error('invalid-goal-date');
  let start=goal.kind==='daily'?day:goal.kind==='weekly'?monday(day):goal.startOn;
  if (start<goal.startOn) start=goal.startOn;
  let days=goal.kind==='weekly'?7-(new Date(dayTime(day)).getUTCDay()+6)%7:1;
  let target=goal.targetCount;
  if (!Number.isSafeInteger(target) || target<1) throw new Error('invalid-goal-quantity');
  if (goal.kind==='deadline' && !goal.dueOn) throw new Error('missing-goal-deadline');
  if (goal.dueOn) {
    const remaining=Math.floor((dayTime(goal.dueOn)-dayTime(day))/DAY_MS)+1;
    days=goal.kind==='deadline'?Math.max(1,remaining):Math.max(1,Math.min(days,remaining));
    if (remaining<1 && goal.kind!=='deadline') {
      const periods=goal.kind==='daily'
        ? Math.floor((dayTime(goal.dueOn)-dayTime(goal.startOn))/DAY_MS)+1
        : Math.floor((dayTime(monday(goal.dueOn))-dayTime(monday(goal.startOn)))/(7*DAY_MS))+1;
      target*=periods;start=goal.startOn;
      if (!Number.isSafeInteger(target) || target<1) throw new Error('invalid-goal-quantity');
    }
  }
  return {start,days,target};
}
export function goalQuota(goal:SubjectGoal,day:string,completions:TaskCompletion[],availableCount:number,formalStateUnitIds:string[]=[]):number {
  const goalPeriod=goalWindow(goal,day);
  if (day<goal.startOn) return 0;
  const ids=new Set(goal.unitIds);
  const completed=new Set(completions.filter(c=>c.unitId && ids.has(c.unitId) && c.basis===goal.completionBasis
    && completionDay(c)>=goalPeriod.start && completionDay(c)<=day).map(c=>{
      const period=goal.kind==='daily'?completionDay(c):goal.kind==='weekly'?monday(completionDay(c)):'';
      return `${period}:${c.unitId}`;
    }));
  // A formal goal asks whether the canonical condition currently holds, not when it changed.
  // Do not manufacture a dated TaskCompletion from this boolean state.
  const covered=goal.completionBasis==='formal-state'?new Set(formalStateUnitIds.filter(id=>ids.has(id))).size:completed.size;
  return Math.min(availableCount,Math.ceil(Math.max(0,goalPeriod.target-covered)/goalPeriod.days));
}
export async function planningHash(value:unknown):Promise<string> {
  const result=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalizeJson(value)));
  return [...new Uint8Array(result)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
export function hashTaskPlan(plan:Omit<TaskPlanV2,'planHash'>):Promise<string> {return planningHash(plan);}
export function completionBasis(unit:LearningUnit):TaskCompletion['basis'] {
  return unit.completionRule.startsWith('formal-')?'formal-state':unit.completionRule==='self-report'?'self-report':'practice-round';
}
function completedUnit(unit:LearningUnit,completions:TaskCompletion[],day:string,start?:string):boolean {
  const basis=completionBasis(unit);
  if (basis==='formal-state') return unit.formalComplete===true;
  return completions.some(c=>c.unitId===unit.unitId && c.basis===basis && completionDay(c)<=day
    && (!start || completionDay(c)>=start));
}
/** A protected unit can cover a physical allocation without losing its other items or completion rule. */
export function coversAllocatedPractice(task:DailyTask,allocated:DailyTask,catalog:PlanningCatalog):boolean {
  if(task.category!=='subject'||allocated.category!=='subject'||allocated.unitIds.length
    ||task.subjectId!==allocated.subjectId||task.completionRule!==allocated.completionRule
    ||task.action.kind!=='practice'||allocated.action.kind!=='practice'||allocated.action.itemKeys.length!==1)return false;
  const key=allocated.action.itemKeys[0];
  if(!task.action.itemKeys.includes(key))return false;
  const source=catalog.practiceSources?.find(item=>item.subjectId===allocated.subjectId&&item.itemKey===key);
  if(!source||source.sourceHash!==allocated.sourceHash||source.completionRule!==allocated.completionRule)return false;
  if(task.unitIds.length===1){
    const unit=catalog.subjects.find(subject=>subject.subjectId===task.subjectId)?.units.find(unit=>unit.unitId===task.unitIds[0]);
    return Boolean(unit&&task.quantity===1&&unit.sourceHash===task.sourceHash&&unit.completionRule===task.completionRule
      &&canonicalizeJson(unit.action)===canonicalizeJson(task.action));
  }
  return !task.unitIds.length&&task.quantity===1&&task.action.itemKeys.length===1&&task.sourceHash===source.sourceHash;
}
function selectWords(input:DailyPlanningInput):{assigned:string[];selected:PlanningWord[];required:Set<string>;blocked:Set<string>;manualSelection:boolean} {
  const states=new Map(input.words.map(word=>[word.lexemeKey,word]));
  const previous=input.previous?.day===input.day?input.previous.vocabulary.assignedLexemeKeys:[];
  const excluded=new Set(input.previous?.day===input.day?input.previous.vocabulary.excludedLexemeKeys??[]:[]);
  const excludedItems=new Set(input.previous?.day===input.day?input.previous.vocabulary.excludedItemKeys??[]:[]);
  const completed=new Set(input.words.filter(w=>w.firstLearnedAt && studyDay(w.firstLearnedAt)===input.day).map(w=>w.lexemeKey));
  const allWords=new Map(input.catalog.subjects.flatMap(subject=>subject.words.map(word=>[word.itemKey,word] as const)));
  const saved=new Map((input.previous?.vocabulary.snapshot??[]).map(word=>[word.itemKey,word]));
  const manualSelection=input.previous?.day===input.day && input.previous.vocabulary.manualSelection===true;
  const lockedKeys=new Set(input.previous?.day===input.day?input.previous.vocabulary.lockedLexemeKeys??[]:[]);
  const lockedItems=input.previous?.day===input.day?input.previous.vocabulary.lockedItemKeys:undefined;
  const held=new Map<string,PlanningWord>();
  const preferred=new Map<string,PlanningWord>();
  const identities=[...allWords.values(),...(input.wordIdentities??[]),...saved.values()];
  const physical=(key:string|undefined,lexeme:string)=>key?identities.find(word=>word.language.trim() && lexemeKey(word)===lexeme && (word.itemKey===key || word.legacyKeys?.includes(key))):undefined;
  if (input.previous) for (const task of input.previous.tasks) {
    if (task.category==='new-word' && task.action.kind==='practice') for (const key of task.action.itemKeys) {
      const live=allWords.get(key),snapshot=saved.get(key);
      const identity=snapshot??live;
      const state=identity?.language.trim()?states.get(lexemeKey(identity)):undefined;
      const started=state?.status==='initial-in-progress' && (!state.firstStartedItemKey || identity?.itemKey===state.firstStartedItemKey || identity?.legacyKeys?.includes(state.firstStartedItemKey));
      const explicit=input.previous.day===input.day && (lockedItems!==undefined?lockedItems.includes(key):manualSelection
        || (identity?.language.trim() && lockedKeys.has(lexemeKey(identity))) || input.previous.manual.lockedTaskIds.includes(task.taskId));
      const protect=Boolean(explicit || started);
      const word=protect?(snapshot??live):live;
      if (word?.language.trim()) {
        const key=lexemeKey(word);
        const carry=input.previous.day<input.day && states.get(key)?.status==='initial-in-progress';
        if (input.previous.day===input.day || carry) {
          if (!preferred.has(key) || protect) preferred.set(key,word);
          if (protect && !excluded.has(key) && !excludedItems.has(word.itemKey)) held.set(word.itemKey,word);
        }
      }
    }
  }
  for (const state of input.words) if (state.status==='initial-in-progress' && !excluded.has(state.lexemeKey)) {
    const word=physical(state.firstStartedItemKey,state.lexemeKey);
    if (word && !excludedItems.has(word.itemKey)) {
      if (![...held.values()].some(word=>lexemeKey(word)===state.lexemeKey)) preferred.set(state.lexemeKey,word);
      if (!held.has(word.itemKey)) held.set(word.itemKey,word);
    }
  }
  const allocated=input.longTermAllocation?new Set(input.longTermAllocation.items.filter(i=>i.kind==='vocabulary').map(i=>i.itemId)):null;
  const sources=new Map<string,PlanningWord>();
  const subjects=[...input.catalog.subjects].sort((a,b)=>b.priority-a.priority||compareEvidenceText(a.subjectId,b.subjectId))
    .map(subject=>({...subject,words:subject.words.filter(word=>word.language.trim() && (!allocated || allocated.has(word.itemKey)) && !excludedItems.has(word.itemKey) && (completed.has(lexemeKey(word))
      || ['unseen','initial-in-progress'].includes(states.get(lexemeKey(word))?.status??'')))})).filter(subject=>subject.words.length);
  for (const priority of [...new Set(subjects.map(subject=>subject.priority))]) {
    const bucket=subjects.filter(subject=>subject.priority===priority);
    const offset=((Math.floor(dayTime(input.day)/DAY_MS)%bucket.length)+bucket.length)%bucket.length;
    const rotated=[...bucket.slice(offset),...bucket.slice(0,offset)];
    for (let index=0;index<Math.max(...rotated.map(subject=>subject.words.length));index++) for (const subject of rotated) {
      const word=subject.words[index];
      if (!word) continue;
      const key=lexemeKey(word);
      if (!sources.has(key)) sources.set(key,allocated?word:preferred.get(key)??word);
    }
  }
  for (const word of held.values()) if (!sources.has(lexemeKey(word))) sources.set(lexemeKey(word),word);
  for (const state of input.words) if (state.status==='initial-in-progress' && preferred.has(state.lexemeKey) && !sources.has(state.lexemeKey)) sources.set(state.lexemeKey,preferred.get(state.lexemeKey)!);
  const completedSources=new Map<string,PlanningWord>();
  for (const state of input.words) if (completed.has(state.lexemeKey)) {
    const word=physical(state.firstLearnedItemKey??state.itemKeys[0],state.lexemeKey)??sources.get(state.lexemeKey);
    if (word) completedSources.set(state.lexemeKey,word);
  }
  const eligible=(key:string)=>!excluded.has(key) && sources.has(key) && ['unseen','initial-in-progress'].includes(states.get(key)?.status??'history-unknown');
  const pending:string[]=[];
  const add=(key:string)=>{if (eligible(key) && !pending.includes(key)) pending.push(key);};
  const started=input.words.filter(w=>w.status==='initial-in-progress').sort((a,b)=>compareEvidenceText(a.firstStartedAt??'',b.firstStartedAt??'')||compareEvidenceText(a.lexemeKey,b.lexemeKey));
  started.forEach(w=>add(w.lexemeKey));
  previous.forEach(add);
  [...sources.keys()].forEach(add);
  const mandatoryPending=pending.slice(0,remainingNewWords(input.day,input.words,input.longTermAllocation?.vocabularyTarget??20));
  const retainedStarted=started.filter(w=>eligible(w.lexemeKey) && (previous.includes(w.lexemeKey)
    || (w.firstStartedAt && studyDay(w.firstStartedAt)===input.day))).map(w=>w.lexemeKey);
  const picked=new Set([...mandatoryPending,...retainedStarted,...[...held.values()].map(lexemeKey)]);
  const completedOrder=[...previous.filter(key=>completed.has(key)),...[...completed].filter(key=>!previous.includes(key))].slice(0,input.longTermAllocation?undefined:20);
  const wanted=new Set([...completedOrder,...picked]);
  const assigned=[...previous.filter(key=>wanted.has(key)),...[...wanted].filter(key=>!previous.includes(key))];
  const selected=new Map<string,PlanningWord>(),required=new Set<string>(),blocked=new Set<string>();
  for (const key of assigned) {
    const word=completed.has(key)?completedSources.get(key):sources.get(key);
    if (word) {selected.set(word.itemKey,word);if (completedOrder.includes(key) || mandatoryPending.includes(key)) required.add(word.itemKey);}
  }
  for (const word of held.values()) selected.set(word.itemKey,word);
  for (const word of selected.values()) {
    const key=lexemeKey(word),live=allWords.get(word.itemKey);
    if (!live || live.sourceHash!==word.sourceHash || live.language!==word.language || live.word!==word.word
      || (!completed.has(key) && !['unseen','initial-in-progress'].includes(states.get(key)?.status??''))) blocked.add(word.itemKey);
  }
  return {assigned,selected:[...selected.values()],required,blocked,manualSelection};
}

/** Deterministic mandatory/goal layer. Optional AI tasks are merged separately. */
export async function generateTaskPlan(input:DailyPlanningInput):Promise<TaskPlanV2> {
  if (!validPlanDay(input.day)) throw new Error('invalid-plan-day');
  if (input.optionalMinutes!==undefined && (!Number.isSafeInteger(input.optionalMinutes)||input.optionalMinutes<0)) throw new Error('invalid-optional-minutes');
  if(input.longTermAllocation){
    const allocation=parseLongTermDailyAllocation(input.longTermAllocation);
    if(allocation.day!==input.day)throw new Error('invalid-long-term-allocation-day');
    for(const item of allocation.items){
      const subject=input.catalog.subjects.find(s=>s.subjectId===item.subjectId);
      const word=subject?.words.find(w=>w.itemKey===item.itemId);
      const source=input.catalog.practiceSources?.find(s=>s.itemKey===item.itemId&&s.subjectId===item.subjectId);
      const unit=subject?.units.find(u=>u.unitId===item.itemId);
      const live=item.kind==='vocabulary'?word:source??unit;
      const actualUnits=source?subject?.units.filter(u=>u.action.kind==='practice'&&u.action.itemKeys.includes(source.itemKey)).map(u=>u.unitId)??[]:item.kind==='vocabulary'?[]:unit?[unit.unitId]:[];
      if(JSON.stringify([...actualUnits].sort())!==JSON.stringify([...item.unitIds].sort()))throw new Error('long-term-unit-binding-mismatch');
      if(!live||live.sourceHash!==item.sourceHash)throw new Error('long-term-source-mismatch-or-missing');
      if(source&&!['three-stage','graded-practice'].includes(source.completionRule))throw new Error('long-term-unsupported-physical-completion');
      if(item.kind==='vocabulary'&&(!word||lexemeKey(word)!==item.lexemeKey))throw new Error('long-term-identity-mismatch');
      if(item.unitIds.some(id=>!subject?.units.some(u=>u.unitId===id)))throw new Error('long-term-foreign-unit');
      if(item.kind==='material'&&unit?.action.kind==='practice')throw new Error('long-term-identity-mismatch');
      if(item.kind==='practice'&&!(source?item.itemKeys.length===1&&item.itemKeys[0]===source.itemKey:unit?.action.kind==='practice'&&JSON.stringify(unit.action.itemKeys)===JSON.stringify(item.itemKeys)))throw new Error('long-term-identity-mismatch');
    }
  }
  const tasks:DailyTask[]=[];
  const previous=input.previous?.day===input.day?input.previous:null;
  const active=input.catalog.subjects.filter(subject=>subject.planningStatus!=='invalid');
  const allUnits=new Map(input.catalog.subjects.flatMap(subject=>subject.units.map(unit=>[unit.unitId,unit] as const)));
  const units=new Map(active.flatMap(subject=>subject.units.map(unit=>[unit.unitId,unit] as const)));
  const prerequisiteBlocked=(subjectId:string,associated:LearningUnit[])=>!active.some(subject=>subject.subjectId===subjectId)
    || associated.some(unit=>unit.prerequisites.some(id=>!units.has(id)||!completedUnit(units.get(id)!,input.completions,input.day)));
  const words=selectWords(input);
  const groups=new Map<string,{words:PlanningWord[];required:boolean;blocked:boolean;blockedReason?:string}>();
  for (const word of words.selected) {
    const required=words.required.has(word.itemKey);
    const sourceBlocked=words.blocked.has(word.itemKey);
    const associated=input.longTermAllocation?[...allUnits.values()].filter(unit=>unit.action.kind==='practice'
      && unit.action.itemKeys.some(key=>key===word.itemKey||word.legacyKeys?.includes(key))):[];
    const blockedByPrerequisite=Boolean(input.longTermAllocation&&prerequisiteBlocked(word.subjectId,associated));
    const blocked=sourceBlocked||blockedByPrerequisite;
    const blockedReason=blockedByPrerequisite?LONG_TERM_PREREQUISITE_BLOCK:sourceBlocked?'已选词的来源或新旧状态发生变化，请确认后继续。':undefined;
    const key=`${word.subjectId}:${word.completionRule}:${required?'required':'extra'}:${blockedByPrerequisite?'prerequisite':sourceBlocked?'blocked':'ready'}`;
    const group=groups.get(key)??{words:[],required,blocked,blockedReason};group.words.push(word);groups.set(key,group);
  }
  for (const [key,group] of groups) {
    tasks.push({taskId:`new:${input.day}:${key}`,subjectId:group.words[0].subjectId,title:`${input.catalog.subjects.find(s=>s.subjectId===group.words[0].subjectId)?.name??group.words[0].subjectId} · ${group.blocked?'待处理词':group.required?'新学单词':'自主加学'} · ${group.words.length} 词`,
      category:'new-word',origin:group.required?'fixed':'manual',required:group.required,unitIds:[],quantity:group.words.length,
      action:{kind:'practice',itemKeys:group.words.map(word=>word.itemKey)},completionRule:group.words[0].completionRule,
      sourceHash:await planningHash(group.words.map(word=>[word.itemKey,word.sourceHash])),
      ...(group.blocked?{blockedReason:group.blockedReason}:{})});
  }
  const rounds=new Map(input.reviews.map(round=>[round.roundId,round]));
  for (const round of [...rounds.values()].sort((a,b)=>compareEvidenceText(a.dueAt,b.dueAt)||compareEvidenceText(a.roundId,b.roundId))) {
    const subject=input.catalog.subjects.find(subject=>subject.subjectId===round.subjectId);
    const word=subject?.words.find(word=>word.itemKey===round.itemKey || word.legacyKeys?.includes(round.itemKey));
    const source=input.catalog.practiceSources?.find(source=>source.itemKey===round.itemKey);
    const unit=subject?.units.find(unit=>unit.action.kind==='practice' && unit.action.itemKeys.includes(round.itemKey));
    const title=word?`复习单词 · ${word.word}`:source?`复习 · ${source.title}`:unit?`复习 · ${unit.title}`:'待定位的复习任务';
    tasks.push({taskId:round.roundId,subjectId:round.subjectId,title,category:'review',origin:'fixed',required:true,
      unitIds:[],quantity:1,action:{kind:'practice',itemKeys:[round.itemKey]},completionRule:round.completionRule,
      reviewRoundId:round.roundId,sourceHash:word?.sourceHash??source?.sourceHash??unit?.sourceHash??input.catalog.sourceHash,...(round.blockedReason?{blockedReason:round.blockedReason}:{})});
  }
  const goals=(input.longTermAllocation?[]:active.flatMap(subject=>subject.goals)).sort((a,b)=>Number(b.required)-Number(a.required)||b.priority-a.priority||compareEvidenceText(a.goalId,b.goalId));
  const planned=new Set<string>();
  const exclusions=new Set(previous?.manual.excludedUnitIds??[]);
  const manualUnits=new Map<string,DailyTask>();
  for (const task of previous?.tasks??[]) if (previous?.manual.lockedTaskIds.includes(task.taskId) && task.unitIds.length===1) manualUnits.set(task.unitIds[0],task);
  const owners=new Map((previous?.tasks??[]).map(task=>[task.taskId,task.unitIds[0]]));
  const occupied=new Set(tasks.map(task=>task.taskId));
  for (const goal of goals) {
    const goalPeriod=goalWindow(goal,input.day);
    const calendarStart=goal.kind==='daily'?input.day:goal.kind==='weekly'?monday(input.day):goalPeriod.start;
    const practiceStart=calendarStart<goal.startOn?goal.startOn:calendarStart;
    const available=goal.unitIds.flatMap(id=>units.has(id)?[units.get(id)!]:[]).filter(unit=>
      completionBasis(unit)===goal.completionBasis
      && (goal.required || !exclusions.has(unit.unitId))
      && !completedUnit(unit,input.completions,input.day,unit.action.kind==='practice'?practiceStart:undefined)
      && unit.prerequisites.every(id=>units.has(id) && completedUnit(units.get(id)!,input.completions,input.day)))
      .sort((a,b)=>Number(exclusions.has(a.unitId))-Number(exclusions.has(b.unitId))
        || Number(manualUnits.has(b.unitId))-Number(manualUnits.has(a.unitId)) || a.order-b.order||compareEvidenceText(a.unitId,b.unitId));
    const coverage=available.filter(unit=>planned.has(unit.unitId)).length;
    const formalIds=goal.unitIds.filter(id=>units.get(id)?.formalComplete===true && completionBasis(units.get(id)!)==='formal-state');
    const needed=Math.max(0,goalQuota(goal,input.day,input.completions,available.length,formalIds)-coverage);
    for (const unit of available.filter(unit=>!planned.has(unit.unitId)).slice(0,needed)) {
      planned.add(unit.unitId);
      const baseId=manualUnits.get(unit.unitId)?.taskId??`goal:${input.day}:${goal.goalId}:${unit.unitId}`;
      let taskId=baseId,index=0;
      while (occupied.has(taskId) || (owners.has(taskId) && owners.get(taskId)!==unit.unitId)) taskId=`${baseId}:${++index}`;
      occupied.add(taskId);
      tasks.push({taskId,subjectId:unit.subjectId,
        title:`${goal.dueOn && goal.dueOn<input.day?'逾期 · ':''}${unit.title}`,category:'subject',origin:'goal',required:goal.required,
        goalId:goal.goalId,unitIds:[unit.unitId],quantity:1,action:structuredClone(unit.action),completionRule:unit.completionRule,
        sourceHash:unit.sourceHash,...(unit.estimatedMinutes===undefined?{}:{estimatedMinutes:unit.estimatedMinutes}),
        ...(exclusions.has(unit.unitId)?{blockedReason:'此指标的可用内容已被你排除，请确认今天的选择。'}:{})});
    }
  }
  for(const item of input.longTermAllocation?.items??[]){
    if(item.kind==='vocabulary')continue;
    const associated=item.unitIds.map(id=>allUnits.get(id)).filter((u):u is LearningUnit=>!!u);
    const source=input.catalog.practiceSources?.find(s=>s.itemKey===item.itemId&&s.subjectId===item.subjectId);
    const unit=allUnits.get(item.itemId);
    const blocked=prerequisiteBlocked(item.subjectId,associated);
    const physical=item.kind==='practice'&&source;
    tasks.push({taskId:`long-term:${input.day}:${item.itemId}`,subjectId:item.subjectId,title:source?.title??unit!.title,category:'subject',origin:'goal',required:true,
      unitIds:physical?[]:item.unitIds,quantity:1,action:physical?{kind:'practice',itemKeys:item.itemKeys}:structuredClone(unit!.action),
      completionRule:physical?source.completionRule:unit!.completionRule,sourceHash:item.sourceHash,
      ...(blocked?{blockedReason:LONG_TERM_PREREQUISITE_BLOCK}:{})});
  }
  if(input.longTermAllocation&&previous){
    const protectedIds=new Set([...previous.manual.lockedTaskIds,...input.completions.filter(c=>completionDay(c)===input.day).map(c=>c.taskId)]);
    for(const task of previous.tasks)if(task.category==='subject'&&(protectedIds.has(task.taskId)||task.origin==='manual')){
      const covered=tasks.filter(fresh=>coversAllocatedPractice(task,fresh,input.catalog));
      const retained=structuredClone(task);
      if(covered.length){
        retained.required ||= covered.some(fresh=>fresh.required);
        const blocked=covered.find(fresh=>fresh.blockedReason)?.blockedReason;
        if(blocked)retained.blockedReason=blocked;
        else if(retained.blockedReason===LONG_TERM_PREREQUISITE_BLOCK)delete retained.blockedReason;
        for(const fresh of covered)tasks.splice(tasks.indexOf(fresh),1);
      }
      if(!tasks.some(fresh=>fresh.taskId===retained.taskId))tasks.push(retained);
    }
  }
  const body:Omit<TaskPlanV2,'planHash'>={schemaVersion:2,day:input.day,inputHash:await planningHash(input),sourceHash:input.catalog.sourceHash,
    draftVersion:(previous?.draftVersion??0)+1,tasks,...(input.longTermAllocation?{longTermAllocation:input.longTermAllocation}:{}),vocabulary:{target:input.longTermAllocation?.vocabularyTarget??20,assignedLexemeKeys:words.assigned,snapshot:words.selected,
      ...(words.manualSelection?{manualSelection:true}:{}),...(previous?.vocabulary.excludedLexemeKeys?{excludedLexemeKeys:previous.vocabulary.excludedLexemeKeys}:{}),
      ...(previous?.vocabulary.lockedLexemeKeys?{lockedLexemeKeys:previous.vocabulary.lockedLexemeKeys}:{}),
      ...(previous?.vocabulary.excludedItemKeys?{excludedItemKeys:previous.vocabulary.excludedItemKeys}:{}),
      ...(previous?.vocabulary.lockedItemKeys?{lockedItemKeys:previous.vocabulary.lockedItemKeys}:{})},
    manual:{lockedTaskIds:input.longTermAllocation?(previous?.manual.lockedTaskIds??[]).filter(id=>tasks.some(t=>t.taskId===id)):[],excludedUnitIds:previous?.manual.excludedUnitIds??[]},
    ...(input.optionalMinutes===undefined?{}:{optionalMinutes:input.optionalMinutes})};
  return parseTaskPlan({...body,planHash:await hashTaskPlan(body)});
}
