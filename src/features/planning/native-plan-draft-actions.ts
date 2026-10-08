import type {TaskPlanningSession} from '../../application/planning';
import type {TaskEdit} from '../../domain/planning';

export function nativePlanDraftActions(session:TaskPlanningSession|null,clearMessage:()=>void){
  const run=(action:()=>Promise<unknown>|undefined)=>{clearMessage();void action()?.catch(()=>{});};
  return {
    onGenerate:()=>run(()=>session?.generate()),
    onTopUpMinimums:()=>run(()=>session?.generate({minimums:true})),
    onReload:()=>run(()=>session?.refresh()),
    onEdit:(edit:TaskEdit)=>run(()=>session?.edit(edit)),
  };
}
