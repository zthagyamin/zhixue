import type {NonwordRecovery} from './index';
// @ts-expect-error TS5097: standalone Node source contracts.
import {attemptFingerprint} from '../learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {existingDatabase} from './database.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {validateNonwordRecovery} from './validation.ts';
export type RecoveryArchive={schemaVersion:1;key:string[];source:NonwordRecovery;sourceHash:string;pendingReview?:boolean};
const name='zhixue-nonword-recovery-archives-v1';
async function open():Promise<IDBDatabase>{
 if(typeof indexedDB==='undefined')throw Error('nonword-recovery-storage-unavailable');
 return new Promise((resolve,reject)=>{const r=indexedDB.open(name,1);r.onupgradeneeded=()=>r.result.createObjectStore('packages',{keyPath:'key'});r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('nonword-recovery-archive-blocked'));r.onsuccess=()=>{r.result.onversionchange=()=>r.result.close();resolve(r.result);};});
}
export async function readRecoveryArchives(workspaceId:string):Promise<RecoveryArchive[]>{
 const db=await existingDatabase(name);if(!db)return [];
 if(!db.objectStoreNames.contains('packages')){db.close();throw Error('nonword-recovery-archive-schema');}
 const schema=db.transaction('packages').objectStore('packages');if(schema.keyPath!=='key'||schema.autoIncrement){db.close();throw Error('nonword-recovery-archive-schema');}
 try{return await new Promise((resolve,reject)=>{const r=db.transaction('packages').objectStore('packages').getAll(IDBKeyRange.bound([workspaceId],[workspaceId,[]]),501);r.onerror=()=>reject(r.error);r.onsuccess=async()=>{try{if(r.result.length>500)throw Error('nonword-recovery-archive-limit');const rows=r.result as RecoveryArchive[];for(const row of rows){if(row.schemaVersion!==1||Object.keys(row).some(key=>!['schemaVersion','key','source','sourceHash','pendingReview'].includes(key))||row.pendingReview!==undefined&&typeof row.pendingReview!=='boolean'||row.key[0]!==workspaceId||row.key[1]!==row.sourceHash||row.sourceHash!==await attemptFingerprint(row.source)||JSON.stringify(row.source.owners)!==JSON.stringify([workspaceId.slice(8),workspaceId]))throw Error('nonword-recovery-archive-integrity');await validateNonwordRecovery(row.source);}resolve(rows);}catch(error){reject(error);}};});}finally{db.close();}
}
/** Unverified imported evidence remains available for inspection; it is never a grading authority. */
export async function saveRecoveryArchive(workspaceId:string,source:NonwordRecovery,current:()=>boolean):Promise<string>{
 const sourceHash=await attemptFingerprint(source),row:RecoveryArchive={schemaVersion:1,key:[workspaceId,sourceHash],source:structuredClone(source),sourceHash,pendingReview:true};
 if(!current())throw Error('nonword-recovery-stale');const db=await open();
 try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('packages','readwrite'),store=tx.objectStore('packages'),get=store.get(row.key);let error:unknown;
  if(store.keyPath!=='key'||store.autoIncrement){error=Error('nonword-recovery-archive-schema');tx.abort();}
  const finish=()=>{if(!current()){error=Error('nonword-recovery-stale');tx.abort();}else tx.commit?.();};
  get.onsuccess=()=>{if(!current()){error=Error('nonword-recovery-stale');tx.abort();return;}if(!get.result){const count=store.count(IDBKeyRange.bound([workspaceId],[workspaceId,[]]));count.onsuccess=()=>{if(!current()||count.result>=500){error=Error(count.result>=500?'nonword-recovery-archive-limit':'nonword-recovery-stale');tx.abort();return;}store.add(row).onsuccess=finish;};}else store.put({...get.result,pendingReview:true}).onsuccess=finish;};
  tx.oncomplete=()=>resolve();tx.onabort=()=>reject(error??tx.error??Error('nonword-recovery-archive-failed'));tx.onerror=()=>reject(error??tx.error??Error('nonword-recovery-archive-failed'));
 });}finally{db.close();}
 const check=await open();try{const saved=await new Promise<RecoveryArchive>((resolve,reject)=>{const get=check.transaction('packages').objectStore('packages').get(row.key);get.onsuccess=()=>resolve(get.result);get.onerror=()=>reject(get.error);});if(!saved||saved.sourceHash!==sourceHash||await attemptFingerprint(saved.source)!==sourceHash)throw Error('nonword-recovery-archive-receipt');}finally{check.close();}return sourceHash;
}
export async function markRecoveryArchive(workspaceId:string,sourceHash:string,pendingReview:boolean,current:()=>boolean):Promise<void>{
 if(!current())throw Error('nonword-recovery-stale');const db=await open();
 try{await new Promise<void>((resolve,reject)=>{const tx=db.transaction('packages','readwrite'),store=tx.objectStore('packages'),get=store.get([workspaceId,sourceHash]);let failure:unknown;
 get.onsuccess=()=>{if(!current()){failure=Error('nonword-recovery-stale');tx.abort();return;}if(get.result)store.put({...get.result,pendingReview}).onsuccess=()=>{if(!current()){failure=Error('nonword-recovery-stale');tx.abort();}else tx.commit?.();};else{failure=Error('nonword-recovery-archive-missing');tx.abort();}};
 tx.oncomplete=()=>resolve();tx.onabort=()=>reject(failure??tx.error);tx.onerror=()=>reject(tx.error);
 });}finally{db.close();}
}
