// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {LONG_TERM_PREREQUISITE_BLOCK} from './long-term-daily-allocation.ts';
import type {DailyTask,PlanningCatalog,TaskPlanV2,WordLearning,ReviewObligation} from './task-plan-types';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {parseDailyTask,parseTaskPlan} from './task-plan-types.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {hashTaskPlan,planningHash,coversAllocatedPractice} from './task-plan-engine.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {canonicalizeJson} from '../evidence/index.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {lexemeKey,studyDay} from './vocabulary-learning.ts';
// @ts-expect-error Node source tests.
import {planningUnitAlreadyScheduled} from './task-plan-overlap.ts';

export type TaskEdit={type:'remove';taskId:string}|{type:'upsert';task:DailyTask}
  |{type:'move';taskId:string;beforeTaskId:string|null}|{type:'start';taskId:string}
  |{type:'replace-new-word';taskId:string;fromItemKey:string;toItemKey:string}
  |{type:'refresh-source';taskId:string}|{type:'start-group';taskIds:string[]};
const same=(a:unknown,b:unknown)=>canonicalizeJson(a)===canonicalizeJson(b);
async function seal(plan:TaskPlanV2):Promise<TaskPlanV2> {
  const body:Omit<TaskPlanV2,'planHash'>={...plan};
  delete (body as Partial<TaskPlanV2>).planHash;
  return parseTaskPlan({...body,planHash:await hashTaskPlan(body)});
}

/** Pure source validation; no arbitrary note path or invented learning rule. */
export async function taskSourceHash(task:DailyTask,catalog:PlanningCatalog):Promise<string> {
  const subject=catalog.subjects.find(subject=>subject.subjectId===task.subjectId);
  if (!subject) throw new Error('unknown-task-subject');
  if (task.unitIds.length) {
    if (task.unitIds.length!==1 || task.quantity!==1) throw new Error('task-units-must-be-independent');
    const unit=subject.units.find(unit=>unit.unitId===task.unitIds[0]);
    if (!unit) throw new Error('unknown-task-unit');
    if (!same(unit.action,task.action)) throw new Error('task-action-mismatch');
    if (unit.completionRule!==task.completionRule) throw new Error('task-completion-rule-mismatch');
    return unit.sourceHash;
  }
  if (task.action.kind==='manual') {
    if (task.category!=='subject' || task.completionRule!=='self-report') throw new Error('invalid-manual-action');
    return task.sourceHash;
  }
  if (task.action.kind!=='practice') throw new Error('unmapped-task-action');
  if (task.category==='subject') {
    const keys=task.action.itemKeys;
    const source=keys.length===1?catalog.practiceSources?.find(s=>s.subjectId===task.subjectId&&s.itemKey===keys[0]):undefined;
    if(!source||task.quantity!==1||!['three-stage','graded-practice'].includes(source.completionRule)||task.completionRule!==source.completionRule)throw new Error('task-unit-reference-required');
    return source.sourceHash;
  }
  const keys=task.action.itemKeys;
  if (keys.length!==task.quantity) throw new Error('task-quantity-mismatch');
  const hashes:Array<[string,string]>=[];
  for (const key of keys) {
    const word=subject.words.find(word=>word.itemKey===key || word.legacyKeys?.includes(key));
    const source=catalog.practiceSources?.find(source=>source.subjectId===task.subjectId && source.itemKey===key);
    const unit=subject.units.find(unit=>unit.action.kind==='practice' && unit.action.itemKeys.includes(key));
    if (!word && !source && !unit) throw new Error('unknown-practice-reference');
    const rule=word?.completionRule??source?.completionRule??'graded-practice';
    if (task.completionRule!==rule) throw new Error('task-completion-rule-mismatch');
    hashes.push([word?.itemKey??key,word?.sourceHash??source?.sourceHash??unit!.sourceHash]);
  }
  return task.category==='review' && hashes.length===1?hashes[0][1]:planningHash(hashes);
}
async function retainedTask(task:DailyTask,catalog:PlanningCatalog):Promise<DailyTask> {
  const copy=structuredClone(task);
  if (copy.blockedReason==='学习来源已更新，请确认后继续。' || copy.blockedReason==='学习来源暂时无法定位，请同步或修复引用。') delete copy.blockedReason;
  try {
    if (await taskSourceHash(task,catalog)!==task.sourceHash) copy.blockedReason='学习来源已更新，请确认后继续。';
  } catch {copy.blockedReason='学习来源暂时无法定位，请同步或修复引用。';}
  return copy;
}
function unique(values:string[]):string[] {return [...new Set(values)];}
function pinWordChoices(plan:TaskPlanV2,task:DailyTask):void {
  if (task.category!=='new-word' || task.action.kind!=='practice') return;
  const snapshots=new Map((plan.vocabulary.snapshot??[]).map(word=>[word.itemKey,word]));
  const oldItems=plan.vocabulary.lockedItemKeys??plan.tasks.filter(item=>item.category==='new-word').flatMap(item=>item.action.kind==='practice'
    ? item.action.itemKeys.filter(key=>plan.vocabulary.manualSelection || plan.manual.lockedTaskIds.includes(item.taskId)
      || (snapshots.has(key) && plan.vocabulary.lockedLexemeKeys?.includes(lexemeKey(snapshots.get(key)!)))):[]);
  const keys=new Set([...oldItems,...task.action.itemKeys]);
  plan.vocabulary.lockedLexemeKeys=unique([...(plan.vocabulary.lockedLexemeKeys??[]),...(plan.vocabulary.snapshot??[]).filter(word=>keys.has(word.itemKey)).map(lexemeKey)]);
  plan.vocabulary.lockedItemKeys=unique([...oldItems,...task.action.itemKeys]);
}
function applyOrder(tasks:DailyTask[],order:string[]|undefined):DailyTask[] {
  if (!order) return tasks;
  const byId=new Map(tasks.map(task=>[task.taskId,task]));
  return [...order.flatMap(id=>byId.has(id)?[byId.get(id)!]:[]),...tasks.filter(task=>!order.includes(task.taskId))];
}

export async function editTaskPlan(value:TaskPlanV2,edit:TaskEdit,catalog:PlanningCatalog,context?:{words:WordLearning[];reviews?:ReviewObligation[]}):Promise<TaskPlanV2> {
  const plan=parseTaskPlan(value);
  if (plan.sourceHash!==catalog.sourceHash) throw new Error('stale-task-source');
  if(edit.type==='start-group'){
    if(!edit.taskIds.length)throw new Error('empty-task-group');
    const tasks=unique(edit.taskIds).map(id=>{const task=plan.tasks.find(task=>task.taskId===id);if(!task||task.blockedReason||task.action.kind!=='practice')throw new Error('invalid-task-group');return task;});
    plan.manual.lockedTaskIds=unique([...plan.manual.lockedTaskIds,...tasks.map(task=>task.taskId)]);
    for(const task of tasks)pinWordChoices(plan,task);
  } else if (edit.type==='upsert') {
    const proposed=parseDailyTask(edit.task);
    const existing=plan.tasks.find(task=>task.taskId===proposed.taskId);
    if (proposed.category==='new-word' || existing?.category==='new-word') throw new Error('use-typed-word-edit');
    if (existing?.category==='review' && (!same(existing.action,proposed.action) || existing.reviewRoundId!==proposed.reviewRoundId)) throw new Error('required-review-identity');
    if (!existing && (proposed.required || proposed.category==='review')) throw new Error('cannot-create-required-task');
    if (existing?.required && (!proposed.required || proposed.category!==existing.category || proposed.subjectId!==existing.subjectId
      || !same(proposed.unitIds,existing.unitIds) || proposed.quantity!==existing.quantity
      || proposed.completionRule!==existing.completionRule || proposed.goalId!==existing.goalId)) throw new Error('required-task-cannot-be-downgraded');
    if(plan.longTermAllocation&&existing?.required&&existing.category==='subject'&&!same(existing.action,proposed.action))throw new Error('required-allocation-identity');
    const expected=await taskSourceHash(proposed,catalog);
    if (proposed.sourceHash!==expected) throw new Error('stale-task-definition');
    if (plan.tasks.some(task=>task.taskId!==proposed.taskId && task.unitIds.some(id=>proposed.unitIds.includes(id)))) throw new Error('duplicate-task-unit');
    if(!existing&&catalog.subjects.flatMap(subject=>subject.units).filter(unit=>proposed.unitIds.includes(unit.unitId)).some(unit=>planningUnitAlreadyScheduled(unit,plan.tasks,proposed.origin==='ai'||proposed.origin==='fallback'?'any':'complete')))throw new Error('这项内容已在今日安排中，无需重复添加。');
    const updated={...proposed,origin:existing?.required?existing.origin:'manual' as const};
    delete updated.blockedReason;
    if ((existing?.category==='review'||(plan.longTermAllocation&&existing?.category==='subject')) && existing.blockedReason) updated.blockedReason=existing.blockedReason;
    plan.tasks=existing?plan.tasks.map(task=>task.taskId===updated.taskId?updated:task):[...plan.tasks,updated];
    plan.manual.lockedTaskIds=unique([...plan.manual.lockedTaskIds,updated.taskId]);
    plan.manual.excludedUnitIds=unique([...plan.manual.excludedUnitIds,...(existing?.unitIds??[]).filter(id=>!updated.unitIds.includes(id))])
      .filter(id=>!updated.unitIds.includes(id));
  } else {
    const task=plan.tasks.find(task=>task.taskId===edit.taskId);
    if (!task) throw new Error('unknown-task-id');
    if (edit.type==='replace-new-word') {
      if (!context) throw new Error('word-history-required');
      if (task.category!=='new-word' || task.action.kind!=='practice' || !task.action.itemKeys.includes(edit.fromItemKey)) throw new Error('unknown-plan-word');
      const live=catalog.subjects.flatMap(subject=>subject.words);
      const from=plan.vocabulary.snapshot?.find(word=>word.itemKey===edit.fromItemKey)??live.find(word=>word.itemKey===edit.fromItemKey);
      const to=live.find(word=>word.itemKey===edit.toItemKey);
      if (!from || !to || to.subjectId!==task.subjectId || to.completionRule!==task.completionRule) throw new Error('incompatible-word-source');
      const fromKey=lexemeKey(from),toKey=lexemeKey(to);
      const oldState=context.words.find(word=>word.lexemeKey===fromKey);
      const nextState=context.words.find(word=>word.lexemeKey===toKey);
      if (oldState?.status==='initial-in-progress' || oldState?.status==='learned') throw new Error('cannot-replace-started-word');
      if (!oldState || oldState.status!=='unseen' || !nextState || !['unseen','initial-in-progress'].includes(nextState.status)) throw new Error('not-new-word');
      if (fromKey!==toKey && plan.vocabulary.assignedLexemeKeys.includes(toKey)) throw new Error('duplicate-plan-word');
      task.action.itemKeys=task.action.itemKeys.map(key=>key===edit.fromItemKey?to.itemKey:key);
      task.sourceHash=await taskSourceHash(task,catalog);
      plan.vocabulary.assignedLexemeKeys=plan.vocabulary.assignedLexemeKeys.map(key=>key===fromKey?toKey:key);
      const snapshot=plan.vocabulary.snapshot??live.filter(word=>plan.vocabulary.assignedLexemeKeys.includes(lexemeKey(word)));
      plan.vocabulary.snapshot=[...snapshot.filter(word=>lexemeKey(word)!==fromKey && lexemeKey(word)!==toKey),structuredClone(to)];
      plan.vocabulary.manualSelection=true;
      plan.vocabulary.lockedItemKeys=unique(plan.tasks.filter(item=>item.category==='new-word').flatMap(item=>item.action.kind==='practice'?item.action.itemKeys:[]));
      plan.manual.lockedTaskIds=unique([...plan.manual.lockedTaskIds,task.taskId]);
    } else if (edit.type==='refresh-source') {
      const allocationBlock=plan.longTermAllocation&&(task.category==='subject'||task.blockedReason===LONG_TERM_PREREQUISITE_BLOCK)?task.blockedReason:undefined;
      const subject=catalog.subjects.find(subject=>subject.subjectId===task.subjectId);
      if (!subject) throw new Error('unknown-task-subject');
      if (task.unitIds.length===1) {
        const unit=subject.units.find(unit=>unit.unitId===task.unitIds[0]);
        if (!unit) throw new Error('unknown-task-unit');
        task.title=unit.title;task.action=structuredClone(unit.action);task.completionRule=unit.completionRule;
      } else if (task.category==='new-word' && task.action.kind==='practice') {
        if (!context) throw new Error('word-history-required');
        const old=plan.vocabulary.snapshot??[];
        const replacements=task.action.itemKeys.map(key=>{
          const before=old.find(word=>word.itemKey===key),live=subject.words.find(word=>word.itemKey===key);
          if (!before || !live || lexemeKey(before)!==lexemeKey(live) || before.completionRule!==live.completionRule) throw new Error('word-identity-changed');
          const state=context.words.find(word=>word.lexemeKey===lexemeKey(live));
          if (!state || (!['unseen','initial-in-progress'].includes(state.status) && (!state.firstLearnedAt || studyDay(state.firstLearnedAt)!==plan.day))) throw new Error('not-new-word');
          return structuredClone(live);
        });
        const changed=new Map(replacements.map(word=>[word.itemKey,word]));
        plan.vocabulary.snapshot=old.map(word=>changed.get(word.itemKey)??word);
      }
      task.sourceHash=await taskSourceHash(task,catalog);
      delete task.blockedReason;
      if(allocationBlock)task.blockedReason=allocationBlock;
      if (task.category==='review') {
        const round=context?.reviews?.find(round=>round.roundId===task.reviewRoundId);
        if (!round || task.action.kind!=='practice' || round.itemKey!==task.action.itemKeys[0]) throw new Error('review-history-required');
        if (round.blockedReason) task.blockedReason=round.blockedReason;
      }
      plan.manual.lockedTaskIds=unique([...plan.manual.lockedTaskIds,task.taskId]);
      pinWordChoices(plan,task);
    } else if (edit.type==='remove') {
      if (task.required) throw new Error('required-task-cannot-be-removed');
      if (task.category==='new-word' && task.action.kind==='practice') {
        const keys=task.action.itemKeys;
        const remainingKeys=new Set(plan.tasks.filter(item=>item.taskId!==task.taskId && item.category==='new-word')
          .flatMap(item=>item.action.kind==='practice'?item.action.itemKeys:[]));
        const retained=new Set((plan.vocabulary.snapshot??[]).filter(word=>remainingKeys.has(word.itemKey)).map(lexemeKey));
        const removed=(plan.vocabulary.snapshot??[]).filter(word=>keys.includes(word.itemKey)).map(lexemeKey).filter(key=>!retained.has(key));
        plan.vocabulary.excludedLexemeKeys=unique([...(plan.vocabulary.excludedLexemeKeys??[]),...removed]);
        plan.vocabulary.excludedItemKeys=unique([...(plan.vocabulary.excludedItemKeys??[]),...keys]);
        plan.vocabulary.lockedLexemeKeys=plan.vocabulary.lockedLexemeKeys?.filter(key=>!removed.includes(key));
        plan.vocabulary.lockedItemKeys=plan.vocabulary.lockedItemKeys?.filter(key=>!keys.includes(key));
        plan.vocabulary.assignedLexemeKeys=plan.vocabulary.assignedLexemeKeys.filter(key=>!removed.includes(key));
        plan.vocabulary.snapshot=plan.vocabulary.snapshot?.filter(word=>!keys.includes(word.itemKey));
      }
      plan.tasks=plan.tasks.filter(task=>task.taskId!==edit.taskId);
      plan.manual.lockedTaskIds=plan.manual.lockedTaskIds.filter(id=>id!==edit.taskId);
      plan.manual.excludedUnitIds=unique([...plan.manual.excludedUnitIds,...task.unitIds]);
    } else {
      plan.manual.lockedTaskIds=unique([...plan.manual.lockedTaskIds,task.taskId]);
      pinWordChoices(plan,task);
      if (edit.type==='move') {
        if (edit.beforeTaskId===edit.taskId) return value;
        const others=plan.tasks.filter(item=>item.taskId!==task.taskId);
        const index=edit.beforeTaskId===null?others.length:others.findIndex(item=>item.taskId===edit.beforeTaskId);
        if (index<0) throw new Error('unknown-task-order-anchor');
        others.splice(index,0,task);plan.tasks=others;plan.manual.order=others.map(item=>item.taskId);
      }
    }
  }
  if (plan.manual.order) plan.manual.order=applyOrder(plan.tasks,plan.manual.order).map(task=>task.taskId);
  plan.draftVersion++;
  return seal(plan);
}

export async function mergeTaskPlans(oldValue:TaskPlanV2,newValue:TaskPlanV2,completedTaskIds:string[],catalog:PlanningCatalog,reviews:ReviewObligation[]=[],retainedTaskIds:string[]=[]):Promise<TaskPlanV2> {
  const previous=parseTaskPlan(oldValue),generated=parseTaskPlan(newValue);
  if (previous.day!==generated.day) return generated;
  const aliases=new Map(reviews.flatMap(round=>(round.aliasRoundIds??[]).map(alias=>[alias,round] as const)));
  const retarget=(task:DailyTask):DailyTask=>{
    const round=task.category==='review' && task.reviewRoundId?aliases.get(task.reviewRoundId):undefined;
    if (!round || task.action.kind!=='practice' || task.action.itemKeys.length!==1 || task.action.itemKeys[0]!==round.itemKey) return task;
    return {...task,taskId:round.roundId,reviewRoundId:round.roundId};
  };
  const protectedIds=new Set([...previous.manual.lockedTaskIds,...completedTaskIds,...retainedTaskIds]);
  // Word choices are regenerated at lexeme granularity, including completed/extra splits.
  const protectedTasks=new Map<string,{task:DailyTask;locked:boolean}>();
  for(const original of previous.tasks.filter(task=>task.category!=='new-word' && protectedIds.has(task.taskId))) {
    const task=retarget(original),locked=previous.manual.lockedTaskIds.includes(original.taskId),existing=protectedTasks.get(task.taskId);
    // Completed rows preserve history; explicit edits have priority when two IDs coalesce.
    if (!existing || (locked && !existing.locked)) protectedTasks.set(task.taskId,{task,locked});
  }
  const tasks=await Promise.all([...protectedTasks.values()].map(({task})=>retainedTask(task,catalog)));
  const exclusions=new Set(previous.manual.excludedUnitIds);
  const allocatedBlocks=new Set<string>();
  for (const fresh of generated.tasks) {
    if (!fresh.required && fresh.unitIds.some(id=>exclusions.has(id))) continue;
    const existing=tasks.find(task=>task.taskId===fresh.taskId || (task.unitIds.length>0 && fresh.unitIds.some(id=>task.unitIds.includes(id)))
      || (generated.longTermAllocation&&coversAllocatedPractice(task,fresh,catalog)));
    if (existing) {
      if (fresh.required) {existing.required=true;existing.goalId=fresh.goalId;}
      if (existing.category==='review' && fresh.reviewRoundId===existing.reviewRoundId) {
        const checked=await retainedTask({...existing,blockedReason:fresh.blockedReason},catalog);
        if (checked.blockedReason) existing.blockedReason=checked.blockedReason;
        else delete existing.blockedReason;
      } else if (fresh.blockedReason) {existing.blockedReason=fresh.blockedReason;allocatedBlocks.add(existing.taskId);}
      else if(generated.longTermAllocation&&!allocatedBlocks.has(existing.taskId)&&existing.blockedReason===LONG_TERM_PREREQUISITE_BLOCK
        &&((existing.sourceHash===fresh.sourceHash&&same(existing.action,fresh.action))||coversAllocatedPractice(existing,fresh,catalog)))delete existing.blockedReason;
    } else tasks.push(fresh);
  }
  const successors=(id:string):string[]=>{
    const old=previous.tasks.find(task=>task.taskId===id);
    if (old?.category==='review') return [retarget(old).taskId];
    if (old?.category!=='new-word' || old.action.kind!=='practice') return [id];
    const keys=old.action.itemKeys;
    return tasks.filter(task=>task.category==='new-word' && task.action.kind==='practice' && task.action.itemKeys.some(key=>keys.includes(key))).map(task=>task.taskId);
  };
  const order=previous.manual.order?unique(previous.manual.order.flatMap(successors))
    :retainedTaskIds.length?unique(previous.tasks.flatMap(task=>successors(task.taskId))):undefined;
  const ordered=applyOrder(tasks,order);
  const ids=new Set(ordered.map(task=>task.taskId));
  return seal({...generated,draftVersion:Math.max(previous.draftVersion,generated.draftVersion)+1,tasks:ordered,
    manual:{lockedTaskIds:unique(previous.manual.lockedTaskIds.flatMap(successors)).filter(id=>ids.has(id)),excludedUnitIds:[...exclusions],
      ...(previous.manual.order?{order:ordered.map(task=>task.taskId)}:{})}});
}
