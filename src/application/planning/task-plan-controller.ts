import type {TaskPlanV2,SuggestionRequest,SuggestionResponse} from '../../domain/planning';
import type {TaskDraft} from '../../domain/planning';
// @ts-expect-error TS5097: Node's tests use explicit TypeScript extensions.
import {parseTaskDraft} from '../../domain/planning/index.ts';

export function acceptSuggestionResponse(current:TaskPlanV2,response:SuggestionResponse):boolean {
  return current.day===response.day && current.sourceHash===response.sourceHash && current.draftVersion===response.draftVersion;
}
export type TaskPlanState={workspaceId:string;day:string;draft:TaskDraft|null;loading:boolean;error:string|null};
type DraftUpdate=(draft:TaskDraft|null)=>TaskDraft|null|Promise<TaskDraft|null>;
type SuggestionApply=(draft:TaskDraft,response:SuggestionResponse)=>TaskDraft|Promise<TaskDraft>;
export function createTaskPlanController(dependencies:{
  load:(workspaceId:string,day:string)=>Promise<TaskDraft|null>;
  save:(workspaceId:string,draft:TaskDraft,expected?:TaskDraft|null)=>Promise<void>;
  publish:(state:TaskPlanState)=>void;
}) {
  let state:TaskPlanState={workspaceId:'',day:'',draft:null,loading:false,error:null};
  let contextVersion=0,editVersion=0,evidenceVersion=0;
  let queue:Promise<unknown>=Promise.resolve();
  const snapshot=()=>structuredClone(state);
  const publish=()=>dependencies.publish(snapshot());
  const report=(error:unknown)=>{state={...state,error:error instanceof Error?error.message:'计划草稿操作失败。'};publish();};
  const change=(update:DraftUpdate,isCurrent=()=>true):Promise<boolean>=>{
    if(!isCurrent())return Promise.resolve(false);
    if (state.loading) return Promise.reject(new Error('task-draft-loading'));
    if (!state.workspaceId || !state.day) return Promise.reject(new Error('task-draft-not-ready'));
    const context=contextVersion,workspace=state.workspaceId,day=state.day;
    editVersion++;
    const result=queue.then(async()=>{
      if (context!==contextVersion||!isCurrent()) return false;
      try {
        const updated=await update(structuredClone(state.draft));
        if (!updated||context!==contextVersion||!isCurrent()) return false;
        const draft=parseTaskDraft(updated);
        if (context!==contextVersion||!isCurrent()) return false;
        if (draft.plan.day!==day) throw new Error('task-draft-day-mismatch');
        await dependencies.save(workspace,draft,structuredClone(state.draft));
        if (context!==contextVersion) return false;
        state={...state,draft,error:null};publish();return true;
      } catch(error) {if (context===contextVersion) report(error);throw error;}
    });
    queue=result.catch(()=>{});
    return result;
  };
  return {
    snapshot,change,
    invalidateEvidence:()=>{editVersion++;evidenceVersion++;},
    open:async(workspaceId:string,day:string):Promise<void>=>{
      const context=++contextVersion;editVersion++;
      state={workspaceId,day,draft:null,loading:true,error:null};publish();
      try {
        const value=await dependencies.load(workspaceId,day);
        if (context!==contextVersion) return;
        const draft=value?parseTaskDraft(value):null;
        if (draft && draft.plan.day!==day) throw new Error('task-draft-day-mismatch');
        state={...state,draft,loading:false};publish();
      } catch(error) {if (context===contextVersion) {state={...state,loading:false};report(error);}throw error;}
    },
    suggest:async(intent:SuggestionRequest['intent'],request:(input:SuggestionRequest)=>Promise<SuggestionResponse>,apply:SuggestionApply):Promise<boolean>=>{
      if (!state.draft || state.loading) throw new Error('task-draft-not-ready');
      const context=contextVersion,edit=editVersion,evidence=evidenceVersion,current=structuredClone(state.draft.plan);
      try {
        const response=await request({day:current.day,sourceHash:current.sourceHash,draftVersion:current.draftVersion,
          excludedUnitIds:current.manual.excludedUnitIds,selectedUnitIds:[...new Set(current.tasks.flatMap(task=>task.unitIds))],intent,
          ...(current.optionalMinutes===undefined?{}:{optionalMinutes:current.optionalMinutes})});
        if (context!==contextVersion || edit!==editVersion || !state.draft || !acceptSuggestionResponse(state.draft.plan,response)) return false;
        return change(async draft=>{
          if (!draft || context!==contextVersion || evidence!==evidenceVersion || !acceptSuggestionResponse(draft.plan,response)) return null;
          const updated=await apply(draft,response);
          return context===contextVersion && evidence===evidenceVersion?updated:null;
        });
      } catch(error) {if (context===contextVersion && edit===editVersion) report(error);throw error;}
    },
  };
}
