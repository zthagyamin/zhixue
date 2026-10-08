import type {NativeMathCapture,NativeMathMappingRecord} from '../../domain/math-study';
// @ts-expect-error TS5097: standalone Node contracts.
import {validateNativeMathMappingRecord,parseNativeMathCapture} from '../../domain/math-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyHash,studyObject,studyId} from '../../domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {evidenceEqual} from '../../domain/practice-evidence/index.ts';
function open():Promise<IDBDatabase>{
    if(typeof indexedDB==='undefined')return Promise.reject(Error('native-math-mapping-cache-unavailable'));
    return new Promise((resolve,reject)=>{
        const r=indexedDB.open('zhixue-native-math-mappings-v1',1);r.onupgradeneeded=()=>r.result.createObjectStore('records',{keyPath:'key'});
        r.onerror=()=>reject(r.error);r.onblocked=()=>reject(Error('native-math-mapping-cache-blocked'));
        r.onsuccess=()=>{r.result.onversionchange=()=>r.result.close();resolve(r.result);};
    });
}
/** Scoped immutable mapping cache. Source/attempt links are checked separately by the host. */
export function createNativeMathMappingCache(scope:{ownerId:string;libraryId:string},capture:NativeMathCapture){
    studyId(scope.ownerId);studyId(scope.libraryId);const key=[scope.ownerId,scope.libraryId,capture.captureId];
    const original=async()=>{const parsed=await parseNativeMathCapture(capture);if(parsed.identity.libraryId!==scope.libraryId)throw Error('native-math-mapping-cache-source-binding');return parsed;};
    async function read():Promise<NativeMathMappingRecord|null>{
        await original();const db=await open();
        try{
            const raw=await new Promise<unknown>((resolve,reject)=>{const r=db.transaction('records').objectStore('records').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
            if(!raw)return null;const row=studyObject(raw,['key','record','rowHash']);
            if(!evidenceEqual(row.key,key)||row.rowHash!==await studyHash({key,record:row.record}))throw Error('native-math-mapping-cache-integrity');
            return validateNativeMathMappingRecord(row.record,capture);
        }finally{db.close();}
    }
    async function save(raw:NativeMathMappingRecord){
        await original();const record=await validateNativeMathMappingRecord(raw,capture),row={key,record,rowHash:await studyHash({key,record})},db=await open();
        try{await new Promise<void>((resolve,reject)=>{
            const tx=db.transaction('records','readwrite'),store=tx.objectStore('records'),get=store.get(key);let conflict=false;
            get.onsuccess=()=>{if(get.result&&!evidenceEqual(get.result,row)){conflict=true;tx.abort();}else if(!get.result)store.add(row);};
            tx.oncomplete=()=>resolve();tx.onabort=()=>reject(Error(conflict?'native-math-mapping-cache-conflict':'native-math-mapping-cache-write-aborted'));tx.onerror=()=>reject(tx.error);
        });}finally{db.close();}
        if(!evidenceEqual(await read(),record))throw Error('native-math-mapping-cache-receipt-binding');return {durable:true as const};
    }
    return {read,save};
}
