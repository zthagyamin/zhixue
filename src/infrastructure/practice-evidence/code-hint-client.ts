import type {CodeRunReportV1} from '../../domain/code-execution';
import type {PracticeEvidenceV1,PracticeEvidenceHint} from '../../domain/practice-evidence';
// @ts-expect-error TS5097: standalone Node contracts.
import {parsePracticeEvidence,evidenceEqual} from '../../domain/practice-evidence/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createCourseRequestJournal} from '../course-study/index.ts';

/** Explicit learner request only. The service reads code and references from saved originals. */
export function createAccountCodeHintClient(scope:{ownerId:string;libraryId:string},fetcher:typeof fetch=fetch){
    const journal=createCourseRequestJournal({userId:scope.ownerId,libraryId:scope.libraryId});
    return async(report:CodeRunReportV1):Promise<{hint:PracticeEvidenceHint;evidence:PracticeEvidenceV1}>=>{
        const identity=report.identity;if(!identity)throw Error('code-hint-submission-required');
        const key=JSON.stringify(['stage3-code-hint',report]);
        const requestId=await journal.request(key,()=>crypto.randomUUID());
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);
        try{
            const response=await fetcher('/api/account-study',{method:'POST',credentials:'same-origin',signal:controller.signal,
                headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'code-hint',requestId,
                    expectedUserId:scope.ownerId,libraryId:scope.libraryId,request:{schemaVersion:1,
                        attemptId:identity.attemptId,sourceVersion:identity.sourceVersion,answerRevision:identity.revision,
                        runId:report.runId,...(report.firstFailure?{caseId:report.firstFailure.caseId}:{})}})});
            const value=await response.json() as Record<string,unknown>;
            if(!response.ok)throw Error(typeof value.error==='string'?value.error:'code-hint-unavailable');
            if(value.status==='pending'){await journal.complete(key,requestId);throw Error('AI 提示暂不可用，请稍后重试。');}
            if(!['accepted','duplicate'].includes(String(value.status))||Object.keys(value).some(k=>!['status','hint','evidence'].includes(k)))throw Error('code-hint-unavailable');
            const evidence=parsePracticeEvidence(value.evidence),hint=evidence.execution?.hint;
            if(evidence.binding.ownerId!==scope.ownerId||evidence.binding.libraryId!==scope.libraryId
                ||evidence.binding.contentHash!==identity.sourceVersion||evidence.attemptId!==identity.attemptId
                ||!hint||hint.source!=='model'||hint.runId!==report.runId||hint.caseId!==report.firstFailure?.caseId
                ||!evidenceEqual(hint,value.hint))throw Error('code-hint-result-binding');
            return {hint,evidence};
        }finally{clearTimeout(timer);}
    };
}
