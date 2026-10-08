import type {MathMappingPreparationRecordV1} from '../../domain/guided-math';
import type {AccountMathOriginal} from './mapping-client';
// @ts-expect-error TS5097: standalone Node contracts.
import {validateApprovedMathRecord,validateAccountMathOriginal} from './mapping-client.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyHash,studyObject,studyId} from '../../domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {evidenceEqual} from '../../domain/practice-evidence/index.ts';
function open():Promise<IDBDatabase>{
    return new Promise((resolve,reject)=>{
        const r=indexedDB.open('zhixue-approved-math-mappings-v1',1);
        r.onupgradeneeded=()=>r.result.createObjectStore('records',{keyPath:'key'});
        r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('math-mapping-cache-blocked'));
        r.onsuccess=()=>{r.result.onversionchange=()=>r.result.close();resolve(r.result);};
    });
}
/** Called only after an authenticated preparation read; cache never manufactures approval. */
export function createMathMappingCache(scope:{ownerId:string;libraryId:string},original:AccountMathOriginal){
    studyId(scope.ownerId);studyId(scope.libraryId);
    const key=[scope.ownerId,scope.libraryId,original.snapshot.snapshotId,original.item.itemKey,original.item.contentHash];
    async function read():Promise<MathMappingPreparationRecordV1|null>{
        await validateAccountMathOriginal(original,scope);const db=await open();
        try{
            const raw=await new Promise<unknown>((resolve,reject)=>{const r=db.transaction('records').objectStore('records').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
            if(!raw)return null;
            const row=studyObject(raw,['key','record','rowHash']);
            if(!evidenceEqual(row.key,key)||row.rowHash!==await studyHash({key,record:row.record}))throw Error('math-mapping-cache-integrity');
            return validateApprovedMathRecord(row.record,original,scope);
        }finally{db.close();}
    }
    async function save(raw:MathMappingPreparationRecordV1){
        const record=await validateApprovedMathRecord(raw,original,scope),row={key,record,rowHash:await studyHash({key,record})},db=await open();
        try{await new Promise<void>((resolve,reject)=>{
            const tx=db.transaction('records','readwrite'),store=tx.objectStore('records'),get=store.get(key);let conflict=false;
            get.onsuccess=()=>{if(get.result&&!evidenceEqual(get.result,row)){conflict=true;tx.abort();}else if(!get.result)store.add(row);};
            tx.oncomplete=()=>resolve();tx.onabort=()=>reject(Error(conflict?'math-mapping-cache-conflict':'math-mapping-cache-write-aborted'));tx.onerror=()=>reject(tx.error);
        });}finally{db.close();}
        if(!evidenceEqual(await read(),record))throw Error('math-mapping-cache-receipt-binding');
        return {durable:true as const};
    }
    return {read,save};
}
