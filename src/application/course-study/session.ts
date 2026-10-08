import type {CourseEvidenceCloudPort,CourseEvidenceLocalPort,CourseLearningPort,CourseRequestJournalPort} from './ports';
import type {NonWordRuntimePort} from '../nonword-study';
import type {CourseEvidence,CourseEvidenceMutation,CourseDiagnostic,CourseSupportV2,ResolvedCourseTask} from '../../domain/course-study';
import type {CourseGradeRequest} from '../../domain/course-ai';
// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalAttemptJson} from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {courseTaskHash,courseDiagnosticHash,courseDiagnosticOutcome,attemptEvaluationForDiagnostic,chooseCourseRemediation} from '../../domain/course-study/index.ts';

type Options={runtime:NonWordRuntimePort;repository:CourseEvidenceLocalPort;support:CourseSupportV2;task:ResolvedCourseTask;
    cloud?:CourseEvidenceCloudPort|null;grade?:(request:CourseGradeRequest,requestId:string,signal?:AbortSignal)=>Promise<CourseEvidence>;
    journal:CourseRequestJournalPort;parentEvidenceHash?:string|null;now:()=>string;newId:()=>string;
    confirmCloudClaim?:()=>Promise<boolean>;
    nativeSelfAssess?:(request:CourseGradeRequest,requestId:string,status:'correct'|'partial'|'incorrect',signal?:AbortSignal)=>Promise<CourseEvidence>;
    nativeBeforeFormal?:()=>Promise<void>;
    requestKeyPrefix?:string;
    evaluationFingerprint:(evaluation:Extract<ReturnType<typeof attemptEvaluationForDiagnostic>,{status:'resolved'}>)=>Promise<string>;
};
/** Couples two already versioned stores; the original formal writer is still owned by the host. */
export async function createCourseLearningSession(options:Options):Promise<CourseLearningPort>{
    const runtime=options.runtime,first=runtime.session.snapshot();
    if(!first)throw Error('course-attempt-unavailable');
    const binding=first.binding,attemptId=first.attemptId,taskHash=await courseTaskHash(options.task);
    let record:CourseEvidence|null=null,active:Promise<CourseEvidence>|null=null;
    const same=(candidate:CourseEvidence)=>candidate.attemptId===attemptId&&candidate.taskId===options.task.taskId&&candidate.taskHash===taskHash
        &&canonicalAttemptJson(candidate.binding)===canonicalAttemptJson(binding);
    async function load(){const value=await options.repository.read(attemptId);if(value&&!same(value))throw Error('course-evidence-binding');record=value;return value;}
    function visible():CourseEvidence|null{
        const current=runtime.session.snapshot();
        if(!record||!current||!same(record))return null;
        if(!record.diagnostic)return record;
        if(!current.submitted||record.answerRevision!==current.submitted.answerRevision)return null;
        if(record.diagnostic.status==='undetermined')return current.evaluation.status==='pending'?record:null;
        return current.evaluation.status==='resolved'&&current.evaluation.evaluationHash===record.attemptEvaluationHash?record:null;
    }
    async function apply(value:CourseEvidence,signal?:AbortSignal){
        if(signal?.aborted)throw Error('course-evaluation-cancelled');
        const current=runtime.session.snapshot();
        if(!same(value)||!value.diagnostic||!current?.submitted||value.answerRevision!==current.submitted.answerRevision)throw Error('course-evaluation-binding');
        if(current.formal&&current.evaluation.status==='resolved'&&current.evaluation.evaluationHash!==value.attemptEvaluationHash)throw Error('course-formal-existing-result');
        await runtime.session.assess(courseDiagnosticOutcome(value.diagnostic));
        await runtime.afterWrite();
        await load();
        const confirmed=visible();if(!confirmed)throw Error('course-evaluation-mismatch');return confirmed;
    }
    async function write(mutation:CourseEvidenceMutation){
        const receipt=await options.repository.mutate(mutation);
        if(!receipt.durable||receipt.status==='conflict'||!receipt.evidence)throw Error('course-evidence-save-failed');
        record=receipt.evidence;return record;
    }
    async function diagnose(diagnostic:CourseDiagnostic){
        const current=runtime.session.snapshot();
        if(!current?.submitted||!record)throw Error('course-submission-required');
        const evaluation=attemptEvaluationForDiagnostic(diagnostic,binding.contentHash);
        const value=await write({schemaVersion:1,kind:'diagnose',attemptId,binding,operationId:options.newId(),expectedRevision:record.revision,updatedAt:options.now(),
            answerRevision:current.submitted.answerRevision,diagnostic,trace:null,diagnosticHash:await courseDiagnosticHash(diagnostic,null),
            attemptEvaluationHash:evaluation.status==='resolved'?await options.evaluationFingerprint(evaluation):null});
        if(options.cloud)await options.repository.synchronize(options.cloud);
        return apply(value);
    }
    async function pending(reason:'unavailable'|'cancelled'|'offline',feedback:string){
        if(record?.diagnostic&&record.diagnostic.status!=='undetermined'){
            if(reason==='cancelled')throw Error('course-evaluation-cancelled');
            return apply(record);
        }
        return diagnose({schemaVersion:1,status:'undetermined',source:'none',reason,feedback,matchedPointIds:[],missedPointIds:[],errorPointIds:[],wrongOptionIds:[],missingOptionIds:[],pointEvidence:[]});
    }
    await load();
    if(!record)await write({schemaVersion:1,kind:'bind',attemptId,binding,operationId:options.newId(),expectedRevision:0,updatedAt:options.now(),
        taskId:options.task.taskId,taskHash,parentAttemptId:first.parentAttemptId,parentEvidenceHash:options.parentEvidenceHash??null});
    if(options.cloud){
        try{
            await options.repository.synchronize(options.cloud);
            const remote=await options.cloud.read(attemptId);if(remote)await options.repository.hydrate(remote);
            await load();
        }catch(error){
            if(error instanceof Error&&/binding|conflict|mismatch/.test(error.message))throw error;
            // Input may proceed after the local bind receipt; this is not a cloud recovery claim.
        }
    }
    const restoredRecord=await load();
    if(restoredRecord?.diagnostic&&runtime.session.snapshot()?.submitted)await apply(restoredRecord);
    const evaluate=async(signal?:AbortSignal):Promise<CourseEvidence>=>{
        if(active)return active;
        const job=async()=>{
            await load();
            const original=runtime.session.snapshot();if(!original?.submitted||!record)throw Error('course-submission-required');
            if(record.diagnostic&&record.diagnostic.status!=='undetermined'){
                const result=await apply(record,signal);
                if(options.requestKeyPrefix){
                    const key=canonicalAttemptJson([options.requestKeyPrefix,'evaluate',binding,attemptId,original.submitted.answerRevision,taskHash]);
                    const id=await options.journal.request(key,options.newId);await options.journal.complete(key,id);
                }
                return result;
            }
            if(signal?.aborted)return pending('cancelled','已停止核对，原答案已保存。');
            await runtime.afterWrite();
            if(options.cloud)await runtime.synchronize?.();
            if(options.cloud){
                await options.repository.synchronize(options.cloud);
                const remote=await options.cloud.read(attemptId);if(remote)await options.repository.hydrate(remote);
                await load();
                if(record?.diagnostic&&record.diagnostic.status!=='undetermined')return apply(record,signal);
            }
            if(!options.grade)return pending('unavailable','当前核对服务不可用，原答案保留，可以稍后核对。');
            const key=canonicalAttemptJson(options.requestKeyPrefix?[options.requestKeyPrefix,'evaluate',binding,attemptId,original.submitted.answerRevision,taskHash]:[binding,attemptId,original.submitted.answerRevision,taskHash]);
            const requestId=await options.journal.request(key,options.newId);
            try{
                const value=await options.grade({schemaVersion:1,attemptId,taskId:options.task.taskId,taskHash,answerRevision:original.submitted.answerRevision,evidenceRevision:record!.revision},requestId,signal);
                if(signal?.aborted)throw Error('course-evaluation-cancelled');
                if(options.cloud)await options.repository.hydrate(value);
                await load();
                if(record?.diagnosticHash!==value.diagnosticHash)throw Error('course-evaluation-receipt-mismatch');
                const result=await apply(value,signal);
                await options.journal.complete(key,requestId);
                return result;
            }catch(error){
                if(error instanceof Error&&/binding|conflict|mismatch|existing-result/.test(error.message))throw error;
                const current=runtime.session.snapshot();
                if(current?.evaluation.status==='pending'){
                    await runtime.session.pending('offline',signal?.aborted?'已停止核对，原答案保留。':'核对尚未取得可靠回执，原答案保留。');
                    await runtime.afterWrite();
                }
                // A transport failure is not a competing diagnosis. Keep its request ID for recovery.
                throw Error(signal?.aborted?'course-evaluation-cancelled':'course-evaluation-receipt-unknown');
            }
        };
        active=job();try{return await active;}finally{active=null;}
    };
    return {task:options.task,originalAnswer:()=>runtime.session.snapshot()?.submitted?.answer??runtime.session.snapshot()?.answer??'',evidence:visible,evaluate,
        async selfAssess(status,signal){
            if(options.nativeSelfAssess){
                if(active)throw Error('course-evaluation-active');
                const job=async()=>{
                    if(signal?.aborted)throw Error('course-evaluation-cancelled');
                    await load();const current=runtime.session.snapshot();
                    if(!current?.submitted||!record)throw Error('course-submission-required');
                    const key=canonicalAttemptJson([options.requestKeyPrefix,'self-assess',status,binding,attemptId,current.submitted.answerRevision,taskHash]);
                    const id=await options.journal.request(key,options.newId);
                    const value=record.diagnostic&&record.diagnostic.status!=='undetermined'?record:await options.nativeSelfAssess!({schemaVersion:1,attemptId,taskId:options.task.taskId,taskHash,answerRevision:current.submitted.answerRevision,evidenceRevision:record.revision},id,status,signal);
                    if(signal?.aborted)throw Error('course-evaluation-cancelled');
                    await load();if(record?.diagnosticHash!==value.diagnosticHash)throw Error('course-evaluation-receipt-mismatch');
                    const result=await apply(value,signal);await options.journal.complete(key,id);return result;
                };
                active=job();try{return await active;}finally{active=null;}
            }
            const diagnostic:CourseDiagnostic={schemaVersion:1,status,source:'self-assess',feedback:status==='incorrect'?'你明确表示本次忘记了；这次保留为需要复习。':'这是你明确选择的自评，不是AI核对结论。',matchedPointIds:[],missedPointIds:[],errorPointIds:[],wrongOptionIds:[],missingOptionIds:[],pointEvidence:[]};
            return diagnose(diagnostic);
        },
        remediationTaskId:()=>record?.diagnostic?chooseCourseRemediation(options.support,record.diagnostic)?.taskId??null:null,
        async beforeFormal(){
            if(options.nativeBeforeFormal){await options.nativeBeforeFormal();return;}
            if(!options.cloud)return;
            await options.repository.synchronize(options.cloud);
            await runtime.synchronize?.();
            if(!options.confirmCloudClaim||!await options.confirmCloudClaim())throw Error('原答案与核对已保留，正式保存尚未同步，请稍后重试继续。');
        },
    };
}
