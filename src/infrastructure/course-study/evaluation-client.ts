import type {CourseGradeRequest} from '../../domain/course-ai';
import type {CourseEvidence} from '../../domain/course-study';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseCourseEvidence} from '../../domain/course-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {attemptId} from '../../domain/learning-attempt/index.ts';

export function createAccountCourseGradeClient(options:{ownerId:string;libraryId:string;fetcher?:typeof fetch}){
    attemptId(options.ownerId);attemptId(options.libraryId);
    return async(request:CourseGradeRequest,requestId:string,signal?:AbortSignal):Promise<CourseEvidence>=>{
        const controller=new AbortController(),abort=()=>controller.abort();
        if(signal?.aborted)throw Error('course-evaluation-cancelled');
        signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,45000);
        try{
            const response=await (options.fetcher??fetch)('/api/account-study',{method:'POST',credentials:'same-origin',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'course-grade',expectedUserId:options.ownerId,libraryId:options.libraryId,requestId,request})});
            const body=await response.json() as {error?:string;evidence?:unknown};
            if(!response.ok)throw Error(body.error==='unsupported-action'?'course-evidence-unsupported':body.error??'course-evaluation-unavailable');
            const record=parseCourseEvidence(body.evidence);
            if(record.attemptId!==request.attemptId||record.taskId!==request.taskId||record.taskHash!==request.taskHash||record.answerRevision!==request.answerRevision
                ||record.binding.ownerId!==options.ownerId||record.binding.libraryId!==options.libraryId)throw Error('course-evaluation-reply-binding');
            return record;
        }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
    };
}
