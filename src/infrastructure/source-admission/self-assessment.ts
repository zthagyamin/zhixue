import type {LearningAttempt} from '../../domain/learning-attempt';
import type {SourceLocalSelfAssessment} from '../../domain/source-admission';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseAttemptBinding} from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {sourceAdmissionFields,sourceAdmissionId,sourceAdmissionTime,sourceSelfRating,sameSourceAdmission} from '../../domain/source-admission/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {sourceAdmissionFingerprint} from './fingerprint.ts';

type Row={key:string[];selfAssessment:SourceLocalSelfAssessment;recordHash:string};
function open():Promise<IDBDatabase>{
    if(typeof indexedDB==='undefined')return Promise.reject(Error('source-self-assessment-storage-unavailable'));
    return new Promise((resolve,reject)=>{
        const request=indexedDB.open('zhixue-source-self-assessments-v1',1);
        request.onupgradeneeded=()=>request.result.createObjectStore('records',{keyPath:'key'});
        request.onerror=()=>reject(request.error);
        request.onblocked=()=>reject(Error('source-self-assessment-storage-blocked'));
        request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};
    });
}
function result<T>(request:IDBRequest<T>):Promise<T>{
    return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
}
function complete(tx:IDBTransaction):Promise<void>{
    return new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error??Error('source-self-assessment-save-failed'));tx.onerror=()=>reject(tx.error);});
}
function parse(raw:unknown):SourceLocalSelfAssessment{
    const value=sourceAdmissionFields(raw,['schemaVersion','attemptId','binding','answerRevision','submittedAt','rating']);
    if(value.schemaVersion!==1||!Number.isSafeInteger(value.answerRevision)||Number(value.answerRevision)<0)
        throw Error('source-self-assessment-record-invalid');
    sourceAdmissionId(value.attemptId);sourceAdmissionTime(value.submittedAt);sourceSelfRating(value.rating);
    value.binding=parseAttemptBinding(value.binding);return value as SourceLocalSelfAssessment;
}
/** Independent first declaration; view checkpoints cannot overwrite it. No grades or model port. */
export function createSourceSelfAssessmentRepository(scope:{ownerId:string;libraryId:string}){
    const owner=[sourceAdmissionId(scope.ownerId),sourceAdmissionId(scope.libraryId)];
    const key=(id:string)=>[...owner,sourceAdmissionId(id)];
    function original(attempt:LearningAttempt,rating:SourceLocalSelfAssessment['rating']):SourceLocalSelfAssessment{
        if(!attempt.submitted||attempt.binding.ownerId!==owner[0]||attempt.binding.libraryId!==owner[1])
            throw Error('source-self-assessment-scope');
        return parse({schemaVersion:1,attemptId:attempt.attemptId,binding:attempt.binding,
            answerRevision:attempt.submitted.answerRevision,submittedAt:attempt.submitted.submittedAt,rating});
    }
    async function verify(raw:unknown,attempt:LearningAttempt):Promise<SourceLocalSelfAssessment>{
        const row=sourceAdmissionFields(raw,['key','selfAssessment','recordHash']),record=parse(row.selfAssessment);
        if(!sameSourceAdmission(row.key,key(attempt.attemptId))||!sameSourceAdmission(record,original(attempt,record.rating))
            ||row.recordHash!==await sourceAdmissionFingerprint(record))throw Error('source-self-assessment-integrity');
        return record;
    }
    async function read(attempt:LearningAttempt):Promise<SourceLocalSelfAssessment|null>{
        if(!attempt.submitted)return null;
        original(attempt,'again');const db=await open();
        try{const row=await result(db.transaction('records').objectStore('records').get(key(attempt.attemptId)));
            return row?await verify(row,attempt):null;
        }finally{db.close();}
    }
    async function save(attempt:LearningAttempt,rating:SourceLocalSelfAssessment['rating']):Promise<SourceLocalSelfAssessment>{
        const record=original(attempt,rating),recordHash=await sourceAdmissionFingerprint(record),db=await open();
        let existing:Row|undefined;
        try{
            const tx=db.transaction('records','readwrite'),done=complete(tx),store=tx.objectStore('records');
            const request=store.get(key(attempt.attemptId));
            request.onsuccess=()=>{existing=request.result;if(!existing)store.add({key:key(attempt.attemptId),selfAssessment:record,recordHash});};
            await done;
            return existing?await verify(existing,attempt):record;
        }finally{db.close();}
    }
    return {read,save};
}
