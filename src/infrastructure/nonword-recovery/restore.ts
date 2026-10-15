import type {NonwordRecovery} from './index';
import type {RestoreOptions,RestorePreview,RestoreDecision,RestoreResult} from './restore-types';
import type {LearningAttempt} from '../../domain/learning-attempt';
// @ts-expect-error TS5097: standalone Node source contracts.
import {collectNonwordRecovery} from './capture.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {validateNonwordRecovery} from './validation.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {attemptFingerprint} from '../learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {canonicalAttemptJson,applyAttemptMutation} from '../../domain/learning-attempt/index.ts';
import type {AttemptMutation} from '../../domain/learning-attempt';
import type {RecoveryRow} from './database';
// @ts-expect-error TS5097: standalone Node source contracts.
import {sameRecoveryRow,restoreRecoveryDatabase} from './restore-store.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {saveRecoveryArchive,markRecoveryArchive} from './archive.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {parseContinuationNote} from '../../application/nonword-study/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {studyHash} from '../../domain/sync/index.ts';

async function read(workspaceId:string,raw:unknown):Promise<NonwordRecovery>{
 const pack=raw as {schemaVersion?:number;format?:string;workspaceId?:string;payload?:{nonword?:NonwordRecovery;nonwordArchives?:{schemaVersion:number;source:NonwordRecovery;sourceHash:string;key:string[]}[]};payloadHash?:string};
 if(new TextEncoder().encode(JSON.stringify(raw)).byteLength>32*1024*1024)throw Error('恢复包超过 32 MB，请在原设备整理后分批导出。');
 if(pack?.schemaVersion!==2||pack.format!=='zhixue-study-recovery-v2')throw Error('请选择包含非词汇作答的 V2 恢复包；旧包只能恢复原有材料。');
 if(pack.workspaceId!==workspaceId||!pack.payload?.nonword||pack.payloadHash!==await studyHash(pack.payload))throw Error('恢复包账号或校验值不匹配。');
 const source=structuredClone(pack.payload.nonword);
 if(canonicalAttemptJson(source.owners)!==canonicalAttemptJson([workspaceId.slice(8),workspaceId]))throw Error('恢复包作答所属账号不匹配。');
 await validateNonwordRecovery(source);return source;
}
async function readArchived(workspaceId:string,raw:unknown):Promise<NonwordRecovery[]>{
 const archives=(raw as {payload:{nonwordArchives?:{schemaVersion:number;source:NonwordRecovery;sourceHash:string;key:string[]}[]}}).payload.nonwordArchives??[];
 if(!Array.isArray(archives)||archives.length>500)throw Error('nonword-recovery-archive-limit');
 const result:NonwordRecovery[]=[];
 for(const archive of archives){
  if(archive.schemaVersion!==1||!Array.isArray(archive.key)||archive.key.length!==2||archive.key[0]!==workspaceId||archive.key[1]!==archive.sourceHash||archive.sourceHash!==await attemptFingerprint(archive.source)
    ||canonicalAttemptJson(archive.source.owners)!==canonicalAttemptJson([workspaceId.slice(8),workspaceId]))throw Error('nonword-recovery-archive-integrity');
  await validateNonwordRecovery(archive.source);result.push(structuredClone(archive.source));
 }return result;
}
async function initialMetadata(a:LearningAttempt,firstById:Map<string,LearningAttempt>):Promise<boolean>{
 if(!a.attemptId.startsWith('nw-continue:')||a.answer!==''||a.submitted||a.formal||a.parentAttemptId||a.evaluation.status!=='pending'||a.evaluation.reason!=='not-requested'
  ||a.checkpoint.mode!=='lesson'||a.checkpoint.purpose!=='guided'||a.checkpoint.intent!=='lesson'||a.checkpoint.phase!=='lesson')return false;
 try{const note=parseContinuationNote(JSON.parse(a.checkpoint.pluginFields?.notes??''));
  const first=firstById.get(canonicalAttemptJson([a.binding.ownerId,a.binding.libraryId,note.firstAttemptId]));
  return Boolean(first&&canonicalAttemptJson(first.binding)===canonicalAttemptJson(a.binding)&&note.sequence===0&&note.proof===null&&note.group===null&&note.boundary==='initial'
    &&a.attemptId===`nw-continue:${await attemptFingerprint(['nonword-continuation-v1',a.binding])}`);
 }catch{return false;}
}
function faithfulQueue(attempt:LearningAttempt,rows:RecoveryRow[]):boolean{
 const same=(a:unknown,b:unknown)=>canonicalAttemptJson(a)===canonicalAttemptJson(b);
 const queue=[...rows].sort((a,b)=>(a.mutation as AttemptMutation).expectedRevision-(b.mutation as AttemptMutation).expectedRevision);
 if(!queue.every(row=>{const m=row.mutation as AttemptMutation;return attempt.operations.some(op=>op.operationId===m.operationId&&op.fingerprint===row.fingerprint&&op.revision===m.expectedRevision+1);}))return false;
 if(queue.length===attempt.revision&&queue.every((row,index)=>(row.mutation as AttemptMutation).expectedRevision===index)){
  try{let replay:LearningAttempt|null=null;
   for(const row of queue){const result=applyAttemptMutation(replay,row.mutation as AttemptMutation,String(row.fingerprint));if(result.status!=='accepted')return false;replay=result.attempt;}
   if(attempt.startedAt===undefined&&replay)delete replay.startedAt;return same(replay,attempt);
  }catch{return false;}
 }
 const submitted=attempt.submitted,mutations=queue.map(row=>row.mutation as AttemptMutation),checkpoints=mutations.filter((m):m is Extract<AttemptMutation,{kind:'checkpoint'}>=>m.kind==='checkpoint');
 if(submitted){
  const first=mutations.findIndex(m=>m.kind==='submit');
  if(first>=0){const before=mutations.slice(0,first).filter((m):m is Extract<AttemptMutation,{kind:'checkpoint'}>=>m.kind==='checkpoint').at(-1);if(before&&before.answer!==submitted.answer)return false;}
  for(const m of mutations){
   if(m.kind==='submit'&&(m.answerRevision!==submitted.answerRevision||m.answerRevealed!==submitted.answerRevealed||m.maxPreHintLevel!==submitted.maxPreHintLevel))return false;
   if(m.kind==='checkpoint'&&(first<0||mutations.indexOf(m)>first)&&m.answer!==submitted.answer)return false;
  }
 }else if(checkpoints.length&&checkpoints.at(-1)!.answer!==attempt.answer)return false;
 return true;
}
async function formalProof(attempt:LearningAttempt,options:RestoreOptions):Promise<boolean>{
 if(!attempt.formal)return false;const proof=await options.verifyFormal?.(attempt),b=attempt.binding,f=attempt.formal;
 return Boolean(proof&&/^[a-f0-9]{64}$/.test(proof.coreHash)&&proof.ownerId===b.ownerId&&proof.libraryId===b.libraryId&&proof.eventId===f.eventId
  &&(f.coreHash===null||proof.coreHash===f.coreHash)&&proof.itemKey===b.itemKey&&proof.contentHash===b.contentHash
  &&proof.snapshotId===b.snapshotId&&proof.reviewedAt===f.occurredAt&&proof.rating===f.rating
  &&(!f.authoritativeRecord||canonicalAttemptJson(proof.authoritativeRecord)===canonicalAttemptJson(f.authoritativeRecord)));
}
async function plan(workspaceId:string,source:NonwordRecovery,options:RestoreOptions):Promise<RestorePreview>{
 if(!options.current())throw Error('nonword-recovery-stale');const current=await collectNonwordRecovery(workspaceId),decisions:RestoreDecision[]=[];
 const admitted=new Set<string>(),key=(value:unknown)=>canonicalAttemptJson(value);
 const attempts=source.databases.find(value=>value.kind==='attempts')!;
 const existingAttempts=current.databases.find(value=>value.kind==='attempts')!.stores.attempts;
 const firstById=new Map(attempts.stores.attempts.map(row=>[key(row.key),row.attempt as LearningAttempt])),priorById=new Map(existingAttempts.map(row=>[key(row.key),row]));
 const queues=new Map<string,RecoveryRow[]>();for(const row of attempts.stores.outbox){const id=key(row.key.slice(0,3)),rows=queues.get(id)??[];rows.push(row);queues.set(id,rows);}
 for(const row of attempts.stores.attempts){
  const a=row.attempt as LearningAttempt,queue=queues.get(key(row.key))??[];
  const prior=priorById.get(key(row.key));
  if(prior&&!sameRecoveryRow(prior,row))continue;
  const pending=a.evaluation.status==='pending'&&!a.formal&&!a.attemptId.startsWith('nw-')&&faithfulQueue(a,queue)
   &&queue.every(value=>{const m=value.mutation as {kind:string;evaluation?:{status:string}};return ['checkpoint','submit'].includes(m.kind)||m.kind==='evaluate'&&m.evaluation?.status==='pending';});
  if(faithfulQueue(a,queue)&&(pending||await initialMetadata(a,firstById)||await formalProof(a,options)||!a.formal&&await options.verifyRow?.('attempts','attempts',row)))admitted.add(key(row.key));
 }
 const all=new Map(attempts.stores.attempts.map(row=>[key(row.key),row.attempt as LearningAttempt])),local=new Map(existingAttempts.map(row=>[key(row.key),row.attempt as LearningAttempt]));
 const checked=new Set<string>();
 for(const id of [...admitted]){
  let next:string|null=id;const trail:string[]=[],seen=new Set<string>();let allowed=true;
  while(next&&!checked.has(next)){
   if(seen.has(next)||!admitted.has(next)){allowed=false;break;}seen.add(next);trail.push(next);
   const a=all.get(next)!;if(!a.parentAttemptId)break;
   const parentId=key([a.binding.ownerId,a.binding.libraryId,a.parentAttemptId]),parent=local.get(parentId)??all.get(parentId);
   if(!parent?.submitted||key(parent.binding)!==key(a.binding)){allowed=false;break;}
   const originalParent=all.get(parentId);
   if(local.has(parentId)&&originalParent&&(key(originalParent.submitted)!==key(parent.submitted)
     ||!originalParent.operations.every(op=>parent.operations.some(old=>key(old)===key(op))))){allowed=false;break;}
   if(local.has(parentId))break;next=parentId;
  }
  if(next&&checked.has(next)&&!admitted.has(next))allowed=false;
  for(const entry of trail){checked.add(entry);if(!allowed)admitted.delete(entry);}
 }
 for(const database of source.databases){const previous=current.databases.find(value=>value.kind===database.kind)!;
  const existingByStore=new Map(Object.entries(previous.stores).map(([store,rows])=>[store,new Map(rows.map(row=>[key(row.key),row]))]));
  for(const [store,rows]of Object.entries(database.stores))for(const original of rows){
   const row=structuredClone(original),prior=existingByStore.get(store)?.get(key(row.key));
   let allowed=database.kind==='attempts'&&['attempts','outbox'].includes(store)&&admitted.has(key(row.key.slice(0,3)))
    ||database.kind==='course-requests';
   if(!allowed&&!(database.kind==='attempts'&&['attempts','outbox'].includes(store)))allowed=await options.verifyRow?.(database.kind,store,row)===true;
   if(row.status!==undefined)row.status=row.status==='cloud-conflict'?'cloud-conflict':'device-only';
   decisions.push({kind:database.kind,store,row,state:prior?sameRecoveryRow(prior,row)?'existing':'conflict':allowed?'restore':'review'});
  }
 }
 if(!options.current())throw Error('nonword-recovery-stale');
 const body={schemaVersion:1 as const,workspaceId,packageHash:await attemptFingerprint(source),current,decisions};
 return {schemaVersion:1,workspaceId,packageHash:body.packageHash,previewHash:await attemptFingerprint(body),decisions,
  restorable:decisions.filter(value=>value.state==='restore').length,existing:decisions.filter(value=>value.state==='existing').length,
  conflicts:decisions.filter(value=>value.state==='conflict').length,review:decisions.filter(value=>value.state==='review').length};
}
export async function previewNonwordRestore(workspaceId:string,raw:unknown,options:RestoreOptions):Promise<RestorePreview>{await read(workspaceId,raw);await readArchived(workspaceId,raw);const preview=await plan(workspaceId,await read(workspaceId,raw),options);return {...preview,previewHash:await attemptFingerprint([preview.previewHash,(raw as {payloadHash:string}).payloadHash])};}
export async function restoreNonwordBackup(workspaceId:string,raw:unknown,previewHash:string,options:RestoreOptions):Promise<RestoreResult>{
 const source=await read(workspaceId,raw),archived=await readArchived(workspaceId,raw),preview=await previewNonwordRestore(workspaceId,raw,options);
 if(preview.previewHash!==previewHash)throw Error('本机记录或核对依据已变化，请重新预览；现有记录保留。');
 const archiveHash=await saveRecoveryArchive(workspaceId,source,options.current);let restored=0,existing=preview.existing;
 for(const copy of archived)await saveRecoveryArchive(workspaceId,copy,options.current);
 for(const database of source.databases){
  const decisions=preview.decisions.filter(value=>value.kind===database.kind&&value.state==='restore');if(!decisions.length)continue;
  if(!options.current())return {status:'stale',restored,existing,conflicts:preview.conflicts,review:preview.review,archiveHash};
  const stores=Object.fromEntries(Object.keys(database.stores).map(store=>[store,decisions.filter(value=>value.store===store).map(value=>value.row)]));
  try{const receipt=await restoreRecoveryDatabase({kind:database.kind,stores},options.current);restored+=receipt.restored;existing+=receipt.existing;}
  catch{return {status:'partial',restored,existing,conflicts:preview.conflicts,review:preview.review,archiveHash};}
 }
 await markRecoveryArchive(workspaceId,archiveHash,Boolean(preview.conflicts||preview.review),options.current);
 return {status:preview.conflicts||preview.review||archived.length?'partial':'restored',restored,existing,conflicts:preview.conflicts,review:preview.review+archived.length,archiveHash};
}
