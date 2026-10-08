import type {MathStudyRequestV1,MathStudyResultV1} from '../../application/math-study';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseMathStudyRequest,parseMathStudyResult} from '../../application/math-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createCourseRequestJournal} from '../course-study/index.ts';

/** Request references only; saved answers and authoritative references remain on the service. */
export function createAccountMathClient(scope:{ownerId:string;libraryId:string},fetcher:typeof fetch=fetch){
    const journal=createCourseRequestJournal({userId:scope.ownerId,libraryId:scope.libraryId});
    return async(raw:MathStudyRequestV1,signal?:AbortSignal):Promise<MathStudyResultV1>=>{
        const request=parseMathStudyRequest(raw),key=JSON.stringify(['stage3-math',request]);
        const requestId=await journal.request(key,()=>crypto.randomUUID());
        const controller=new AbortController(),cancel=()=>controller.abort();
        signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
        const timer=setTimeout(cancel,60000);
        try{
            const response=await fetcher('/api/account-study',{method:'POST',credentials:'same-origin',signal:controller.signal,
                headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'math-evaluate',requestId,request,
                    expectedUserId:scope.ownerId,libraryId:scope.libraryId})});
            const rawResult=await response.json() as Record<string,unknown>;
            if(!response.ok)throw Error(typeof rawResult?.error==='string'?rawResult.error:'math-service-unavailable');
            const result=parseMathStudyResult(rawResult,request);
            if(controller.signal.aborted)throw Error('math-evaluation-cancelled');
            if(result.step?.status==='undetermined')await journal.complete(key,requestId);
            return result;
        }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}
    };
}
