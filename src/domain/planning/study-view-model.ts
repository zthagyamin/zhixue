export type StudyPlanSummary = {state:'loading'|'empty'|'active'|'complete';label:string;remaining:number|null};
export type StudyTaskLead={taskId:string;title:string;kind:'next'|'continue';estimatedMinutes?:number};
export type StudyFocusSummary={groups:number|null;minutes:number|null;leadMinutes?:number|null;newWords?:number;blocked:number;finishedPasses?:number;withheld?:number};
type PracticeNavigation={finishedPassTaskIds?:readonly string[];practiceGroupByTask?:Record<string,string>;withheldTaskIds?:readonly string[]};
export function studyFocusSummary(input:{ready:boolean;tasks:ReadonlyArray<{taskId:string;category?:string;quantity?:number;action:{kind:string};estimatedMinutes?:number;blockedReason?:string}>;completedTaskIds:readonly string[]}&PracticeNavigation):StudyFocusSummary{
  if(!input.ready)return{groups:null,minutes:null,blocked:0};
  const pending=input.tasks.filter(task=>task.action.kind==='practice'&&!input.completedTaskIds.includes(task.taskId)&&!input.finishedPassTaskIds?.includes(task.taskId)&&!input.withheldTaskIds?.includes(task.taskId));
  const known=pending.every(task=>typeof task.estimatedMinutes==='number'&&Number.isFinite(task.estimatedMinutes)&&task.estimatedMinutes>=0);
  const newWords=input.tasks.filter(task=>task.category==='new-word').reduce((sum,task)=>sum+(task.quantity??0),0);
  return{...(newWords?{newWords}:{}),groups:new Set(pending.map(task=>input.practiceGroupByTask?.[task.taskId]??task.taskId)).size,minutes:known?Math.ceil(pending.reduce((sum,task)=>sum+task.estimatedMinutes!,0)):null,blocked:pending.filter(task=>task.blockedReason).length,...(input.finishedPassTaskIds?.length?{finishedPasses:input.finishedPassTaskIds.length}:{}),...(input.withheldTaskIds?.length?{withheld:input.withheldTaskIds.length}:{})};
}
export function selectStudyTask(input:{ready:boolean;tasks:Array<{taskId:string;title:string;blockedReason?:string;estimatedMinutes?:number;action:{kind:string}}> ;completedTaskIds:string[];startedTaskIds:string[]}&PracticeNavigation):StudyTaskLead|null {
  if(!input.ready)return null;
  const tasks=input.tasks.filter(task=>task.action.kind==='practice'&&!task.blockedReason&&!input.completedTaskIds.includes(task.taskId)&&!input.finishedPassTaskIds?.includes(task.taskId)&&!input.withheldTaskIds?.includes(task.taskId));
  const startedGroups=new Set(input.startedTaskIds.map(id=>input.practiceGroupByTask?.[id]).filter(Boolean));
  const resumed=tasks.find(task=>input.startedTaskIds.includes(task.taskId)||startedGroups.has(input.practiceGroupByTask?.[task.taskId])),next=resumed??tasks[0];
  if(!next)return null;
  const estimate=next.estimatedMinutes;
  return{taskId:next.taskId,title:next.title,kind:resumed?'continue':'next',...(typeof estimate==='number'&&Number.isFinite(estimate)&&estimate>=0?{estimatedMinutes:estimate}:{})};
}

/** Presentation only: callers supply their own authoritative plan and completion counts. */
export function studyPlanSummary(input:{ready:boolean;hasPlan:boolean;total:number;completed:number}):StudyPlanSummary {
  if(!input.ready)return {state:'loading',label:'正在核对今日安排',remaining:null};
  if(!input.hasPlan)return {state:'empty',label:'还没有今日安排',remaining:null};
  if(input.total===0)return {state:'empty',label:'当前没有可执行任务',remaining:0};
  const completed=Math.min(input.total,Math.max(0,input.completed));
  return completed===input.total
    ? {state:'complete',label:'本次安排已完成',remaining:0}
    : {state:'active',label:`已完成 ${completed} / ${input.total} 项`,remaining:input.total-completed};
}
