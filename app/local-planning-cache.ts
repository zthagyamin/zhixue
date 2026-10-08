import type {TaskPlanningBundle} from './task-planning-session';
import type {StudyEventV3} from './study-event-v3';
import type {TaskEventV1} from './task-plan-types';
import type {DynamicSubject} from './dynamic-ui-model';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {loadWorkspaceRecord,updateWorkspaceRecord} from './local-study-db.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {buildDailyPlanningInput} from './task-planning-input.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {validPlanDay} from './task-plan-types.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {assertPlanningStudySources} from './task-plan-runtime.ts';

type Cache={schemaVersion:1;workspaceId:string;day:string;bundle:TaskPlanningBundle;cacheHash:string};
// Cache includes client FSRS floats; V3's integer-only core canonicalizer is deliberately unchanged.
function cacheText(value:unknown):string {
  if(value===null || typeof value==='string' || typeof value==='boolean') return JSON.stringify(value);
  if(typeof value==='number' && Number.isFinite(value)) return JSON.stringify(value);
  if(Array.isArray(value)){
    const children:string[]=[];for(let index=0;index<value.length;index++){if(!(index in value)) throw new Error('invalid-planning-cache-value');children.push(cacheText(value[index]));}
    return `[${children.join(',')}]`;
  }
  if(value && typeof value==='object' && [Object.prototype,null].includes(Object.getPrototypeOf(value))){
    return `{${Object.entries(value).filter(([,child])=>child!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,child])=>`${JSON.stringify(key)}:${cacheText(child)}`).join(',')}}`;
  }
  throw new Error('invalid-planning-cache-value');
}
async function cacheHash(value:unknown):Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(cacheText(value)));
  return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
}
export class PlanningOfflineError extends Error {}
export type OfflinePlanningBundle=TaskPlanningBundle & {offline?:boolean;pendingTaskCount?:number;cacheWarning?:string};
function clean(bundle:TaskPlanningBundle):TaskPlanningBundle {
  return structuredClone({context:bundle.context,authority:bundle.authority,localEvents:bundle.localEvents,companionRecords:bundle.companionRecords,
    taskEvents:bundle.taskEvents,legacyItemKeys:bundle.legacyItemKeys,history:bundle.history,
    ...(bundle.studyData===undefined?{}:{studyData:bundle.studyData})});
}
async function validate(bundle:TaskPlanningBundle,day:string):Promise<void> {
  if(!bundle.authority || !Number.isSafeInteger(bundle.authority.revision) || bundle.authority.revision!==bundle.context?.planRevision) throw new Error('planning-cache-revision');
  await buildDailyPlanningInput({...bundle,day,previous:null});
  if(bundle.studyData!==undefined){
    const data=bundle.studyData as {subjects?:DynamicSubject[];source?:{title?:unknown};gateway?:{mode?:unknown}};
    if(!data || !Array.isArray(data.subjects) || typeof data.source?.title!=='string' || data.gateway?.mode!=='indexed') throw new Error('invalid-planning-study-cache');
    assertPlanningStudySources(bundle.context.catalog,data.subjects);
  }
}
export async function loadPlanningCache(workspaceId:string):Promise<TaskPlanningBundle|null> {
  const cache=await loadWorkspaceRecord<Cache|null>(workspaceId,'task-planning-cache',null);
  if(!cache) return null;
  const {cacheHash:expectedHash,...body}=cache;
  if(cache.schemaVersion!==1 || cache.workspaceId!==workspaceId || !validPlanDay(cache.day) || await cacheHash(body)!==expectedHash) throw new Error('planning-cache-integrity');
  await validate(cache.bundle,cache.day);return clean(cache.bundle);
}
async function savePlanningCache(workspaceId:string,day:string,bundle:TaskPlanningBundle):Promise<void> {
  await validate(bundle,day);
  const body={schemaVersion:1 as const,workspaceId,day,bundle:clean(bundle)},cache={...body,cacheHash:await cacheHash(body)};
  await updateWorkspaceRecord<Cache|null>(workspaceId,'task-planning-cache',null,old=>{
    if(old?.workspaceId===workspaceId && Date.parse(old.bundle?.context?.observedAt)>Date.parse(bundle.context.observedAt)) return old;
    return cache;
  });
}
function unavailable(error:unknown):boolean {
  return error instanceof PlanningOfflineError || (error instanceof Error && ['TimeoutError','AbortError'].includes(error.name))
    || (error instanceof TypeError && /fetch|network|load failed/i.test(error.message));
}
/** Offline means a previously verified snapshot, never treating a failed channel as empty history. */
export async function loadPlanningWithCache(workspaceId:string,day:string,fetchBundle:()=>Promise<TaskPlanningBundle>,readLocal:()=>Promise<{
  localEvents:StudyEventV3[];taskEvents:TaskEventV1[];pendingTaskCount:number;
}>):Promise<OfflinePlanningBundle> {
  let bundle:TaskPlanningBundle;
  try{bundle=await fetchBundle();}
  catch(error){
    if(!unavailable(error)) throw error;
    const cached=await loadPlanningCache(workspaceId);if(!cached) throw error;
    const local=await readLocal();
    const restored={...cached,localEvents:[...cached.localEvents,...local.localEvents],taskEvents:[...cached.taskEvents,...local.taskEvents]};
    await validate(restored,day);
    return {...restored,offline:true,pendingTaskCount:local.pendingTaskCount};
  }
  try{await savePlanningCache(workspaceId,day,bundle);return bundle;}
  catch(error){
    // Invalid facts must fail closed; storage exhaustion alone must not discard a valid online read.
    if(error instanceof Error && ['QuotaExceededError','UnknownError'].includes(error.name)) return {...bundle,cacheWarning:'本次离线缓存未能更新，请保持连接。'};
    throw error;
  }
}
