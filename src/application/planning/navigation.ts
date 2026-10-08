import type {DailyTask,PlanningCatalog,TaskPlanV2,StudyPracticeGroup,SubjectRound} from '../../domain/planning';
// @ts-expect-error TS5097: standalone Node source contracts.
import {canonicalLongTermJson,taskSourceHash,practiceBudgetView,practiceSelectionScope,practiceGroupNavigation,practiceGroupScope,selectStudyTask,restoredSubjectRound,firstPendingRoundIndex} from '../../domain/planning/index.ts';

export type PlanningNavigationScope={owner:string;libraryId:string;day:string;mode:'native'|'account'};
export type PlanningNavigationLease={scope:PlanningNavigationScope;current:()=>boolean};
export type PlanningAccountEntry={taskId:string;resumeItemKey?:string;eligibleTaskIds?:string[]};
export class SubjectPlanUnavailableError extends Error {}
export type PlanningNavigationSource<Context>={
  ready:boolean;plan:TaskPlanV2;catalog:PlanningCatalog;libraryId:string;
  completedTaskIds:string[];startedTaskIds:string[];pendingItemByTask:Record<string,string>;
  selection?:{scope:string;taskIds:string[]}|null;context:Context;
};
export type PlanningEntry<Context>={source:PlanningNavigationSource<Context>;task:DailyTask;group:StudyPracticeGroup;index:number;selection:{scope:string;taskIds:string[]}};
export type PlanningNavigationPorts<Context,AccountQuery extends PlanningAccountEntry>={
  begin:(kind:'native'|'account'|'continue'|'subject')=>PlanningNavigationLease|null;finish:(lease:PlanningNavigationLease)=>void;
  canContinue:()=>boolean;setContinuing:(value:boolean,lease:PlanningNavigationLease)=>void;
  prepareLeave:()=>null|(()=>boolean);
  loadNative:(lease:PlanningNavigationLease,continuing:boolean)=>Promise<PlanningNavigationSource<Context>|null>;
  loadAccount:(lease:PlanningNavigationLease,query?:AccountQuery)=>Promise<PlanningNavigationSource<Context>|null>;
  loadSubject?:(lease:PlanningNavigationLease)=>Promise<PlanningNavigationSource<Context>|null>;
  groups:(source:PlanningNavigationSource<Context>,eligible?:readonly string[])=>StudyPracticeGroup[];
  verify:(source:PlanningNavigationSource<Context>,tasks:DailyTask[],latest:boolean)=>void|Promise<void>;
  persistStarted:(source:PlanningNavigationSource<Context>,ids:string[],isCurrent:()=>boolean)=>Promise<boolean>;
  groupItems:(source:PlanningNavigationSource<Context>,group:StudyPracticeGroup)=>{keys:string[];completedKeys:string[]};
  getRound:(scope:string)=>SubjectRound|undefined;
  activateRound:(subjectId:string,scope:string,seed:SubjectRound)=>SubjectRound;
  enter:(entry:PlanningEntry<Context>)=>void;returnToday:(lease:PlanningNavigationLease)=>void;
  openSubject?:(subjectId:string,freeStudy:boolean)=>void;
  openNote:(note:string)=>void;message:(message:string)=>void;
};

/** One navigation lease spans source verification, guarded start persistence and final entry. */
export function createPlanningNavigator<Context,AccountQuery extends PlanningAccountEntry>(ports:PlanningNavigationPorts<Context,AccountQuery>){
  let continuing:PlanningNavigationLease|null=null;
  const captured=(value:PlanningNavigationSource<Context>|null,lease:PlanningNavigationLease)=>{
    if(!value)return null;
    if(value.plan.day!==lease.scope.day||value.libraryId!==lease.scope.libraryId||value.plan.sourceHash!==value.catalog.sourceHash)throw Error('安排日期或资料范围已变化，请返回今日重新选择。');
    if(!value.ready)throw Error('请先完整同步学习记录，再调整今日安排。');
    return {...value,plan:structuredClone(value.plan),catalog:structuredClone(value.catalog),completedTaskIds:[...value.completedTaskIds],startedTaskIds:[...value.startedTaskIds],
      pendingItemByTask:{...value.pendingItemByTask},selection:value.selection?structuredClone(value.selection):null};
  };
  const visible=(source:PlanningNavigationSource<Context>,lease:PlanningNavigationLease,finished:string[]=[])=>{
    const key=practiceSelectionScope(lease.scope.owner,source.libraryId,source.plan);
    const groups=ports.groups(source),available=new Set(groups.flatMap(group=>group.tasks.map(task=>task.taskId)));
    const protectedStarts=source.plan.longTermAllocation?.practiceBudgetGroups?.length?[...source.plan.manual.lockedTaskIds,...practiceGroupNavigation(groups,ports.getRound,lease.scope.owner,source.libraryId,lease.scope.day,source.plan.tasks).finishedPassTaskIds]:[];
    return practiceBudgetView(source.plan.tasks.filter(task=>task.action.kind!=='practice'||task.blockedReason||available.has(task.taskId)),source.plan.longTermAllocation?.reviewTarget??undefined,0,source.completedTaskIds,
      [...source.startedTaskIds,...finished,...protectedStarts],source.selection?.scope===key?source.selection.taskIds:[],source.plan.longTermAllocation?.practiceBudgetGroups).visible.map(task=>task.taskId);
  };
  const enter=async(source:PlanningNavigationSource<Context>,taskId:string,eligible:string[]|undefined,resume:string|undefined,lease:PlanningNavigationLease,leave:()=>boolean,extra=()=>true)=>{
    const current=()=>lease.current()&&extra();if(!current())return;
    const task=source.plan.tasks.find(value=>value.taskId===taskId);if(!task)return;
    if(lease.scope.mode==='account'&&task.action.kind!=='practice')return;
    const budgeted=Boolean(source.plan.longTermAllocation?.practiceBudgetGroups?.length);
    const currentVisible=visible(source,lease);
    const selected=budgeted?currentVisible.filter(id=>!eligible||eligible.includes(id)):eligible??currentVisible;
    const group=task.action.kind==='practice'?ports.groups(source,selected).find(value=>value.tasks.some(member=>member.taskId===taskId)):null;
    if(task.action.kind==='practice'&&!group)throw Error('这项任务不在当前分组中，请返回今日重新选择。');
    const members=group?.tasks??[task];
    await ports.verify(source,members,false);if(!current())return;
    if(lease.scope.mode==='native'){
      for(const member of members){if(await taskSourceHash(member,source.catalog)!==member.sourceHash)throw Error('任务来源已更新，请先确认资料版本。');if(!current())return;}
      const changed=await ports.persistStarted(source,members.map(member=>member.taskId),current);
      if(!current())return;if(!changed)throw Error('任务资料或安排刚刚更新，请返回今日重新选择。');
      await ports.verify(source,members,true);if(!current())return;
    }
    if(task.action.kind==='manual'){ports.message('任务已固定，完成后可记录本次完成。');return;}
    if(task.action.kind==='open-note'){ports.openNote(task.action.contentRef.replace(/^\[\[|\]\]$/g,'').split('|')[0].split('#')[0]);return;}
    if(!group||!leave()||!current())return;
    const items=ports.groupItems(source,group);
    if(!items.keys.length)throw Error('这项任务的练习题尚未就绪，请同步后重试。');
    const round=ports.activateRound(task.subjectId,practiceGroupScope(lease.scope.owner,source.libraryId,lease.scope.day,group),restoredSubjectRound(items.completedKeys));
    if(!current())return;
    const scope=practiceSelectionScope(lease.scope.owner,source.libraryId,source.plan);
    ports.enter({source,task,group,index:firstPendingRoundIndex(items.keys,round,resume),selection:{scope,taskIds:budgeted?(source.selection?.scope===scope?source.selection.taskIds:[]):selected}});
  };
  const report=(error:unknown,lease:PlanningNavigationLease)=>{if(lease.current())ports.message(error instanceof Error?error.message:'任务暂时无法开始。');};
  return {
    async startSubject(subjectId:string){
      const leave=ports.prepareLeave();if(!leave)return;const lease=ports.begin('subject');if(!lease)return;
      try{
        const source=captured(await (ports.loadSubject?ports.loadSubject(lease):lease.scope.mode==='account'?ports.loadAccount(lease):ports.loadNative(lease,true)),lease);
        if(!lease.current())return;
        if(!source){if(leave()&&lease.current())ports.openSubject?.(subjectId,true);return;}
        const selected=visible(source,lease);
        const subjectTasks=source.plan.tasks.filter(task=>task.subjectId===subjectId&&task.action.kind==='practice');
        const tasks=subjectTasks.filter(task=>selected.includes(task.taskId));
        const navigation=practiceGroupNavigation(ports.groups(source),ports.getRound,lease.scope.owner,source.libraryId,lease.scope.day,source.plan.tasks);
        const next=selectStudyTask({ready:true,tasks,completedTaskIds:source.completedTaskIds,startedTaskIds:source.startedTaskIds,...navigation});
        // Reopen a completed group as a recap; never reduce it to the first completed word.
        const taskId=next?.taskId??tasks.find(task=>!task.blockedReason&&!navigation.withheldTaskIds?.includes(task.taskId))?.taskId;
        if(taskId)await enter(source,taskId,selected,source.pendingItemByTask[taskId],lease,leave);
        else if(subjectTasks.some(task=>task.blockedReason))ports.message('这项任务的资料待核对，请返回今日查看原因。');
        else if(subjectTasks.some(task=>navigation.withheldTaskIds?.includes(task.taskId))){if(leave()&&lease.current())ports.openSubject?.(subjectId,true);}
        else if(subjectTasks.length)ports.message('这个学科的复习尚未列入本次目标，请在今日任务中追加复习。');
        else if(leave()&&lease.current())ports.openSubject?.(subjectId,true);
      }catch(error){
        if(error instanceof SubjectPlanUnavailableError&&lease.current()){if(leave()&&lease.current())ports.openSubject?.(subjectId,false);}
        else report(error,lease);
      }finally{ports.finish(lease);}
    },
    async startNative(taskId:string,eligible?:string[],isCurrent=()=>true){
      const leave=ports.prepareLeave();if(!leave)return;const lease=ports.begin('native');if(!lease||lease.scope.mode!=='native')return;
      try{const source=captured(await ports.loadNative(lease,false),lease);if(source)await enter(source,taskId,eligible,undefined,lease,leave,isCurrent);}
      catch(error){report(error,lease);}finally{ports.finish(lease);}
    },
    async startAccount(query:AccountQuery,isCurrent=()=>true){
      const leave=ports.prepareLeave();if(!leave)return;const lease=ports.begin('account');if(!lease||lease.scope.mode!=='account')return;
      try{const source=captured(await ports.loadAccount(lease,query),lease);if(source)await enter(source,query.taskId,query.eligibleTaskIds,query.resumeItemKey,lease,leave,isCurrent);}
      catch(error){report(error,lease);}finally{ports.finish(lease);}
    },
    async continueToday(){
      if(continuing?.current()||!ports.canContinue())return;
      const lease=ports.begin('continue');if(!lease)return;continuing=lease;ports.setContinuing(true,lease);
      try{
        const source=captured(await (lease.scope.mode==='account'?ports.loadAccount(lease):ports.loadNative(lease,true)),lease);
        if(!lease.current())return;if(!source){ports.returnToday(lease);return;}
        const groups=ports.groups(source),navigation=practiceGroupNavigation(groups,ports.getRound,lease.scope.owner,source.libraryId,lease.scope.day,source.plan.tasks);
        const selected=visible(source,lease,navigation.finishedPassTaskIds);
        const next=selectStudyTask({ready:source.ready,tasks:source.plan.tasks.filter(task=>selected.includes(task.taskId)),completedTaskIds:source.completedTaskIds,startedTaskIds:source.startedTaskIds,...navigation});
        if(!lease.current())return;if(!next){ports.returnToday(lease);return;}
        const leave=ports.prepareLeave();if(leave)await enter(source,next.taskId,selected,source.pendingItemByTask[next.taskId],lease,leave);
      }catch(error){report(error,lease);}
      finally{if(continuing===lease){continuing=null;ports.setContinuing(false,lease);}ports.finish(lease);}
    },
  };
}

/** Ignore locking metadata, but reject changed task membership/content before a queued start. */
export function sameStartTasks(before:TaskPlanV2,after:TaskPlanV2|null,ids:readonly string[]):boolean{
  if(!after||before.day!==after.day||before.sourceHash!==after.sourceHash)return false;
  return ids.every(id=>{
    const first=before.tasks.find(task=>task.taskId===id),latest=after.tasks.find(task=>task.taskId===id);
    return Boolean(first&&latest&&canonicalLongTermJson(first)===canonicalLongTermJson(latest));
  });
}
