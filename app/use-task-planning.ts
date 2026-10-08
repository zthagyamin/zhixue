'use client';
import type {CompanionPlanClient} from './companion-plan-client';
import {loadTaskDraft,saveTaskDraft,archiveTaskDraft,loadTaskDraftBackups} from './local-task-plan';
import {putTaskEvent,listTaskEvents,listPendingTaskEvents} from './local-task-events';
import {listWorkspaceStudyEvents} from './local-study-events';
import {loadPlanningWithCache} from './local-planning-cache';
import {createTaskPlanningSession,type TaskPlanningBundle} from './task-planning-session';
import {useNativePlanningView} from '../src/features/planning';
/** Legacy stores/projections are explicit adapters; the feature owns React lifetime. */
export function useTaskPlanning(options:{
  client:CompanionPlanClient|null;enabled:boolean;storageReady:boolean;workspaceId:string;day:string;evidenceEpoch:string;
  loadBundle:(workspaceId:string,day:string,full:boolean)=>Promise<TaskPlanningBundle>;
  restoreCachedStudy?:(workspaceId:string,bundle:TaskPlanningBundle)=>Promise<TaskPlanningBundle|void>;
}){
  return useNativePlanningView({...options,sessionKey:options.client,createSession:runtime=>createTaskPlanningSession({
    loadDraft:loadTaskDraft,saveDraft:saveTaskDraft,archiveDraft:archiveTaskDraft,
    loadLastBackup:async(workspace,day)=>(await loadTaskDraftBackups(workspace,day)).at(-1)?.draft??null,
    putTaskEvent,client:options.client!,publish:runtime.publish,
    loadBundle:async(workspace,day,full)=>{
      const bundle=await loadPlanningWithCache(workspace,day,()=>runtime.loadBundle(workspace,day,full),async()=>({
        localEvents:(await listWorkspaceStudyEvents(workspace)).map(record=>record.event),taskEvents:await listTaskEvents(workspace),pendingTaskCount:(await listPendingTaskEvents(workspace)).length,
      }));
      return bundle.offline?(await runtime.restoreCachedStudy(workspace,bundle))??bundle:bundle;
    },
  })});
}