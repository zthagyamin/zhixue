import type {LongTermEditorSource,LongTermPlanMutation,LongTermPlanSnapshot,LongTermPlanState,LongTermPreviewInput} from '../../domain/planning';
// @ts-expect-error TS5097: standalone Node source contracts.
import {canonicalLongTermJson} from '../../domain/planning/index.ts';

export type AutomaticPlanningInput={scope:string;mode:'native'|'account';day:string;sourceStamp:string;trigger:string;ready:boolean;state:LongTermPlanState};
export type AutomaticPlanningOutcome={status:'prepared'|'unchanged'|'deferred'|'stale'|'failed';error?:unknown};
export type AutomaticPlanningPorts={
  isCurrent:(input:AutomaticPlanningInput)=>boolean;
  loadSource:(input:AutomaticPlanningInput)=>Promise<LongTermEditorSource>;
  preview:(input:LongTermPreviewInput)=>LongTermPlanSnapshot;
  save:(input:AutomaticPlanningInput,mutation:Omit<LongTermPlanMutation,'operationId'>)=>Promise<LongTermPlanState>;
  prepareDaily:(input:AutomaticPlanningInput,state:LongTermPlanState,isCurrent:()=>boolean)=>Promise<boolean>;
  refreshGoals:(input:AutomaticPlanningInput)=>Promise<unknown>;
  now:()=>string;
};
type Intent={input:AutomaticPlanningInput;key:string;binding:string;promise:Promise<AutomaticPlanningOutcome>;finish:(value:AutomaticPlanningOutcome)=>void};
const bindingOf=(input:AutomaticPlanningInput)=>JSON.stringify([input.scope,input.mode,input.day,input.sourceStamp]);
const keyOf=(input:AutomaticPlanningInput,revision=input.state.revision)=>JSON.stringify([bindingOf(input),input.trigger,revision]);

/** Serialize revisions in one range; a new range retires the old display lease immediately. */
export function createAutomaticPlanningCoordinator(ports:AutomaticPlanningPorts){
  let disposed=false,running:Intent|null=null,pending:Intent|null=null,seen='';
  const intent=(input:AutomaticPlanningInput):Intent=>{
    let resolve!:(result:AutomaticPlanningOutcome)=>void,finished=false;
    const promise=new Promise<AutomaticPlanningOutcome>(done=>{resolve=done;});
    return {input,key:keyOf(input),binding:bindingOf(input),promise,finish(value){if(!finished){finished=true;resolve(value);}}};
  };
  const retire=()=>{running?.finish({status:'stale'});pending?.finish({status:'stale'});running=null;pending=null;};
  const current=(job:Intent)=>!disposed&&running===job&&ports.isCurrent(job.input);
  const execute=async(job:Intent):Promise<AutomaticPlanningOutcome>=>{
    const input=job.input,old=input.state.snapshot;
    if(!old||!current(job))return {status:'stale'};
    const source=await ports.loadSource(input);if(!current(job))return {status:'stale'};
    const next=source.todayLocked&&input.day===old.spec.targetDeadline?old:
      ports.preview({spec:old.spec,previous:old,source,today:input.day,generatedAt:ports.now(),preserveToday:false});
    const changed=canonicalLongTermJson({...next,lastRebalancedAt:old.lastRebalancedAt})!==canonicalLongTermJson(old);
    const prepared=changed?await ports.save(input,{expectedRevision:input.state.revision,enabled:true,snapshot:next}):input.state;
    if(!current(job)||!prepared.enabled||!prepared.snapshot)return {status:'stale'};
    let ready=input.day<prepared.snapshot.spec.startDate||input.day>prepared.snapshot.spec.targetDeadline;
    if(!ready)ready=await ports.prepareDaily(input,prepared,()=>current(job));
    if(!current(job))return {status:'stale'};
    if(!ready){await ports.refreshGoals(input);return {status:current(job)?'deferred':'stale'};}
    seen=keyOf(input,prepared.revision);return {status:'prepared'};
  };
  const launch=(job:Intent)=>{
    if(disposed||!ports.isCurrent(job.input)){job.finish({status:'stale'});return;}
    if(job.key===seen){job.finish({status:'unchanged'});return;}
    running=job;
    void execute(job).catch(error=>({status:'failed' as const,error})).then(result=>{
      job.finish(result);if(running!==job)return;
      running=null;const next=pending;pending=null;if(next)launch(next);
    });
  };
  return {
    request(value:AutomaticPlanningInput):Promise<AutomaticPlanningOutcome>{
      if(disposed)return Promise.resolve({status:'stale'});
      const input=structuredClone(value),binding=bindingOf(input),key=keyOf(input);
      if(running&&running.binding!==binding)retire();
      if(!input.state.enabled||!input.state.snapshot||input.state.snapshot.spec.targetDeadline<input.day||!ports.isCurrent(input)){
        retire();return Promise.resolve({status:'deferred'});
      }
      // Day-reader busy state may be caused by our own preparation. Do not cancel that write.
      if(!input.ready)return Promise.resolve({status:'deferred'});
      if(seen===key)return Promise.resolve({status:'unchanged'});
      if(running?.key===key)return running.promise;
      if(pending?.key===key)return pending.promise;
      const next=intent(input);
      if(running){pending?.finish({status:'stale'});pending=next;}else launch(next);
      return next.promise;
    },
    invalidate(){retire();},
    dispose(){disposed=true;retire();},
  };
}
