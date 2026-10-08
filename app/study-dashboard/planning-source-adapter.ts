import type {PlanningNavigationLease,PlanningNavigationSource,TaskPlanningSession,PlanningAccountEntry} from '../../src/application/planning';
import {sameStartTasks,SubjectPlanUnavailableError} from '../../src/application/planning';
import {studyPracticeGroups,nativeTaskCompletedKeys,assertPlanningStudySources,type TaskPlanV2,type PlanningCatalog,type StudyPracticeGroup} from '../../src/domain/planning';
import {normalizeDynamicSubjects,resolveStudyItemProgressKey,stableStudyItemKey,type DynamicSubject} from '../dynamic-ui-model';
import {pluginItemKey,resolvePluginType,type PluginOverrides} from '../plugin-routing';
import {checkContentQuality} from '../../src/domain/assessment';
import {filterPlanSubject} from '../plan-runtime';
import type {CloudProgress} from '../cloud-sync-types';
import type {NativeProjection} from '../native-progress-view';
import type {AccountStudyLoaded} from '../account-study-client';
import {accountStudyPayload} from '../account-study-payload';
import {prepareAccountPlanSource,type AccountPlanSource,type AccountPlanState} from '../account-study-runtime';
import type {CloudTaskPlanV1} from '../account-study-planning';
import {accountTaskActivity,accountTaskCompletedItems} from '../account-study-planning-projection';
import {readAccountLocalPractice} from '../study-submission-history';
import type {SubmissionJournal} from '../study-submission-journal';

type Frame={owner:string;day:string;nativeScope:string;subjects:DynamicSubject[];latestSubjects:()=>DynamicSubject[];progress:CloudProgress;overrides:PluginOverrides;
  selection:{scope:string;taskIds:string[]}|null;nativeSession:TaskPlanningSession|null;nativeProjection:NativeProjection|null;nativeReady:boolean;
  account:AccountStudyLoaded|null;accountPlan?:{ready:boolean;error:string|null;source:AccountPlanSource|null};journal:SubmissionJournal;readAccountDay:()=>Promise<AccountPlanState>};
export type AccountNavigationQuery=PlanningAccountEntry&{plan:TaskPlanV2;catalog:PlanningCatalog;cloud:CloudTaskPlanV1};
export type NavigationContext={subjects:DynamicSubject[];progress:CloudProgress;overrides:PluginOverrides;completed:Record<string,string[]>;
  nativeSession?:TaskPlanningSession;accountSource?:AccountPlanSource};
type Source=PlanningNavigationSource<NavigationContext>;

/** Legacy display aliases and plugin overrides are translated at the page boundary. */
export function resolvePlanningGroups(plan:TaskPlanV2,catalog:PlanningCatalog,subjects:DynamicSubject[],progress:CloudProgress,overrides:PluginOverrides,eligible?:readonly string[]){
  const find=(key:string,subjectId:string)=>{
    const subject=subjects.find(value=>value.id===subjectId),aliases=catalog.subjects.find(value=>value.subjectId===subjectId)?.words.find(word=>word.itemKey===key)?.legacyKeys??[];
    const index=subject?.items.findIndex((item,index)=>stableStudyItemKey(item)===key||resolveStudyItemProgressKey(item,index,progress)===key||aliases.includes(resolveStudyItemProgressKey(item,index,progress)))??-1;
    return subject&&index>=0?{subject,index,item:subject.items[index]}:null;
  };
  const canPractice=(key:string,subjectId:string)=>{
    const value=find(key,subjectId);if(!value)return true;
    const mode=value.item.pluginType??value.item.type??value.subject.pluginType;
    return mode!=='recall'||checkContentQuality('recall',value.item).capabilities.canSelfCheck;
  };
  return studyPracticeGroups(plan,catalog,(key,subjectId)=>{const value=find(key,subjectId);return value?resolvePluginType(value.item,value.subject.pluginType,overrides.item[pluginItemKey(subjectId,value.item,value.index)],overrides.subject[subjectId]):undefined;},
    eligible,(key,subjectId)=>{const value=find(key,subjectId);return value?resolveStudyItemProgressKey(value.item,value.index,progress):key;},canPractice);
}

/** Reads existing stores and projects source data; navigation policy lives in application/planning. */
export function createPlanningSourceAdapter(readFrame:()=>Frame){
  const adapter={
    async loadNative(lease:PlanningNavigationLease,continuing:boolean):Promise<Source|null>{
      const frame=readFrame(),session=frame.nativeSession;if(!session)return null;
      if(continuing&&!session.snapshot().ready)await session.refresh(false);
      if(!lease.current())return null;
      const state=session.snapshot(),plan=state.draft?.plan,catalog=state.catalog;
      if(!plan||!catalog)return null;
      const projection=frame.nativeProjection,completed:Record<string,string[]>={};
      if(projection?.workspaceId===frame.owner&&projection.sourceScope===frame.nativeScope&&frame.nativeReady){
        for(const task of plan.tasks)completed[task.taskId]=nativeTaskCompletedKeys(task,state.reviewRounds.find(value=>value.roundId===task.reviewRoundId||value.aliasRoundIds?.includes(task.reviewRoundId??'')),projection.events,frame.day);
      }
      return {ready:state.ready,plan,catalog,libraryId:frame.nativeScope,completedTaskIds:state.completedTaskIds,startedTaskIds:plan.manual.lockedTaskIds,pendingItemByTask:{},selection:frame.selection,
        context:{subjects:frame.subjects,progress:frame.progress,overrides:frame.overrides,completed,nativeSession:session}};
    },
    async loadAccount(lease:PlanningNavigationLease,query?:AccountNavigationQuery):Promise<Source|null>{
      const frame=readFrame(),account=frame.account;if(!account)return null;
      let source:AccountPlanSource|null;
      if(query){
        const catalog=account.catalogs.find(value=>value.catalogHash===query.cloud.catalogHash);
        const bundle=catalog&&account.bundles.find(value=>value.snapshot.snapshotId===catalog.snapshotId&&value.snapshot.libraryId===catalog.libraryId);
        if(!catalog||!bundle)throw Error('计划依赖的题库尚未下载完整，请刷新账号题库。');
        source={plan:query.plan,catalog:query.catalog,cloud:query.cloud,cloudCatalog:catalog,bundle};
      }else source=await prepareAccountPlanSource(account,await frame.readAccountDay(),frame.day);
      if(!source||!lease.current())return null;
      const local=await readAccountLocalPractice(frame.owner,source.bundle.snapshot.libraryId,frame.journal);
      const bundles=new Map(account.bundles.map(value=>[value.snapshot.snapshotId,value]));
      for(const bundle of local.bundles){const previous=bundles.get(bundle.snapshot.snapshotId);if(previous&&previous.snapshot.snapshotHash!==bundle.snapshot.snapshotHash)throw Error('本机与账号历史资料不一致，请核对。');bundles.set(bundle.snapshot.snapshotId,bundle);}
      const completed=await accountTaskCompletedItems(source.cloud,source.cloudCatalog,[...bundles.values()],account.records,local.records);
      const activity=await accountTaskActivity(source.cloud,source.cloudCatalog,[...bundles.values()],account.records,[...local.records,...local.taskRecords??[]]);
      if(!lease.current())return null;
      const subjects=normalizeDynamicSubjects(accountStudyPayload({...account,bundle:source.bundle,catalog:source.cloudCatalog},frame.owner).subjects);
      return {ready:true,plan:source.plan,catalog:source.catalog,libraryId:source.bundle.snapshot.libraryId,...activity,selection:frame.selection,
        context:{subjects,progress:frame.progress,overrides:frame.overrides,completed,accountSource:source}};
    },
    groups(source:Source,eligible?:readonly string[]){return resolvePlanningGroups(source.plan,source.catalog,source.context.subjects,source.context.progress,source.context.overrides,eligible);},
    verify(source:Source,tasks:TaskPlanV2['tasks'],latest:boolean){
      const subjects=latest?readFrame().latestSubjects():source.context.subjects;
      for(const task of tasks)assertPlanningStudySources(source.catalog,subjects,task);
    },
    async persistStarted(source:Source,ids:string[],isCurrent:()=>boolean){
      const session=source.context.nativeSession;if(!session)return false;
      const guard=()=>{
        const frame=readFrame(),state=session.snapshot();
        if(!isCurrent()||frame.nativeSession!==session||state.workspaceId!==frame.owner||state.day!==frame.day||state.catalog?.sourceHash!==source.catalog.sourceHash||!sameStartTasks(source.plan,state.draft?.plan??null,ids))return false;
        try{for(const task of source.plan.tasks.filter(value=>ids.includes(value.taskId)))assertPlanningStudySources(source.catalog,frame.latestSubjects(),task);return true;}
        catch{return false;}
      };
      if(!guard())return false;
      return session.edit(source.plan.tasks.find(value=>value.taskId===ids[0])?.action.kind==='practice'?{type:'start-group',taskIds:ids}:{type:'start',taskId:ids[0]},guard);
    },
    groupItems(source:Source,group:StudyPracticeGroup){
      const {subjects,progress,completed}=source.context,subject=subjects.find(value=>value.id===group.tasks[0]?.subjectId);
      const items=subject?filterPlanSubject(subject,group.adapter,subjects):[],keys=items.map((item,index)=>resolveStudyItemProgressKey(item,index,progress));
      const done=group.tasks.flatMap(task=>completed[task.taskId]??[]);
      return {keys,completedKeys:source.context.accountSource?done:items.flatMap((item,index)=>done.includes(stableStudyItemKey(item)??keys[index])?[keys[index]]:[])};
    },
  };
  return {...adapter,async loadSubject(lease:PlanningNavigationLease):Promise<Source|null>{
    if(lease.scope.mode==='native')return adapter.loadNative(lease,true);
    const plan=readFrame().accountPlan;
    if(!plan?.ready||!plan.source&&plan.error)throw new SubjectPlanUnavailableError('今日计划暂不可用。');
    if(!plan.source)return null;
    // Reuse the verified, scoped snapshot just like the Today task button; no new network dependency.
    return adapter.loadAccount(lease,{plan:plan.source.plan,catalog:plan.source.catalog,cloud:plan.source.cloud,taskId:''});
  }};
}
