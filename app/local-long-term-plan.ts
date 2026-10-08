import type {LongTermPlanSnapshot} from './long-term-plan-types';
import type {LongTermPlanState,LongTermPlanMutation,LongTermPlanMutationResult} from './long-term-plan-state';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {parseLongTermPlanSnapshot} from './long-term-plan-types.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {emptyLongTermPlanState,parseLongTermPlanState,parseLongTermPlanMutation,assertLongTermPlanTransition,longTermRequestHash} from './long-term-plan-state.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {loadWorkspaceRecord,updateWorkspaceRecord} from './local-study-db.ts';

type StoredLongTermPlan={schemaVersion:1;state:LongTermPlanState;operations:Record<string,{requestHash:string;revision:number}>;archivedPlans:Record<string,LongTermPlanSnapshot>};
type LongTermWorkspace={schemaVersion:1;libraries:Record<string,StoredLongTermPlan>};
export type LongTermLocalScope={workspaceId:string;libraryId:string};
const empty=():StoredLongTermPlan=>({schemaVersion:1,state:emptyLongTermPlanState(),operations:{},archivedPlans:{}});
function requireScope(scope:LongTermLocalScope):void{
  if(!scope||typeof scope.workspaceId!=='string'||!scope.workspaceId.trim())throw new Error('invalid-long-term-workspace');
  if(typeof scope.libraryId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(scope.libraryId))throw new Error('invalid-long-term-library');
  if(typeof indexedDB==='undefined')throw new Error('本地学习数据库不可用，无法读取或保存长线计划。');
}
function workspace(raw:unknown):LongTermWorkspace{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('invalid-long-term-storage');
  const value=raw as LongTermWorkspace;
  if(value.schemaVersion!==1||Object.keys(value).length!==2||!value.libraries||typeof value.libraries!=='object'||Array.isArray(value.libraries))throw new Error('invalid-long-term-storage');
  return value;
}
function parseStored(raw:unknown):StoredLongTermPlan{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('invalid-long-term-storage');
  const value=raw as StoredLongTermPlan;
  if(value.schemaVersion!==1||Object.keys(value).some(key=>!['schemaVersion','state','operations','archivedPlans'].includes(key)))throw new Error('invalid-long-term-storage');
  const state=parseLongTermPlanState(value.state);
  for(const field of [value.operations,value.archivedPlans])if(!field||typeof field!=='object'||Array.isArray(field))throw new Error('invalid-long-term-storage');
  for(const [id,entry] of Object.entries(value.operations)){
    if(!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(id)||!entry||typeof entry!=='object'||Object.keys(entry).length!==2
      ||!Number.isSafeInteger(entry.revision)||entry.revision<1||entry.revision>state.revision||!/^[a-f0-9]{64}$/.test(entry.requestHash))throw new Error('invalid-long-term-operation-history');
  }
  if(state.revision>0&&(!state.lastOperationId||!Object.hasOwn(value.operations,state.lastOperationId)||value.operations[state.lastOperationId].revision!==state.revision))throw new Error('invalid-long-term-operation-history');
  const archivedPlans:Record<string,LongTermPlanSnapshot>={};
  for(const [id,snapshot] of Object.entries(value.archivedPlans)){const parsed=parseLongTermPlanSnapshot(snapshot);if(parsed.spec.planId!==id)throw new Error('invalid-long-term-archive');Object.defineProperty(archivedPlans,id,{value:parsed,enumerable:true,writable:true,configurable:true});}
  return{schemaVersion:1,state,operations:structuredClone(value.operations),archivedPlans};
}
export async function loadLongTermPlanState(scope:LongTermLocalScope):Promise<LongTermPlanState>{
  requireScope(scope);
  const saved=workspace(await loadWorkspaceRecord(scope.workspaceId,'long-term-plan',{schemaVersion:1,libraries:{}}));
  return Object.hasOwn(saved.libraries,scope.libraryId)?parseStored(saved.libraries[scope.libraryId]).state:emptyLongTermPlanState();
}
export async function saveLongTermPlanState(scope:LongTermLocalScope,raw:LongTermPlanMutation):Promise<LongTermPlanMutationResult>{
  requireScope(scope);const mutation=parseLongTermPlanMutation(raw),requestHash=await longTermRequestHash(mutation);
  let result:LongTermPlanMutationResult={status:'stale',state:emptyLongTermPlanState()};
  await updateWorkspaceRecord<LongTermWorkspace>(scope.workspaceId,'long-term-plan',{schemaVersion:1,libraries:{}},rawSaved=>{
    const saved=workspace(rawSaved),before=Object.hasOwn(saved.libraries,scope.libraryId)?parseStored(saved.libraries[scope.libraryId]):empty();
    const prior=Object.hasOwn(before.operations,mutation.operationId)?before.operations[mutation.operationId]:undefined;
    if(prior){if(prior.requestHash!==requestHash)throw new Error('long-term-operation-conflict');result={status:'duplicate',state:before.state};return saved;}
    if(before.state.revision!==mutation.expectedRevision){result={status:'stale',state:before.state};return saved;}
    assertLongTermPlanTransition(before.state.snapshot,mutation.snapshot);
    const revision=before.state.revision+1;
    if(!Number.isSafeInteger(revision))throw new Error('invalid-long-term-revision');
    const state:LongTermPlanState={revision,enabled:mutation.enabled,snapshot:mutation.snapshot,lastOperationId:mutation.operationId};
    const archivedPlans={...before.archivedPlans};
    if(before.state.snapshot&&before.state.snapshot.spec.planId!==mutation.snapshot.spec.planId)Object.defineProperty(archivedPlans,before.state.snapshot.spec.planId,{value:before.state.snapshot,enumerable:true,writable:true,configurable:true});
    result={status:'accepted',state};
    const next:StoredLongTermPlan={schemaVersion:1,state,operations:{...before.operations,[mutation.operationId]:{requestHash,revision}},archivedPlans};
    return{schemaVersion:1,libraries:{...saved.libraries,[scope.libraryId]:next}};
  });
  return structuredClone(result);
}
