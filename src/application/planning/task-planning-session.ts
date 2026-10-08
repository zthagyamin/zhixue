import type {LongTermPlanSnapshot,LongTermPlanSpec} from '../../domain/planning';
// @ts-expect-error TS5097: standalone Node regression tests.
import {canonicalLongTermJson} from '../../domain/planning/index.ts';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {applyLongTermPlan,reconcileDailyMinimums} from '../../domain/planning/index.ts';
// @ts-expect-error Node source tests.
import {coveredPlanningUnitIds} from '../../domain/planning/index.ts';
import type {PlanDocumentPayload,PlanningInputFacts,PlanningInputComposition,CompletionFacts,SuggestionResponse,MutationResult} from '../../domain/planning';
import type {TaskDraft} from '../../domain/planning';
import type {TaskEdit} from '../../domain/planning';
import type {PlanningCatalog,TaskEventV1,TaskPlanV2,SuggestionRequest,ReviewObligation} from '../../domain/planning';
import type {TaskPlanState} from './task-plan-controller';
import type {TaskPlanSummary} from '../../domain/planning';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {createTaskPlanController} from './task-plan-controller.ts';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {generateTaskPlan,hashTaskPlan} from '../../domain/planning/index.ts';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {editTaskPlan,mergeTaskPlans} from '../../domain/planning/index.ts';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {isTaskPlan} from '../../domain/planning/index.ts';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {applyTaskSuggestions,prepareTaskSuggestion,summarizeTaskPlan} from '../../domain/planning/index.ts';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {hashTaskEvent} from '../../domain/planning/index.ts';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {canonicalizeJson} from '../../domain/evidence/index.ts';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extensions.
import {studyDay} from '../../domain/planning/index.ts';

export type TaskPlanningBundle=Omit<PlanningInputFacts,'day'|'previous'|'optionalMinutes'> & {longTermPlan?:LongTermPlanSnapshot|null;authority:PlanDocumentPayload;studyData?:unknown;offline?:boolean;pendingTaskCount?:number;cacheWarning?:string};
export type TaskPlanConflict={revision:number;sourceHash:string;local:TaskDraft;remote:TaskPlanV2|null};
export type TaskPlanningState=TaskPlanState & {minimumSpec?:LongTermPlanSpec|null;ready:boolean;busy:boolean;offline:boolean;catalog:PlanningCatalog|null;summary:TaskPlanSummary;
  completedTaskIds:string[];reviewRounds:ReviewObligation[];message:string;lastSyncedAt?:string;pendingCount:number;conflict:TaskPlanConflict|null;lastBackup:TaskDraft|null};
const emptySummary:TaskPlanSummary={newDone:0,newTarget:20,newMissing:0,reviewDone:0,reviewTotal:0};
function semantic(plan:TaskPlanV2):string {
  return canonicalizeJson([plan.day,plan.sourceHash,plan.tasks,plan.vocabulary,plan.manual,plan.optionalMinutes??null,plan.longTermAllocation??null]);
}
export function createTaskPlanningSession(dependencies:{
  loadDraft:(workspaceId:string,day:string)=>Promise<TaskDraft|null>;saveDraft:(workspaceId:string,draft:TaskDraft,expected?:TaskDraft|null)=>Promise<void>;
  archiveDraft?:(workspaceId:string,draft:TaskDraft)=>Promise<void>;loadLastBackup?:(workspaceId:string,day:string)=>Promise<TaskDraft|null>;
  loadBundle:(workspaceId:string,day:string,full:boolean)=>Promise<TaskPlanningBundle>;putTaskEvent:(workspaceId:string,event:TaskEventV1)=>Promise<void>;
  client:TaskPlanningMutationPort;publish:(state:TaskPlanningState)=>void;now:()=>Date;newId:()=>string;
  buildInput:(facts:PlanningInputFacts)=>Promise<PlanningInputComposition>;completedTasks:(plan:TaskPlanV2|null,facts:CompletionFacts)=>string[];
}) {
  let state:TaskPlanningState={workspaceId:'',day:'',draft:null,loading:false,error:null,ready:false,busy:false,offline:false,catalog:null,
    summary:emptySummary,completedTaskIds:[],reviewRounds:[],message:'',pendingCount:0,conflict:null,lastBackup:null};
  let bundle:TaskPlanningBundle|null=null,composed:PlanningInputComposition|null=null;
  let context=0,readVersion=0;
  const now=dependencies.now;
  const snapshot=()=>structuredClone(state),publish=()=>dependencies.publish(snapshot());
  const controller=createTaskPlanController({load:dependencies.loadDraft,save:dependencies.saveDraft,publish:value=>{state={...state,...value};publish();}});
  const fail=(error:unknown)=>{state={...state,message:error instanceof Error?error.message:'今日安排操作失败。'};publish();};
  const working=async<T>(operation:()=>Promise<T>):Promise<T>=>{
    const owner=context;state={...state,busy:true,message:''};publish();
    try {return await operation();} catch(error){if(owner===context) fail(error);throw error;}
    finally {if(owner===context){state={...state,busy:false};publish();}}
  };
  const requireReady=()=>{if(!state.ready || !bundle) throw new Error('请先完整同步学习记录，再调整今日安排。');return bundle;};
  const rememberConflict=(local:TaskDraft,fetched:TaskPlanningBundle)=>{
    state={...state,ready:false,offline:fetched.offline===true,conflict:{revision:fetched.authority.revision,sourceHash:fetched.context.catalog.sourceHash,local:structuredClone(local),
      remote:isTaskPlan(fetched.authority.candidate)?structuredClone(fetched.authority.candidate):null}};publish();
  };
  const inputFor=async(previous:TaskPlanV2|null,optionalMinutes=previous?.optionalMinutes,applyGoals=true,minimums=false)=>{
    if(!bundle) throw new Error('planning-facts-missing');
    const captured=bundle,day=state.day;
    const facts=await dependencies.buildInput({...captured,day,previous,...(optionalMinutes===undefined?{}:{optionalMinutes})});
    const applied=applyGoals?applyLongTermPlan(facts.input,captured.longTermPlan??null):facts.input;
    return {...facts,input:minimums?reconcileDailyMinimums(applied,captured.longTermPlan??null):applied};
  };
  const publishCompletions=()=>{
    if(!composed || !bundle) return;
    const plan=controller.snapshot().draft?.plan??null;
    const completedTaskIds=dependencies.completedTasks(plan,{catalog:bundle.context.catalog,events:composed.events,
      completions:composed.input.completions,reviews:composed.input.reviews,identities:composed.input.wordIdentities??[],taskEvents:composed.taskEvents});
    state={...state,minimumSpec:bundle.longTermPlan?.spec??null,completedTaskIds,reviewRounds:composed.input.reviews,summary:plan?summarizeTaskPlan(plan,composed.input.words,composed.input.reviews):emptySummary};publish();
  };
  const regenerate=async(canContinue=()=>true,minimums=false)=>{
    requireReady();const owner=context,epoch=readVersion;
    await controller.change(async draft=>{
      if(!canContinue())return null;
      const current=draft?.plan??(isTaskPlan(bundle!.authority.candidate)?bundle!.authority.candidate:null);
      const nextFacts=await inputFor(current,undefined,true,minimums);
      const fresh=await generateTaskPlan(nextFacts.input);
      const retainedSuggestions=draft?.plan.tasks.filter(task=>['ai','fallback'].includes(task.origin)).map(task=>task.taskId)??[];
      const plan=draft?await mergeTaskPlans(draft.plan,fresh,nextFacts.completedTaskIds,bundle!.context.catalog,nextFacts.input.reviews,retainedSuggestions):fresh;
      if(owner!==context || epoch!==readVersion || !canContinue()) return null;
      composed=nextFacts;
      if(draft && semantic(draft.plan)===semantic(plan)) return null;
      return {plan,baseRevision:draft?.baseRevision??bundle!.authority.revision,dirty:true};
    });
    if(owner===context && epoch===readVersion) publishCompletions();
  };
  const refresh=async(full=true):Promise<void>=>working(async()=>{
    const owner=context,epoch=++readVersion,workspaceId=state.workspaceId,day=state.day;
    controller.invalidateEvidence();state={...state,ready:false};publish();
    const fetched=await dependencies.loadBundle(workspaceId,day,full);
    if(owner!==context || epoch!==readVersion) return;
    if(fetched.authority.revision!==fetched.context.planRevision) throw new Error('计划在读取期间已更新，请重新同步。');
    const draft=controller.snapshot().draft,remote=fetched.authority.candidate;
    if(!fetched.offline && draft && draft.baseRevision>fetched.authority.revision) throw new Error('读取到较旧的计划修订，请重新同步。');
    if(!fetched.offline && draft?.dirty && draft.baseRevision!==fetched.authority.revision && (!isTaskPlan(remote) || remote.planHash!==draft.plan.planHash)) {
      rememberConflict(draft,fetched);
      await resolveConflict('remote');return;
    }
    bundle=fetched;
    if(!fetched.offline && isTaskPlan(remote) && remote.day===day && (!draft || !draft.dirty || remote.planHash===draft.plan.planHash)) {
      let needsAdoption=false;
      await controller.change(current=>{
        if(owner!==context || epoch!==readVersion) return null;
        if(current?.dirty && current.plan.planHash!==remote.planHash) {
          if(current.baseRevision!==fetched.authority.revision){rememberConflict(current,fetched);needsAdoption=true;}
          return null;
        }
        if(current && current.baseRevision>fetched.authority.revision) throw new Error('读取到较旧的计划修订，请重新同步。');
        return {plan:remote,baseRevision:fetched.authority.revision,dirty:false};
      });
      // Wait outside the controller queue: adoption itself queues a durable draft update.
      if(needsAdoption && owner===context && epoch===readVersion){await resolveConflict('remote');return;}
    }
    if(owner!==context || epoch!==readVersion) return;
    // Read complete facts first. A stale goal snapshot must not block its own reconciliation.
    composed=await inputFor(controller.snapshot().draft?.plan??(isTaskPlan(remote)?remote:null),undefined,Boolean(controller.snapshot().draft));
    if(owner!==context || epoch!==readVersion) return;
    state={...state,ready:true,conflict:null,offline:fetched.offline===true,catalog:fetched.context.catalog,lastSyncedAt:fetched.context.observedAt,pendingCount:fetched.pendingTaskCount??0,
      message:fetched.offline?'离线使用上次完整同步的资料；本机练习继续保存，恢复连接后再核对其他设备。':fetched.cacheWarning??''};publishCompletions();
    if(controller.snapshot().draft) await regenerate();
  });
  const suggest=async(intent:SuggestionRequest['intent']):Promise<void>=>working(async()=>{
    const facts=requireReady(),owner=context,epoch=readVersion;
    if(state.offline && intent!=='less') throw new Error('当前离线，已保留已有建议；恢复连接后再请求 AI。');
    await controller.change(async draft=>{
      if(!draft) throw new Error('请先生成今日安排。');
      const plan=await prepareTaskSuggestion(draft.plan,intent,state.completedTaskIds);
      return plan===draft.plan?null:{...draft,plan,dirty:true};
    });
    if(owner!==context || epoch!==readVersion) return;
    if(intent==='less'){state={...state,message:'已减少未开始的可选建议；必做、手动与已开始的任务保留。'};publishCompletions();return;}
    let message='';
    const accepted=await controller.suggest(intent,request=>{
      const plan=controller.snapshot().draft?.plan;
      if(!plan||plan.sourceHash!==request.sourceHash||plan.draftVersion!==request.draftVersion)throw new Error('stale-suggestion');
      return dependencies.client.suggestPlan({...request,selectedUnitIds:[...new Set([...request.selectedUnitIds,...coveredPlanningUnitIds(plan,facts.context.catalog)])]});
    },async(draft,response)=>{
      message=response.message;
      return {...draft,plan:await applyTaskSuggestions(draft.plan,response,facts.context.catalog),dirty:true};
    });
    if(accepted && owner===context && epoch===readVersion){state={...state,message};publishCompletions();}
  });
  const resolveConflict=async(choice:'local'|'remote',restoreDraft?:TaskDraft):Promise<void>=>working(async()=>{
    const conflict=state.conflict,current=controller.snapshot().draft,owner=context,workspace=state.workspaceId,day=state.day,epoch=++readVersion;
    controller.invalidateEvidence();state={...state,ready:false};publish();
    if(!current || (!conflict && !restoreDraft) || !dependencies.archiveDraft) throw new Error('草稿备份不可用，未替换任何内容；请恢复本机存储后重新同步。');
    const checkpoint=conflict??{revision:bundle?.authority.revision,sourceHash:bundle?.context.catalog.sourceHash,remote:bundle?.authority.candidate};
    const fetched=await dependencies.loadBundle(workspace,day,true);
    if(owner!==context || epoch!==readVersion) return;
    if(fetched.offline) throw new Error('当前离线，本机草稿已保留；恢复连接后重新同步。');
    if(fetched.authority.revision!==fetched.context.planRevision || fetched.authority.revision!==checkpoint.revision || fetched.context.catalog.sourceHash!==checkpoint.sourceHash){
      rememberConflict(controller.snapshot().draft!,fetched);throw new Error('同步期间安排或资料再次变化，本机草稿已保留；请重新同步。');
    }
    bundle=fetched;
    await controller.change(async latest=>{
      if(owner!==context || epoch!==readVersion) return null;
      if(!latest) throw new Error('本机草稿不可用，请重新同步。');
      if(latest.baseRevision>fetched.authority.revision) throw new Error('读取到较旧的计划修订，请重新同步。');
      const remote=isTaskPlan(fetched.authority.candidate)?fetched.authority.candidate:null;
      // An earlier adoption may finish saving while this one waits in the queue.
      // Its clean intermediate plan must not hide the original unsaved recovery point.
      const archive=choice==='local' || latest.dirty && latest.plan.planHash!==remote?.planHash;
      if(archive) await dependencies.archiveDraft!(workspace,latest);
      if(owner!==context || epoch!==readVersion) return null;
      const source=choice==='local'?(restoreDraft?.plan??latest.plan):remote;
      const nextFacts=await inputFor(source);
      const generated=await generateTaskPlan(nextFacts.input);
      const retained=source?.tasks.filter(task=>['ai','fallback'].includes(task.origin)).map(task=>task.taskId)??[];
      const merged=source?await mergeTaskPlans(source,generated,nextFacts.completedTaskIds,fetched.context.catalog,nextFacts.input.reviews,retained):generated;
      const unchangedRemote=choice==='remote' && remote?.day===day && semantic(remote)===semantic(merged);
      let plan=unchangedRemote?remote:merged;
      if(!unchangedRemote && plan.draftVersion<=latest.plan.draftVersion){
        const body={...plan,draftVersion:latest.plan.draftVersion+1};delete (body as Partial<TaskPlanV2>).planHash;
        plan={...body,planHash:await hashTaskPlan(body)};
      }
      if(owner!==context || epoch!==readVersion) return null;
      composed=nextFacts;if(archive)state={...state,lastBackup:structuredClone(latest)};
      return {plan,baseRevision:fetched.authority.revision,dirty:!unchangedRemote};
    });
    if(owner!==context || epoch!==readVersion) return;
    state={...state,ready:true,offline:false,conflict:null,catalog:fetched.context.catalog,lastSyncedAt:fetched.context.observedAt,pendingCount:fetched.pendingTaskCount??0,
      message:choice==='remote'?'已同步最新安排；未保存的本机调整已保留，可在“调整安排”中恢复。':'已恢复本机草稿并按最新资料核对；检查后可保存到学习知识库。'};publishCompletions();
  });
  return {
    snapshot,refresh,resolveConflict:(choice:'local'|'remote')=>resolveConflict(choice),
    restoreLastBackup:()=>{
      if(!state.lastBackup || state.lastBackup.plan.day!==state.day) return Promise.reject(new Error('没有可恢复的当日草稿副本。'));
      return resolveConflict('local',structuredClone(state.lastBackup));
    },
    open:async(workspaceId:string,day:string)=>{
      const owner=++context;readVersion++;bundle=null;composed=null;
      state={...state,minimumSpec:null,ready:false,busy:false,offline:false,catalog:null,summary:emptySummary,completedTaskIds:[],reviewRounds:[],message:'',lastSyncedAt:undefined,pendingCount:0,conflict:null,lastBackup:null};
      await controller.open(workspaceId,day);
      if(owner!==context) return;
      const backup=await dependencies.loadLastBackup?.(workspaceId,day);
      if(owner!==context) return;
      if(backup) state={...state,lastBackup:backup};
      await refresh();
    },
    invalidate:()=>{readVersion++;controller.invalidateEvidence();state={...state,ready:false};publish();},
    evidenceChanged:()=>{readVersion++;controller.invalidateEvidence();state={...state,ready:false};publish();},
    prepareAutomaticDay:async(expected:LongTermPlanSnapshot,isCurrent=()=>true)=>{
      if(state.draft)return true;
      if(state.busy||!isCurrent())return false;
      if(state.day<expected.spec.startDate||state.day>expected.spec.targetDeadline)return true;
      const owner=context,workspace=state.workspaceId,day=state.day;
      await refresh(false);
      if(state.draft)return true;
      if(!isCurrent()||!state.ready||!bundle?.longTermPlan
        ||canonicalLongTermJson(bundle.longTermPlan)!==canonicalLongTermJson(expected))return false;
      try{await working(()=>regenerate(()=>isCurrent()&&!controller.snapshot().draft));}
      catch(error){
        if(!(error instanceof Error)||error.message!=='stale-task-draft'||owner!==context||!isCurrent())throw error;
        // Another tab prepared or edited the same day first. Read its durable draft.
        await controller.open(workspace,day);
        if(owner===context&&isCurrent())await refresh(false);
      }
      return Boolean(state.draft);
    },
    generate:async(options:{minimums?:boolean}={})=>{
      const owner=context,epoch=readVersion;await working(()=>regenerate(()=>true,options.minimums===true));
      if(owner!==context || epoch!==readVersion) return;
      if(state.offline){state={...state,message:'已依据上次完整同步与本机新记录更新规则任务；当前离线，AI 建议未刷新。'};publish();return;}
      if(!controller.snapshot().draft?.plan.longTermAllocation)await suggest('standard');
    },suggest,
    edit:(edit:TaskEdit,isCurrent=()=>true)=>working(async()=>{
      const facts=requireReady();
      const changed=await controller.change(async draft=>{
        if(!draft) throw new Error('请先生成今日安排。');
        const current=await inputFor(draft.plan);
        return {...draft,plan:await editTaskPlan(draft.plan,edit,facts.context.catalog,{words:current.input.words,reviews:current.input.reviews}),dirty:true};
      },isCurrent);publishCompletions();return changed;
    }),
    optionalMinutes:(minutes:number|undefined)=>working(async()=>{
      requireReady();
      if(minutes!==undefined && (!Number.isSafeInteger(minutes)||minutes<0)) throw new Error('invalid-optional-minutes');
      await controller.change(async draft=>{
        if(!draft || draft.plan.optionalMinutes===minutes) return null;
        const body={...draft.plan,draftVersion:draft.plan.draftVersion+1};delete (body as Partial<TaskPlanV2>).planHash;
        if(minutes===undefined) delete body.optionalMinutes;else body.optionalMinutes=minutes;
        return {...draft,dirty:true,plan:{...body,planHash:await hashTaskPlan(body)}};
      });
    }),
    complete:(taskId:string)=>working(async()=>{
      const currentBundle=requireReady(),owner=context,workspace=state.workspaceId;
      const draft=controller.snapshot().draft,task=draft?.plan.tasks.find(task=>task.taskId===taskId);
      if(!task || task.completionRule!=='self-report' || task.blockedReason) throw new Error('这项任务不能自报完成。');
      const occurredAt=now().toISOString();if(studyDay(occurredAt)!==state.day) throw new Error('日期已变化，请同步后继续。');
      const body:Omit<TaskEventV1,'coreHash'>={schemaVersion:1,eventType:'task-completed',eventId:dependencies.newId(),taskId,subjectId:task.subjectId,
        day:state.day,occurredAt,unitIds:task.unitIds,source:'self-report',evidenceRefs:[]};
      const event={...body,coreHash:await hashTaskEvent(body)};
      await dependencies.putTaskEvent(workspace,event);
      if(owner!==context) return;
      controller.invalidateEvidence();readVersion++;
      currentBundle.taskEvents=[...currentBundle.taskEvents,event];
      composed=await inputFor(draft!.plan);
      if(owner!==context) return;
      state={...state,pendingCount:state.pendingCount+1,message:'本次完成已保存在本机，待同步到学科记录。'};publishCompletions();
    }),
    save:()=>working(async()=>{
      const currentBundle=requireReady(),owner=context,draft=controller.snapshot().draft;
      if(state.offline) throw new Error('当前离线，草稿已留在本机；恢复连接后再保存到学习知识库。');
      if(!draft) throw new Error('请先生成今日安排。');
      controller.invalidateEvidence();
      const result=await dependencies.client.applyTaskPlan(draft.plan,draft.baseRevision);
      if(owner!==context) return;
      if(result.status==='stale') throw new Error(result.message??'计划版本冲突；本机草稿已保留。');
      const revision=result.revision;
      if(!revision || !Number.isSafeInteger(revision.revision) || revision.revision<=draft.baseRevision || revision.after?.planHash!==draft.plan.planHash) throw new Error('保存回执不完整，请同步核对；本机草稿已保留。');
      await controller.change(current=>current?{...current,baseRevision:revision.revision,dirty:current.plan.planHash!==draft.plan.planHash}:null);
      currentBundle.authority={...currentBundle.authority,revision:revision.revision,candidate:draft.plan};currentBundle.context.planRevision=revision.revision;
      state={...state,message:'今日安排已保存到学习知识库。学习记录仍独立保存在各学科下。'};publish();
    }),
  };
}

export type TaskPlanningDependencies=Parameters<typeof createTaskPlanningSession>[0];
export type TaskPlanningSession=ReturnType<typeof createTaskPlanningSession>;
export type TaskPlanningMutationPort={suggestPlan:(request:SuggestionRequest)=>Promise<SuggestionResponse>;applyTaskPlan:(plan:TaskPlanV2,expectedRevision:number)=>Promise<MutationResult<TaskPlanV2>>};
