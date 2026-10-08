import type {PlanCandidate,PlanInput,CurrentPlanPayload,MutationResult} from '../../domain/planning';
// @ts-expect-error TS5097: standalone Node source contracts.
import {generateDailyPlan,applyPlanGenerationMode,revisePlanCandidate} from '../../domain/planning/index.ts';
export type LegacyPlanTransport={getCurrentPlan:()=>Promise<CurrentPlanPayload>;applyPlan:(candidate:PlanCandidate,revision:number,operator:string)=>Promise<MutationResult>;
  rejectPlan:(hash:string,reason:string,operator:string)=>Promise<MutationResult>;restorePlan:(target:number,revision:number,operator:string)=>Promise<MutationResult>;
  aiReorderPlan?:(items:PlanCandidate['items'])=>Promise<PlanCandidate['items']>};
export type LegacyPlanFrame={scope:string;day:string;sourceStamp:string;enabled:boolean;historyReady:boolean;storageReady:boolean;hasContent:boolean;
  candidate:PlanCandidate|null;authority:CurrentPlanPayload;mode:'ai'|'deterministic';online:boolean;operator:string;transport:LegacyPlanTransport|null};
export type LegacyPlanPorts={readFrame:()=>LegacyPlanFrame;isCurrent:()=>boolean;readInput:(isCurrent:()=>boolean)=>Promise<PlanInput>;
  replaceCandidate:(before:PlanCandidate|null,after:PlanCandidate|null)=>void;publishAuthority:(payload:CurrentPlanPayload)=>void;
  message:(value:string)=>void;loading:(value:boolean)=>void;resetSelection:()=>void};

/** Legacy protocol compatibility, with the same source/owner boundary as the task-plan path. */
export function createLegacyPlanActions(ports:LegacyPlanPorts){
  let epoch=0,readEpoch=0,revisionFloor=0,busy:object|null=null;
  const capture=()=>{
    const frame=ports.readFrame(),version=epoch;
    const current=()=>version===epoch&&ports.isCurrent()&&ports.readFrame().scope===frame.scope&&ports.readFrame().day===frame.day&&ports.readFrame().transport===frame.transport;
    return {frame,current};
  };
  const refresh=async():Promise<PlanCandidate|null>=>{
    const {frame,current}=capture();if(!frame.transport)return null;
    const version=++readEpoch;
    try{
      const value=await frame.transport.getCurrentPlan();
      if(!current()||version!==readEpoch||value.revision<Math.max(revisionFloor,ports.readFrame().authority.revision))return null;
      revisionFloor=value.revision;ports.publishAuthority(value);return value.candidate;
    }catch{return null;}
  };
  const run=async<T>(operation:(frame:LegacyPlanFrame,current:()=>boolean)=>Promise<T>):Promise<T|undefined>=>{
    if(busy)return;const {frame,current}=capture();if(!frame.enabled||!current())return;
    const token={};busy=token;readEpoch++;ports.loading(true);ports.message('');
    try{return await operation(frame,current);}
    catch(error){if(current())ports.message(error instanceof Error?error.message:'计划操作失败，已有安排仍保留。');}
    finally{if(busy===token){busy=null;if(current())ports.loading(false);}}
  };
  const requireCandidate=(frame:LegacyPlanFrame)=>{
    if(!frame.candidate)throw Error('当前没有可处理的候选计划。');
    if(frame.candidate.day!==frame.day)throw Error('候选日期已变化，请重新生成今日安排。');
    return frame.candidate;
  };
  return {
    refresh,
    invalidate(){epoch++;readEpoch++;revisionFloor=0;busy=null;},
    async generate(){
      const frame=ports.readFrame();
      if(!frame.historyReady){ports.message('学习历史尚未完整核对；保留已有安排，请先重新核对历史。');return;}
      if(!frame.storageReady||!frame.hasContent){ports.message('请先连接 Companion 获取学习内容。');return;}
      return run(async(frame,current)=>{
        const sourceCurrent=()=>current()&&ports.readFrame().sourceStamp===frame.sourceStamp;
        const input=await ports.readInput(sourceCurrent);if(!sourceCurrent())return;
        const candidate=await generateDailyPlan(input);if(!sourceCurrent())return;
        const generated=await applyPlanGenerationMode(candidate,frame.mode,frame.transport?.aiReorderPlan);if(!sourceCurrent())return;
        ports.replaceCandidate(frame.candidate,generated.candidate);ports.resetSelection();await refresh();
        if(sourceCurrent()){ports.message(generated.message);return generated.candidate.planHash;}
      });
    },
    approve(){return run(async(frame,current)=>{
      const candidate=requireCandidate(frame);if(!frame.transport)throw Error('请先生成计划并连接 Companion。');
      const result=await frame.transport.applyPlan(candidate,frame.authority.revision,frame.operator);if(!current())return;
      if(result.status==='stale'){await refresh();if(current())ports.message('主计划已在其他位置更新。已刷新最新修订，请重新检查差异后再批准。');return;}
      const revision=result.revision?.revision??frame.authority.revision+1;
      revisionFloor=Math.max(revisionFloor,revision);readEpoch++;
      if(revision>=ports.readFrame().authority.revision)ports.publishAuthority({revision,candidate,history:frame.authority.history});
      ports.replaceCandidate(candidate,null);await refresh();if(current())ports.message(`计划已写入 Obsidian 主计划（revision ${revision}）。`);
    });},
    remove(itemKey:string){return run(async(frame,current)=>{
      const before=requireCandidate(frame),updated=await revisePlanCandidate(before,before.items.filter(item=>item.itemKey!==itemKey));
      if(current())ports.replaceCandidate(before,updated);
    });},
    reject(){return run(async(frame,current)=>{
      const candidate=requireCandidate(frame);
      if(!frame.transport||!frame.online){ports.replaceCandidate(candidate,null);ports.message('已丢弃本页候选；未连接主计划服务，没有提交远端拒绝审计，也没有改写原笔记。');return;}
      const result=await frame.transport.rejectPlan(candidate.planHash,'用户拒绝今日候选',frame.operator);if(!current())return;
      if(result.status==='stale'){await refresh();if(current())ports.message('主计划已有新修订，候选仍保留，请重新检查。');return;}
      ports.replaceCandidate(candidate,null);await refresh();if(current())ports.message('候选已拒绝并记入审计，当前主计划没有变化。');
    });},
    restore(target:number){return run(async(frame,current)=>{
      if(!frame.transport)return;
      const result=await frame.transport.restorePlan(target,frame.authority.revision,frame.operator);if(!current())return;
      if(result.status==='ok'&&result.revision)revisionFloor=Math.max(revisionFloor,result.revision.revision);
      await refresh();if(current())ports.message(result.status==='stale'?'主计划已有新修订，已刷新历史；请再次选择要恢复的版本。':`已将 revision ${target} 恢复为新的主计划修订。`);
    });},
  };
}
