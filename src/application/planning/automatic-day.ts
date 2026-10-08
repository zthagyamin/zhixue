import type {LongTermPlanState,LongTermPlanSnapshot} from '../../domain/planning';
export type AutomaticDailyState={day:string;revision:number;decision:string;currentPlan?:unknown;approvedPlan?:unknown};
/** Missing-day preparation never receives an approval port. */
export async function prepareMissingDailyPlan<State extends AutomaticDailyState,Plan>(ports:{
  state:State;day:string;expectedLongTermRevision:number;isCurrent:()=>boolean;newId:()=>string;
  readGoals:()=>Promise<LongTermPlanState>;assertEvidence:()=>Promise<void>;
  build:(state:State,snapshot:LongTermPlanSnapshot)=>Promise<Plan|null>;
  saveDraft:(command:{plan:Plan;operationId:string;expectedRevision:number})=>Promise<{status:unknown}>;
  readDay:()=>Promise<State>;
}):Promise<State>{
  const {state,day,isCurrent}=ports;
  if(!isCurrent()||state.day!==day||state.currentPlan||state.approvedPlan||state.decision!=='none')return state;
  const goals=await ports.readGoals();
  if(!isCurrent()||!goals.enabled||!goals.snapshot||goals.revision!==ports.expectedLongTermRevision||day<goals.snapshot.spec.startDate||day>goals.snapshot.spec.targetDeadline)return state;
  await ports.assertEvidence();
  if(!isCurrent())return state;
  const plan=await ports.build(state,goals.snapshot);
  if(plan===null||!isCurrent())return state;
  await ports.assertEvidence();
  const latest=await ports.readGoals();
  if(!isCurrent()||!latest.enabled||latest.revision!==goals.revision)return state;
  const receipt=await ports.saveDraft({plan,operationId:ports.newId(),expectedRevision:state.revision});
  if(!['accepted','duplicate','stale'].includes(String(receipt.status)))throw Error('今日安排尚未保存，请重新核对。');
  // A competing edit wins via the existing revision check. A draft is never approved here.
  return ports.readDay();
}
