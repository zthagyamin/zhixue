import type {DailyTask,PlanningCatalog,TaskPlanV2} from './task-plan-types';
import type {PlanCandidate} from './daily-plan';
import type {SubjectRound} from './subject-round';
// @ts-expect-error TS5097: standalone Node regression tests.
import {practicePlanForTask} from './task-plan-runtime.ts';
// @ts-expect-error TS5097: standalone Node regression tests.
import {isSubjectPassComplete} from './subject-round.ts';

export type StudyPracticeGroup={id:string;tasks:DailyTask[];itemKeys:string[];keysByTask:Record<string,string[]>;progressKeysByTask:Record<string,string[]>;adapter:PlanCandidate};
/** Presentation only. Original tasks, review anchors and recorded outcomes remain unchanged. */
export function studyPracticeGroups(plan:TaskPlanV2,catalog:PlanningCatalog,kindForItem:(key:string,subjectId:string)=>string|undefined,eligibleTaskIds?:readonly string[],progressKeyForItem?:(key:string,subjectId:string)=>string,canPracticeItem?:(key:string,subjectId:string)=>boolean):StudyPracticeGroup[]{
  const words=catalog.subjects.flatMap(subject=>subject.words);
  const canonical=(key:string,subjectId:string)=>words.find(word=>word.subjectId===subjectId&&(word.itemKey===key||word.legacyKeys?.includes(key)))?.itemKey??key;
  const bins=new Map<string,Array<{tasks:DailyTask[];keys:Set<string>}>>();
  for(const task of plan.tasks){
    if(task.action.kind!=='practice'||task.blockedReason||!task.action.itemKeys.length)continue;
    const keys=task.action.itemKeys.map(key=>canonical(key,task.subjectId)).filter(key=>canPracticeItem?.(key,task.subjectId)??true);
    if(!keys.length)continue;
    const modes=[...new Set(keys.map(key=>kindForItem(key,task.subjectId)??`unknown:${task.taskId}`))].sort();
    const key=JSON.stringify([task.subjectId,task.category,modes]);
    const buckets=bins.get(key)??[],bucket=buckets.find(bucket=>keys.every(key=>!bucket.keys.has(key)));
    // A fresh review of the same item must not borrow an older round's completion.
    if(bucket){bucket.tasks.push(task);for(const key of keys)bucket.keys.add(key);}
    else buckets.push({tasks:[task],keys:new Set(keys)});
    bins.set(key,buckets);
  }
  return [...bins].flatMap(([kind,buckets])=>buckets.flatMap(({tasks:allTasks})=>{
    const tasks=eligibleTaskIds?allTasks.filter(task=>eligibleTaskIds.includes(task.taskId)):allTasks;
    if(!tasks.length)return [];
    const keysByTask=Object.fromEntries(tasks.map(task=>[task.taskId,task.action.kind==='practice'?task.action.itemKeys.map(key=>canonical(key,task.subjectId)).filter(key=>canPracticeItem?.(key,task.subjectId)??true):[]]));
    const progressKeysByTask=Object.fromEntries(tasks.map(task=>[task.taskId,keysByTask[task.taskId].map(key=>progressKeyForItem?.(key,task.subjectId)??key)]));
    const itemKeys=[...new Set(tasks.flatMap(task=>keysByTask[task.taskId]))];
    const adapters=tasks.map(task=>practicePlanForTask(plan,task.taskId,catalog));
    const entries=adapters.flatMap(adapter=>adapter.items).flatMap(entry=>{
      const ref=entry.practice;if(!ref)return [];
      const keys=ref.itemKeys.filter(key=>itemKeys.includes(canonical(key,ref.subjectId)));
      return keys.length?[{...entry,practice:{...ref,itemKeys:keys,count:keys.length}}]:[];
    });
    const first=entries[0];
    const items:PlanCandidate['items']=entries.every(entry=>entry.practice?.kind==='vocab-group')
      ?[{...first,title:`${tasks[0].category==='review'?'复习':'新词学习'} · ${itemKeys.length} 词`,practice:{...first.practice!,kind:'vocab-group',itemKeys,count:itemKeys.length,groupIndex:0,groupQuota:itemKeys.length}}]
      :entries.filter((entry,index)=>entries.findIndex(other=>other.itemKey===entry.itemKey)===index);
    const members=[...allTasks].sort((a,b)=>a.taskId<b.taskId?-1:a.taskId>b.taskId?1:0).map(task=>[task.taskId,task.sourceHash,task.reviewRoundId??null,task.action]);
    return [{id:JSON.stringify([kind,members]),tasks,itemKeys,keysByTask,progressKeysByTask,adapter:{...adapters[0],items,totalMinutes:adapters.reduce((sum,adapter)=>sum+adapter.totalMinutes,0)}}];
  }));
}
export function practiceGroupScope(owner:string,library:string,day:string,group:StudyPracticeGroup):string{
  return JSON.stringify([owner,library,day,'practice-group',group.id]);
}
export function practiceGroupNavigation(groups:StudyPracticeGroup[],getRound:(scope:string)=>SubjectRound|undefined,owner:string,library:string,day:string,tasks?:readonly DailyTask[]){
  const finishedPassTaskIds:string[]=[],practiceGroupByTask:Record<string,string>={};
  for(const group of groups){
    const round=getRound(practiceGroupScope(owner,library,day,group));
    for(const task of group.tasks){practiceGroupByTask[task.taskId]=group.id;if(round&&isSubjectPassComplete(round,group.progressKeysByTask[task.taskId]))finishedPassTaskIds.push(task.taskId);}
  }
  const withheldTaskIds=tasks?.filter(task=>task.action.kind==='practice'&&!task.blockedReason&&!groups.some(group=>group.tasks.some(member=>member.taskId===task.taskId))).map(task=>task.taskId);
  return {finishedPassTaskIds,practiceGroupByTask,...(withheldTaskIds?{withheldTaskIds}:{})};
}
export function practiceSelectionScope(owner:string,library:string,plan:TaskPlanV2):string{
  return JSON.stringify([owner,library,plan.day,plan.sourceHash,plan.longTermAllocation?.reviewTarget??null,...(plan.longTermAllocation?.practiceBudgetGroups?.length?[plan.longTermAllocation.practiceBudgetGroups]:[])]);
}
