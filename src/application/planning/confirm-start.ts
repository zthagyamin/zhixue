// @ts-expect-error TS5097: standalone Node source contracts.
import {canonicalLongTermJson,selectStudyTask,practiceBudgetView} from '../../domain/planning/index.ts';
import type {LongTermDailyAllocation} from '../../domain/planning';
export type ApprovalPlan={day:string;cloudPlanHash:string;catalogHash:string;tasks:Array<Parameters<typeof selectStudyTask>[0]['tasks'][number]&{subjectId?:string;category?:string}>;longTermAllocation?:LongTermDailyAllocation;manual?:{lockedTaskIds:string[]}};
export type ApprovalState<Plan extends ApprovalPlan>={day:string;revision:number;currentPlan:Plan|null;approvedPlan:Plan|null;approvedOperationId:string|null};
export type PlanApprovalCommand={action:'approve';operationId:string;expectedRevision:number;day:string;planHash:string;predecessorOperationId:string|null};
export type ApprovedActivity={withheldTaskIds?:string[];completedTaskIds:string[];startedTaskIds:string[];pendingItemByTask:Record<string,string>};
export type ApprovalPorts<Plan extends ApprovalPlan,State extends ApprovalState<Plan>,Source extends {cloud:Plan}>={
  validateDraft:(draft:Plan)=>void|Promise<void>;assertEvidence:()=>Promise<void>;
  approve:(command:PlanApprovalCommand)=>Promise<{status:unknown}>;readState:()=>Promise<State>;
  prepareSource:(state:State)=>Promise<Source|null>;loadActivity:(source:Source)=>Promise<ApprovedActivity>;
};
export type ConfirmedStart<Source>={source:Source;taskId:string;resumeItemKey?:string};

/** Approval is not readiness: two verified reads surround source and completion preparation. */
export async function confirmPlanAndPrepareStart<Plan extends ApprovalPlan,State extends ApprovalState<Plan>,Source extends {cloud:Plan}>(
  input:{state:State;day:string;isCurrent:()=>boolean;newId:()=>string},ports:ApprovalPorts<Plan,State,Source>,
):Promise<ConfirmedStart<Source>|null>{
  const state=structuredClone(input.state),draft=state.currentPlan,{day,isCurrent}=input;
  if(!draft||!isCurrent())return null;
  if(state.day!==day||draft.day!==day)throw Error('草稿日期已变化，请重新生成今日安排。');
  await ports.validateDraft(draft);
  if(!draft.tasks.some(task=>task.action.kind==='practice'&&!task.blockedReason))throw Error('草稿暂无可开始的自测，请先调整安排。');
  if(!isCurrent())return null;
  await ports.assertEvidence();if(!isCurrent())return null;
  const operationId=input.newId();
  const result=await ports.approve({action:'approve',operationId,expectedRevision:state.revision,day,planHash:draft.cloudPlanHash,predecessorOperationId:state.approvedOperationId});
  if(result.status!=='accepted'&&result.status!=='duplicate'){
    if(isCurrent())await ports.readState();
    throw Error(result.status==='stale'?'批准前计划已变化，请核对最新草稿后重新确认。':'批准未成功，尚未开始自测。');
  }
  if(!isCurrent())return null;
  const matches=(value:State)=>Number.isSafeInteger(value.revision)&&value.revision>state.revision&&value.day===day
    &&value.approvedOperationId===operationId&&value.approvedPlan?.cloudPlanHash===draft.cloudPlanHash&&value.approvedPlan.day===day;
  const fresh=await ports.readState();if(!isCurrent())return null;
  if(!matches(fresh))throw Error('批准结果尚未完整核对，请刷新今日安排；未开始自测。');
  const source=await ports.prepareSource(fresh);if(!isCurrent())return null;
  if(!source)throw Error('已批准计划的题目尚未就绪，请刷新后重试。');
  const activity=await ports.loadActivity(source);if(!isCurrent())return null;
  let tasks=source.cloud.tasks;
  if(source.cloud.longTermAllocation?.practiceBudgetGroups?.length){
    if(tasks.some(task=>!task.subjectId||!task.category))throw Error('共享预算的任务身份不完整，请重新核对安排。');
    tasks=practiceBudgetView(tasks.filter(task=>!activity.withheldTaskIds?.includes(task.taskId)).map(task=>({...task,subjectId:task.subjectId!,category:task.category!})),
      source.cloud.longTermAllocation.reviewTarget??undefined,0,activity.completedTaskIds,[...activity.startedTaskIds,...source.cloud.manual?.lockedTaskIds??[]],[],source.cloud.longTermAllocation.practiceBudgetGroups).visible;
  }
  const next=selectStudyTask({ready:true,tasks,completedTaskIds:activity.completedTaskIds,startedTaskIds:activity.startedTaskIds,withheldTaskIds:activity.withheldTaskIds});
  if(!next)throw Error('安排已确认，当前没有未完成且可开始的自测。');
  await ports.assertEvidence();if(!isCurrent())return null;
  const verified=await ports.readState();if(!isCurrent())return null;
  if(!matches(verified)||verified.revision!==fresh.revision)throw Error('确认后计划又有更新，请核对今日安排后开始。');
  return {source,taskId:next.taskId,resumeItemKey:activity.pendingItemByTask[next.taskId]};
}

/** A page session owns duplicate-click exclusion and stable approval identities across retries. */
export function createPlanConfirmationSession(newId:()=>string){
  let epoch=0,busy=false;const requests=new Map<string,string>();
  return {
    isPending:()=>busy,
    invalidate(){epoch++;busy=false;},
    async run<Plan extends ApprovalPlan,State extends ApprovalState<Plan>,Source extends {cloud:Plan}>(
      input:{scope:string;day:string;state:State;isCurrent:()=>boolean},ports:ApprovalPorts<Plan,State,Source>,
    ):Promise<ConfirmedStart<Source>|null>{
      if(busy||!input.state.currentPlan||!input.isCurrent())return null;
      const token=++epoch;busy=true;
      try{
        const key=canonicalLongTermJson([input.scope,input.day,input.state.revision,input.state.currentPlan.cloudPlanHash,input.state.approvedOperationId]);
        const id=requests.get(key)??newId();requests.set(key,id);
        const result=await confirmPlanAndPrepareStart({...input,isCurrent:()=>token===epoch&&input.isCurrent(),newId:()=>id},ports);
        if(result&&token===epoch)requests.delete(key);
        return result;
      }finally{if(token===epoch)busy=false;}
    },
  };
}
