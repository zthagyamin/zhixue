import type {DailyPlanningInput} from './task-plan-types';
import type {LongTermPlanSnapshot} from './long-term-plan-types';
import type {LongTermDailyItem} from './long-term-daily-allocation';
// @ts-expect-error TS5097: standalone Node contracts.
import {buildLongTermPlanningInput} from './long-term-planning-input.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseLongTermDailyAllocation} from './long-term-daily-allocation.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyDay,compareEvidenceText} from './vocabulary-learning.ts';

/** Explicitly rebuild pending minimum words. Caller persists a draft, never grades/approval. */
export function reconcileDailyMinimums(input:DailyPlanningInput,snapshot:LongTermPlanSnapshot|null):DailyPlanningInput {
  if(!snapshot||snapshot.spec.timeBudgetMode!=='advisory')throw Error('请先在长线计划启用词量优先并保存最低目标。');
  if(input.day<snapshot.spec.startDate||input.day>snapshot.spec.targetDeadline)throw Error('该长线目标今天尚未生效或已经结束。');
  const goals=snapshot.spec.subjectsConfig.filter(s=>s.dailyMinimumTarget!==undefined);
  if(!goals.length)throw Error('请先保存各词库的每日最低目标。');
  const states=new Map(input.words.map(w=>[w.lexemeKey,w]));
  const before=input.longTermAllocation,old=input.previous?.day===input.day?input.previous:null;
  const goalsById=new Map(goals.map(s=>[s.subjectId,s.dailyMinimumTarget!]));
  const excluded=new Set(old?.vocabulary.excludedLexemeKeys??[]),excludedItems=new Set(old?.vocabulary.excludedItemKeys??[]);
  const locked=new Set(old?.vocabulary.lockedItemKeys??[]);
  for(const task of old?.tasks??[])if(task.category==='new-word'&&task.action.kind==='practice'&&
    (old!.manual.lockedTaskIds.includes(task.taskId)||old!.vocabulary.manualSelection))task.action.itemKeys.forEach(key=>locked.add(key));
  const retained=(before?.items??[]).filter(i=>i.kind==='vocabulary'&&!goalsById.has(i.subjectId)).map(i=>i.itemId);
  const source=buildLongTermPlanningInput(input,{preferredWordItemKeys:[...locked,...retained]});
  const inventory=new Map(source.inventory.map(i=>[i.itemId,i]));
  const bindings=source.bindings.filter(b=>b.kind==='vocabulary');
  for(const key of locked)if(!bindings.some(b=>b.itemId===key))throw Error('已锁定词汇的来源重复或发生变化，请核对原计划。');
  const acquired=new Set(source.inventory.filter(i=>i.mastered||(i.completedRounds??0)>0).map(i=>i.itemId));
  const selected=new Map<string,LongTermDailyItem>();
  const convert=(b:typeof bindings[number]):LongTermDailyItem=>{
    const {title,...identity}=b;void title;
    return {...identity,sourceHash:inventory.get(b.itemId)!.sourceHash};
  };
  const completed=(b:typeof bindings[number])=>{const at=states.get(b.lexemeKey!)?.firstLearnedAt;return Boolean(at&&studyDay(at)===input.day);};
  const eligible=(b:typeof bindings[number])=>!inventory.get(b.itemId)?.blockedReason&&!excluded.has(b.lexemeKey!)&&!excludedItems.has(b.itemId)
    &&(inventory.get(b.itemId)?.prerequisiteItemIds??[]).every(key=>acquired.has(key))
    &&['unseen','initial-in-progress'].includes(states.get(b.lexemeKey!)?.status??'history-unknown');
  // Count all real first completions today once, including free practice outside the old allocation.
  for(const b of bindings)if(completed(b)||eligible(b)&&(locked.has(b.itemId)||states.get(b.lexemeKey!)?.status==='initial-in-progress'))selected.set(b.itemId,convert(b));
  const occupied=new Set([...selected.values()].map(item=>item.lexemeKey));
  for(const item of before?.items??[])if(item.kind==='vocabulary'&&!goalsById.has(item.subjectId)&&!occupied.has(item.lexemeKey)){
    selected.set(item.itemId,structuredClone(item));occupied.add(item.lexemeKey);
  }
  const prior=new Set(before?.items.filter(i=>i.kind==='vocabulary').map(i=>i.itemId));
  const ordered=[...bindings].sort((a,b)=>Number(prior.has(b.itemId))-Number(prior.has(a.itemId))||compareEvidenceText(a.itemId,b.itemId));
  for(const goal of goals){
    let count=[...selected.values()].filter(i=>i.subjectId===goal.subjectId).length;
    for(const b of ordered)if(count<goal.dailyMinimumTarget!&&b.subjectId===goal.subjectId&&!selected.has(b.itemId)&&eligible(b)){
      selected.set(b.itemId,convert(b));count++;
    }
  }
  const items=[...(before?.items??[]).filter(i=>i.kind!=='vocabulary').map(i=>structuredClone(i)),...selected.values()];
  const longTermAllocation=parseLongTermDailyAllocation({schemaVersion:1,planId:snapshot.spec.planId,day:input.day,
    vocabularyTarget:selected.size,items,reviewTarget:before?.reviewTarget??snapshot.spec.dailyReviewTarget??null,
    ...(before?.budgetMinutes===undefined?{}:{budgetMinutes:before.budgetMinutes}),
    ...(before?.practiceBudgetGroups===undefined?{}:{practiceBudgetGroups:before.practiceBudgetGroups})});
  return {...input,longTermAllocation};
}
