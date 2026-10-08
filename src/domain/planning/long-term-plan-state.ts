import type {LongTermPlanSnapshot} from './long-term-plan-types';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {parseLongTermPlanSnapshot} from './long-term-plan-types.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {canonicalLocalJson as canonicalLongTermJson,hashLocalJson as longTermRequestHash} from '../evidence/index.ts';
export {canonicalLongTermJson,longTermRequestHash};

export type LongTermPlanState={revision:number;enabled:boolean;snapshot:LongTermPlanSnapshot|null;lastOperationId:string|null};
export type LongTermPlanMutation={operationId:string;expectedRevision:number;enabled:boolean;snapshot:LongTermPlanSnapshot};
export type LongTermPlanMutationResult={status:'accepted'|'duplicate'|'stale';state:LongTermPlanState};
export function emptyLongTermPlanState():LongTermPlanState{return{revision:0,enabled:false,snapshot:null,lastOperationId:null};}
function record(value:unknown,keys:string[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw new Error('invalid-long-term-state');
  return value as Record<string,unknown>;
}
function revision(value:unknown):asserts value is number{if(!Number.isSafeInteger(value)||Number(value)<0)throw new Error('invalid-long-term-revision');}
function operation(value:unknown):asserts value is string{if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(value))throw new Error('invalid-long-term-operation');}
export function parseLongTermPlanMutation(value:unknown):LongTermPlanMutation{
  const input=record(value,['operationId','expectedRevision','enabled','snapshot']);operation(input.operationId);revision(input.expectedRevision);
  if(typeof input.enabled!=='boolean')throw new Error('invalid-long-term-enabled');
  return{operationId:input.operationId,expectedRevision:input.expectedRevision,enabled:input.enabled,snapshot:parseLongTermPlanSnapshot(input.snapshot)};
}
export function parseLongTermPlanState(value:unknown):LongTermPlanState{
  const input=record(value,['revision','enabled','snapshot','lastOperationId']);revision(input.revision);
  if(typeof input.enabled!=='boolean')throw new Error('invalid-long-term-enabled');
  if(input.revision===0){if(input.enabled||input.snapshot!==null||input.lastOperationId!==null)throw new Error('invalid-long-term-empty-state');return emptyLongTermPlanState();}
  operation(input.lastOperationId);
  return{revision:input.revision,enabled:input.enabled,snapshot:parseLongTermPlanSnapshot(input.snapshot),lastOperationId:input.lastOperationId};
}
/** Changing future preferences cannot replace elapsed slots of the same plan. */
export function assertLongTermPlanTransition(before:LongTermPlanSnapshot|null,after:LongTermPlanSnapshot):void{
  if(!before||before.spec.planId!==after.spec.planId)return;
  if(after.asOfDate<before.asOfDate)throw new Error('long-term-observation-moved-backward');
  const afterDates=new Map(after.schedule.map(slot=>[slot.date,slot]));
  for(const slot of before.schedule.filter(slot=>slot.date<after.asOfDate)){
    const next=afterDates.get(slot.date);
    if(!next||canonicalLongTermJson(slot)!==canonicalLongTermJson(next))throw new Error('long-term-frozen-history-changed');
  }
}
