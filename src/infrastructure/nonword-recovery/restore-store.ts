import type {RecoveryDatabase,RecoveryRow} from './database';
// @ts-expect-error TS5097: standalone Node source contracts.
import {NONWORD_RECOVERY_DATABASES} from './database.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {canonicalAttemptJson} from '../../domain/learning-attempt/index.ts';
export function sameRecoveryRow(a:RecoveryRow,b:RecoveryRow):boolean{
 const omit=(row:RecoveryRow)=>{const copy={...row};delete copy.status;delete copy.cloudRevision;return copy;};
 return canonicalAttemptJson(omit(a))===canonicalAttemptJson(omit(b));
}
/** Add-only, one transaction per database. Existing answers, statuses and evidence are never replaced. */
export async function restoreRecoveryDatabase(value:RecoveryDatabase,current:()=>boolean):Promise<{restored:number;existing:number}>{
 const descriptor=NONWORD_RECOVERY_DATABASES.find(row=>row.kind===value.kind);if(!descriptor)throw Error('nonword-recovery-database');
 if(!current())throw Error('nonword-recovery-stale');
 const db=await new Promise<IDBDatabase>((resolve,reject)=>{const r=indexedDB.open(descriptor.name,1);
  r.onupgradeneeded=()=>{for(const name of descriptor.stores){const store=r.result.createObjectStore(name,{keyPath:'key'});if(['attempts','course-evidence','practice-evidence'].includes(value.kind))store.createIndex('scope','scope');}};
  r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('nonword-recovery-storage-blocked'));r.onsuccess=()=>{r.result.onversionchange=()=>r.result.close();resolve(r.result);};
 });
 try{
  if(descriptor.stores.some(name=>!db.objectStoreNames.contains(name)))throw Error('nonword-recovery-storage-schema');
  const result=await new Promise<{restored:number;existing:number}>((resolve,reject)=>{
   const tx=db.transaction([...descriptor.stores],'readwrite');let restored=0,existing=0,error:unknown;
   let pending=Object.values(value.stores).reduce((sum,rows)=>sum+rows.length,0);
   const done=()=>{if(!current()){error=Error('nonword-recovery-stale');tx.abort();return;}if(--pending===0)tx.commit?.();};
   for(const [name,rows]of Object.entries(value.stores)){
    const store=tx.objectStore(name);if(store.keyPath!=='key'||store.autoIncrement){error=Error('nonword-recovery-storage-schema');tx.abort();break;}
    for(const row of rows){const get=store.get(row.key);get.onsuccess=()=>{try{
     if(!current())throw Error('nonword-recovery-stale');
     if(get.result){if(!sameRecoveryRow(get.result,row))throw Error('nonword-recovery-concurrent-conflict');existing++;done();}
     else{const added=store.add(structuredClone(row));added.onsuccess=done;restored++;}
    }catch(cause){error=cause;tx.abort();}};}
   }
   tx.oncomplete=()=>resolve({restored,existing});tx.onabort=()=>reject(error??tx.error??Error('nonword-recovery-write-aborted'));tx.onerror=()=>reject(error??tx.error??Error('nonword-recovery-write-aborted'));
  });
  for(const [name,rows]of Object.entries(value.stores))for(const row of rows){const stored=await new Promise<RecoveryRow>((resolve,reject)=>{const r=db.transaction(name).objectStore(name).get(row.key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});if(!stored||!sameRecoveryRow(stored,row))throw Error('nonword-recovery-write-receipt');}
  return result;
 }finally{db.close();}
}
