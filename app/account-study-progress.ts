import type {CloudProgress} from './cloud-sync-types';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {loadWorkspaceRecord,saveWorkspaceRecord,listAccountProgressLibraries} from './local-study-db.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {studyCount,studyDigest,studyId,studyObject} from './account-study-content.ts';
// @ts-expect-error TS5097: standalone Node tests.
import {hashLocalJson} from './local-json-integrity.ts';

export type AccountProgressView={schemaVersion:1;workspaceId:string;libraryId:string;progress:CloudProgress;evidenceHash:string|null;historyReady:boolean};
type Incoming={workspaceId:string;libraryId:string;progress:CloudProgress|null;evidenceHash:string|null;historyReady:boolean};
const empty=():CloudProgress=>({itemStages:{},fsrsData:{},answered:0,correct:0});
function scopeKey(workspaceId:string,libraryId:string):string{
  if(!workspaceId.startsWith('account:'))throw new Error('invalid-account-progress-owner');studyId(workspaceId.slice(8),'user');studyId(libraryId,'library');
  // Disjoint from every legacy account:<user> workspace. No database upgrade.
  return 'account-progress:'+JSON.stringify([workspaceId,libraryId]);
}
function sameScope(view:AccountProgressView|null,value:Incoming):boolean{return Boolean(view&&view.workspaceId===value.workspaceId&&view.libraryId===value.libraryId);}
function parse(raw:unknown,workspaceId:string,libraryId:string):AccountProgressView{
  const value=studyObject(raw,['schemaVersion','workspaceId','libraryId','progress','evidenceHash','historyReady']);
  if(value.schemaVersion!==1||value.workspaceId!==workspaceId||value.libraryId!==libraryId||typeof value.historyReady!=='boolean')throw new Error('account-progress-scope');
  if(value.evidenceHash!==null)studyDigest(value.evidenceHash);
  const p=studyObject(value.progress,['itemStages','fsrsData','answered','correct']);studyCount(p.answered,'answered');studyCount(p.correct,'correct');
  if(!p.itemStages||typeof p.itemStages!=='object'||Array.isArray(p.itemStages)||!p.fsrsData||typeof p.fsrsData!=='object'||Array.isArray(p.fsrsData))throw new Error('account-progress-invalid');
  for(const stage of Object.values(p.itemStages)){studyCount(stage,'stage');if(stage>3)throw new Error('account-progress-stage');}
  return structuredClone(value) as AccountProgressView;
}
export async function loadAccountProgress(workspaceId:string,libraryId:string):Promise<AccountProgressView|null>{
  const saved=await loadWorkspaceRecord<{view:unknown;hash:string}|null>(scopeKey(workspaceId,libraryId),'progress',null);if(!saved)return null;
  studyObject(saved,['view','hash']);if(await hashLocalJson(saved.view)!==saved.hash)throw new Error('account-progress-integrity');return parse(saved.view,workspaceId,libraryId);
}
export async function saveAccountProgress(raw:AccountProgressView):Promise<void>{
  const key=scopeKey(raw.workspaceId,raw.libraryId),view=parse(raw,raw.workspaceId,raw.libraryId);await saveWorkspaceRecord(key,'progress',{view,hash:await hashLocalJson(view)});
}
export async function exportAccountProgress(workspaceId:string):Promise<AccountProgressView[]>{
  const result:AccountProgressView[]=[];for(const libraryId of await listAccountProgressLibraries(workspaceId)){
    const view=await loadAccountProgress(workspaceId,libraryId);if(!view)throw new Error('account-progress-export-incomplete');result.push(view);
  }return result;
}
/** UI projection only: does not create events, schedule reviews or prove mastery. */
export function projectAccountProgress(current:AccountProgressView|null,cached:AccountProgressView|null,incoming:Incoming,pendingKeys:ReadonlySet<string>):AccountProgressView{
  const base=sameScope(current,incoming)?current!:sameScope(cached,incoming)?cached!:null;
  const progress=structuredClone(base?.progress??empty());
  if(incoming.progress&&(!base||base.evidenceHash!==incoming.evidenceHash)){
    for(const [key,stage]of Object.entries(incoming.progress.itemStages??{}))if(!pendingKeys.has(key))progress.itemStages![key]=stage;
    for(const [key,value]of Object.entries(incoming.progress.fsrsData??{}))if(!pendingKeys.has(key))progress.fsrsData![key]=value;
  }
  return{schemaVersion:1,workspaceId:incoming.workspaceId,libraryId:incoming.libraryId,progress,evidenceHash:incoming.evidenceHash??base?.evidenceHash??null,historyReady:incoming.historyReady};
}
