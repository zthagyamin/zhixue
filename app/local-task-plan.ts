import type {TaskDraft} from '../src/domain/planning';
export type {TaskDraft} from '../src/domain/planning';
// @ts-expect-error TS5097: standalone Node source contracts.
import {parseTaskDraft} from '../src/domain/planning/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
export {parseTaskDraft} from '../src/domain/planning/index.ts';
// @ts-expect-error TS5097: Node's tests use explicit TypeScript extensions.
import {validPlanDay} from './task-plan-types.ts';
// @ts-expect-error TS5097: Node's tests use explicit TypeScript extensions.
import {loadWorkspaceRecord,updateWorkspaceRecord} from './local-study-db.ts';
function validWorkspace(workspaceId:string):void {
  if (typeof workspaceId!=='string' || !workspaceId.trim()) throw new Error('invalid-task-workspace');
}
export async function loadTaskDraft(workspaceId:string,day:string):Promise<TaskDraft|null> {
  validWorkspace(workspaceId);
  if (!validPlanDay(day)) throw new Error('invalid-plan-day');
  if (typeof indexedDB==='undefined') throw new Error('本地学习数据库不可用，无法恢复草稿。');
  const days=await loadWorkspaceRecord<Record<string,TaskDraft>>(workspaceId,'task-plan-drafts',{});
  if (!Object.hasOwn(days,day)) return null;
  const draft=parseTaskDraft(days[day]);
  if (draft.plan.day!==day) throw new Error('task-draft-day-mismatch');
  return draft;
}
export async function saveTaskDraft(workspaceId:string,value:TaskDraft,expected?:TaskDraft|null):Promise<void> {
  validWorkspace(workspaceId);
  const draft=parseTaskDraft(value);
  await updateWorkspaceRecord<Record<string,TaskDraft>>(workspaceId,'task-plan-drafts',{},days=>{
    const old=Object.hasOwn(days,draft.plan.day)?parseTaskDraft(days[draft.plan.day]):null;
    if(expected!==undefined && (old?.plan.planHash!==expected?.plan.planHash || old?.baseRevision!==expected?.baseRevision
      || old?.plan.draftVersion!==expected?.plan.draftVersion || old?.dirty!==expected?.dirty)) throw new Error('stale-task-draft');
    if (old && (draft.baseRevision<old.baseRevision || (draft.baseRevision===old.baseRevision && draft.plan.draftVersion<old.plan.draftVersion))) throw new Error('stale-task-draft');
    if (old && draft.baseRevision===old.baseRevision && draft.plan.draftVersion===old.plan.draftVersion && draft.plan.planHash!==old.plan.planHash) throw new Error('task-draft-conflict');
    return {...days,[draft.plan.day]:draft};
  });
}

export type TaskDraftBackup={draft:TaskDraft;archivedAt:string};
export async function archiveTaskDraft(workspaceId:string,value:TaskDraft):Promise<void> {
  validWorkspace(workspaceId);const draft=parseTaskDraft(value),key=`${draft.plan.day}:${draft.baseRevision}:${draft.plan.planHash}`;
  await updateWorkspaceRecord<Record<string,TaskDraftBackup>>(workspaceId,'task-plan-backups',{},saved=>
    Object.hasOwn(saved,key)?saved:{...saved,[key]:{draft,archivedAt:new Date().toISOString()}});
}
export async function loadTaskDraftBackups(workspaceId:string,day:string):Promise<TaskDraftBackup[]> {
  validWorkspace(workspaceId);if(!validPlanDay(day)) throw new Error('invalid-plan-day');
  const saved=await loadWorkspaceRecord<Record<string,TaskDraftBackup>>(workspaceId,'task-plan-backups',{});
  return Object.values(saved).map(entry=>({draft:parseTaskDraft(entry.draft),archivedAt:entry.archivedAt}))
    .filter(entry=>entry.draft.plan.day===day).sort((a,b)=>a.archivedAt.localeCompare(b.archivedAt));
}
