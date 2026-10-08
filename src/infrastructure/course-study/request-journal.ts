import type {CourseRequestJournalPort} from '../../application/course-study';
// @ts-expect-error TS5097: standalone Node contracts.
import {attemptId} from '../../domain/learning-attempt/index.ts';

/** Transport identities only. No answer, model secret or grading evidence. */
export function createCourseRequestJournal(scope:{userId:string;libraryId:string}):CourseRequestJournalPort{
    attemptId(scope.userId);attemptId(scope.libraryId);
    const open=()=>new Promise<IDBDatabase>((resolve,reject)=>{
        const request=indexedDB.open('zhixue-course-requests-v1',1);
        request.onupgradeneeded=()=>request.result.createObjectStore('requests',{keyPath:'key'});
        request.onerror=()=>reject(request.error);request.onblocked=()=>reject(Error('course-request-local-blocked'));
        request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};
    });
    async function transact(key:string,change:(old:{key:string[];requestId:string}|undefined)=>{key:string[];requestId:string}|null){
        const db=await open(),full=[scope.userId,scope.libraryId,key];
        try{return await new Promise<string|undefined>((resolve,reject)=>{
            const tx=db.transaction('requests','readwrite'),store=tx.objectStore('requests'),get=store.get(full);let value:string|undefined;
            get.onsuccess=()=>{try{const next=change(get.result);if(next){store.put(next);value=next.requestId;}else store.delete(full);}catch(error){tx.abort();reject(error);}};
            tx.oncomplete=()=>resolve(value);tx.onabort=()=>reject(tx.error??Error('course-request-save-failed'));tx.onerror=()=>reject(tx.error);
        });}finally{db.close();}
    }
    return {request:async(key,makeId)=>(await transact(key,old=>old??{key:[scope.userId,scope.libraryId,key],requestId:attemptId(makeId())}))!,
        complete:async(key,id)=>{await transact(key,old=>old?.requestId===id?null:old??null);}};
}
