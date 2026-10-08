import type {TrialQuestion} from './note-trial-model';
// @ts-expect-error TS5097: direct Node regression execution.
import {hashLocalJson} from './local-json-integrity.ts';
export type BackupTrialMaterial={id:string;subject:string;title:string;questions:TrialQuestion[]};
const object=(value:unknown):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new Error('材料备份格式无效。');
 return value as Record<string,unknown>;
};
function text(value:unknown,max:number,nonempty=false):string{if(typeof value!=='string'||value.length>max||nonempty&&!value.trim())throw new Error('材料字段不完整或过长。');return value;}
export function parseBackupTrialMaterials(raw:unknown):BackupTrialMaterial[]{
 if(!Array.isArray(raw)||raw.length>50)throw new Error('单个学习库最多恢复 50 份材料。');
 const ids=new Set<string>();return raw.map(value=>{
  const v=object(value),id=text(v.id,70,true);if(!/^trial-[a-f0-9]{64}$/.test(id)||ids.has(id))throw new Error('材料标识无效或重复。');ids.add(id);
  if(!Array.isArray(v.questions)||!v.questions.length||v.questions.length>3)throw new Error('每份材料须有 1–3 道题。');
  const questions=v.questions.map(value=>{const q=object(value);if(q.kind!=='qa'&&q.kind!=='recall')throw new Error('未知材料题型。');return{id:text(q.id,200),prompt:text(q.prompt,1000,true),answer:text(q.answer,8000,true),filename:text(q.filename,180),section:q.section===null?null:text(q.section,1000),kind:q.kind} as TrialQuestion;});
  return {id,subject:text(v.subject,80,true),title:text(v.title,180,true),questions};
 });
}
export function trialMaterialRecordKind(library:string):`note-trial-materials:${string}`{if(typeof library!=='string'||!library.trim()||library.length>1000)throw new Error('学习库尚未确认。');return `note-trial-materials:${JSON.stringify(library)}`;}
function validateOwner(owner:string){if(typeof owner!=='string'||!owner.trim()||owner.length>1000)throw new Error('学习空间尚未确认。');}
async function verifyMaterialIds(items:BackupTrialMaterial[]){for(const item of items){const body={subject:item.subject,title:item.title,questions:item.questions};const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(body)));const id='trial-'+Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');if(item.id!==id)throw new Error('材料内容与标识不符，未导入。');}}
export async function makeTrialMaterialBackup(owner:string,library:string,raw:unknown){
 validateOwner(owner);trialMaterialRecordKind(library);const items=parseBackupTrialMaterials(raw);await verifyMaterialIds(items);
 const payload={owner,library,items};return {format:'zhixue-trial-materials-v1',schemaVersion:1,payload,payloadHash:await hashLocalJson(payload)};
}
/** Restore this owner's current library's material ONLY. Never interpret other backup records. */
export async function readTrialMaterialBackup(raw:unknown,owner:string,library:string):Promise<BackupTrialMaterial[]>{
 validateOwner(owner);const kind=trialMaterialRecordKind(library),v=object(raw);
 if(v.schemaVersion!==1)throw new Error('不支持这个备份版本。');
 let value:unknown;
 if(v.format==='zhixue-trial-materials-v1'){
  const payload=object(v.payload);if(payload.owner!==owner||payload.library!==library)throw new Error('备份属于其他账号或学习库，请切回原空间恢复。');
  if(v.payloadHash!==await hashLocalJson(payload))throw new Error('备份校验失败。');value=payload.items;
 }else if(v.format==='zhixue-study-recovery-v1'){
  if(v.workspaceId!==owner)throw new Error('恢复包属于其他账号。');const payload=object(v.payload);
  if(v.payloadHash!==await hashLocalJson(payload))throw new Error('恢复包校验失败。');
  if(!Array.isArray(payload.workspaceRecords))throw new Error('恢复包缺少材料记录。');
  const rows=payload.workspaceRecords.map(object).filter(row=>row.kind===kind);
  if(rows.length!==1)throw new Error('恢复包没有此学习库的材料；旧包可能不包含本机待学材料。');
  const row=rows[0];if(row.workspaceId!==owner||row.id!==`${owner}:${kind}`)throw new Error('材料所属空间不一致。');value=row.value;
 }else throw new Error('请选择知学材料备份或账号恢复包。');
 const items=parseBackupTrialMaterials(value);await verifyMaterialIds(items);return items;
}
export function mergeTrialMaterialBackup(current:unknown,incoming:unknown):BackupTrialMaterial[]{
 const original=parseBackupTrialMaterials(current),added=parseBackupTrialMaterials(incoming),map=new Map(original.map(item=>[item.id,item]));
 for(const item of added){const prior=map.get(item.id);if(prior&&JSON.stringify(prior)!==JSON.stringify(item))throw new Error('同名标识内容冲突；原材料保留。');if(!prior)map.set(item.id,item);}
 if(map.size>50)throw new Error('合并后超过 50 份材料，请先整理；原材料未改动。');return [...map.values()];
}
