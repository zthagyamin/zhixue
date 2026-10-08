// @ts-expect-error TS5097: standalone Node source contracts.
import {reviewGoalView} from './study-review-goal.ts';

export type PracticeBudgetGroup={id:string;title:string;subjectIds:string[];minutes:number;defaultItemMinutes:number};
export const PRACTICE_BUDGET_CAPABILITY='practice-budget-v1';
export function parsePracticeBudgetGroups(value:unknown):PracticeBudgetGroup[]{
  const fail=()=>{throw Error('invalid-practice-budget-groups');};
  if(!Array.isArray(value)||value.length>8)return fail();
  const ids=new Set<string>(),subjects=new Set<string>();
  const text=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=500&&!['__proto__','constructor','prototype'].includes(v)&&![...v].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127);
  for(const group of value){
    if(!group||typeof group!=='object'||Array.isArray(group)||!text(group.id)||!text(group.title)||ids.has(group.id))return fail();
    ids.add(group.id);
    if(!Array.isArray(group.subjectIds)||!group.subjectIds.length)return fail();
    for(const subject of group.subjectIds){if(!text(subject)||subjects.has(subject))return fail();subjects.add(subject);}
    if(!Number.isInteger(group.minutes)||group.minutes<0||group.minutes>180||!Number.isInteger(group.defaultItemMinutes)||group.defaultItemMinutes<1||group.defaultItemMinutes>30)return fail();
    if(Object.keys(group).some(key=>!['id','title','subjectIds','minutes','defaultItemMinutes'].includes(key)))return fail();
  }
  return structuredClone(value);
}
type BudgetTask={taskId:string;subjectId:string;category:string;action:{kind:string};estimatedMinutes?:number};
export type PracticeBudgetSummary={group:PracticeBudgetGroup;estimatedMinutes:number;defaultEstimateCount:number;protectedMinutes:number;overMinutes:number;deferredTaskIds:string[]};

/** View only. Never changes tasks, due dates, physical identities or completion evidence. */
export function practiceBudgetView<T extends BudgetTask>(tasks:readonly T[],target:number|undefined,extra:number,completedIds:readonly string[],startedIds:readonly string[]=[],selectedIds:readonly string[]=[],groups?:readonly PracticeBudgetGroup[]){
  if(!groups?.length)return {...reviewGoalView(tasks,target,extra,completedIds,startedIds,selectedIds),budgetDeferred:[] as T[],budgets:[] as PracticeBudgetSummary[],reviewOverTarget:0};
  const protectedIds=new Set([...completedIds,...startedIds,...selectedIds]);
  const applicable=(task:T)=>task.action.kind==='practice'&&(task.category==='review'||task.category==='subject')?groups.find(group=>group.subjectIds.includes(task.subjectId)):undefined;
  const estimate=(task:T,group:PracticeBudgetGroup)=>Number.isFinite(task.estimatedMinutes)&&task.estimatedMinutes!>0?task.estimatedMinutes!:group.defaultItemMinutes;
  const used=new Map(groups.map(group=>[group.id,0]));
  const add=(task:T)=>{const group=applicable(task);if(group)used.set(group.id,used.get(group.id)!+estimate(task,group));};
  for(const task of tasks)if(protectedIds.has(task.taskId))add(task);
  const protectedMinutes=new Map(used),rejected=new Set<string>();
  const fits=(task:T)=>{const group=applicable(task);return !group||used.get(group.id)!+estimate(task,group)<=group.minutes;};
  // Apply capacity before the global count, so deferred group work cannot crowd out other subjects.
  for(const task of tasks)if(task.category==='review'&&!protectedIds.has(task.taskId)){
    if(fits(task))add(task);else rejected.add(task.taskId);
  }
  const goal=reviewGoalView(tasks.filter(task=>!rejected.has(task.taskId)),target,extra,completedIds,startedIds,selectedIds);
  const chosen=new Set(goal.visible.filter(task=>task.category==='review').map(task=>task.taskId));
  for(const [id,minutes] of protectedMinutes)used.set(id,minutes);
  for(const task of tasks)if(chosen.has(task.taskId)&&!protectedIds.has(task.taskId))add(task);
  for(const task of tasks)if(task.category!=='review'){
    if(protectedIds.has(task.taskId)||fits(task)){chosen.add(task.taskId);if(!protectedIds.has(task.taskId))add(task);}
    else rejected.add(task.taskId);
  }
  const visible=tasks.filter(task=>chosen.has(task.taskId));
  const budgets=groups.map(group=>({group,estimatedMinutes:used.get(group.id)!,protectedMinutes:protectedMinutes.get(group.id)!,overMinutes:Math.max(0,used.get(group.id)!-group.minutes),
    defaultEstimateCount:visible.filter(task=>applicable(task)?.id===group.id&&!(Number.isFinite(task.estimatedMinutes)&&task.estimatedMinutes!>0)).length,
    deferredTaskIds:tasks.filter(task=>applicable(task)?.id===group.id&&!chosen.has(task.taskId)).map(task=>task.taskId)}));
  return {...goal,visible,deferred:tasks.filter(task=>task.category==='review'&&!chosen.has(task.taskId)),total:tasks.filter(task=>task.category==='review').length,
    budgetDeferred:tasks.filter(task=>rejected.has(task.taskId)),budgets,
    reviewOverTarget:target===undefined?0:Math.max(0,visible.filter(task=>task.category==='review').length-Math.max(0,Math.floor(target))-Math.max(0,Math.floor(extra)))};
}
