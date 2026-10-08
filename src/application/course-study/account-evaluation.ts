import type {AccountContext,AccountReply,StudyScope} from '../account-study';
import type {CourseEvidenceStorePort} from './ports';
import type {CourseDiagnostic,CourseEvidence,CourseEvidenceMutation,CourseEvaluationTrace} from '../../domain/course-study';
import type {CourseGradeRequest} from '../../domain/course-ai';
// @ts-expect-error TS5097: standalone Node contracts.
import {AccountFailure} from '../../domain/account-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject,studyId,studyHash} from '../../domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseCourseGradeRequest,courseEvaluationTrace} from '../../domain/course-ai/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {resolveCourseTask,courseTaskHash,courseDiagnosticHash,deterministicCourseDiagnostic,validateCourseDiagnostic,attemptEvaluationForDiagnostic,parseCourseEvidenceMutation} from '../../domain/course-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {courseEvidenceOriginal} from './original.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalAttemptJson} from '../../domain/learning-attempt/index.ts';

type Diagnose=Extract<CourseEvidenceMutation,{kind:'diagnose'}>;
function reply(evidence:CourseEvidence,status='accepted'):AccountReply{return {kind:'value',status:200,value:{status,evidence}};}
/** Reads the already submitted answer. No caller-supplied references or official grade writer. */
export async function evaluateAccountCourse(body:Record<string,unknown>,scope:StudyScope,context:AccountContext,store:CourseEvidenceStorePort,signal:AbortSignal):Promise<AccountReply>{
    let request:CourseGradeRequest,clientRequestId:string;
    try{studyObject(body,['action','requestId','request'],['libraryId']);studyId(body.requestId,'course-request');clientRequestId=body.requestId as string;request=parseCourseGradeRequest(body.request);}
    catch{throw new AccountFailure(400,'invalid-course-grade-request');}
    if(signal.aborted)throw new AccountFailure(409,'course-evaluation-cancelled');
    const attempts=await context.deps.getAttemptStore?.();
    if(!attempts||!await attempts.supported())throw new AccountFailure(409,'learning-attempts-unsupported');
    const attempt=await attempts.read(scope,request.attemptId),evidence=await store.read(scope,request.attemptId);
    if(!attempt?.submitted||!evidence)throw new AccountFailure(409,'course-submission-required');
    const b=attempt.binding;
    if(b.ownerId!==scope.userId||b.libraryId!==scope.libraryId||evidence.attemptId!==attempt.attemptId
        ||canonicalAttemptJson(evidence.binding)!==canonicalAttemptJson(b))throw new AccountFailure(403,'course-evidence-scope-mismatch');
    if(request.answerRevision!==attempt.submitted.answerRevision||request.taskId!==evidence.taskId||request.taskHash!==evidence.taskHash)
        throw new AccountFailure(409,'course-evaluation-binding');
    const item=await courseEvidenceOriginal(await context.deps.getStudyStore(),attempts).readItem(scope,b);
    if(!item)throw new AccountFailure(409,'course-original-unavailable');
    const task=resolveCourseTask(item,evidence.taskId);
    if(await courseTaskHash(task)!==evidence.taskHash)throw new AccountFailure(409,'course-task-changed');
    if(evidence.diagnostic&&evidence.diagnostic.status!=='undetermined')return reply(evidence,'duplicate');
    if(attempt.formal)throw new AccountFailure(409,'course-formal-existing-result');
    if(request.evidenceRevision!==evidence.revision)throw new AccountFailure(409,'course-evidence-revision');
    const answer=attempt.submitted.answer;
    async function prepare(diagnostic:CourseDiagnostic,trace:CourseEvaluationTrace|null,key:string):Promise<Diagnose>{
        validateCourseDiagnostic(diagnostic,task,answer);
        const diagnosticHash=await courseDiagnosticHash(diagnostic,trace),evaluation=attemptEvaluationForDiagnostic(diagnostic,b.contentHash);
        if(evaluation.status==='resolved'&&!context.deps.fingerprintCourseEvaluation)throw new AccountFailure(409,'course-evaluation-unsupported');
        const attemptEvaluationHash=evaluation.status==='resolved'?await context.deps.fingerprintCourseEvaluation!(evaluation):null;
        return {schemaVersion:1,kind:'diagnose',attemptId:attempt!.attemptId,binding:b,operationId:`ce:${await studyHash([key,diagnosticHash])}`,
            expectedRevision:evidence!.revision,updatedAt:context.deps.now().toISOString(),answerRevision:request.answerRevision,diagnostic,trace,diagnosticHash,attemptEvaluationHash};
    }
    async function save(raw:Diagnose):Promise<AccountReply>{
        let mutation=parseCourseEvidenceMutation(raw);
        if(mutation.kind!=='diagnose'||mutation.attemptId!==attempt!.attemptId||mutation.answerRevision!==request.answerRevision
            ||canonicalAttemptJson(mutation.binding)!==canonicalAttemptJson(b)
            ||await courseDiagnosticHash(mutation.diagnostic,mutation.trace)!==mutation.diagnosticHash)throw new AccountFailure(409,'course-evaluation-result-binding');
        const current=await store.read(scope,attempt!.attemptId);
        if(current?.diagnosticHash===mutation.diagnosticHash&&current.answerRevision===mutation.answerRevision)return reply(current,'duplicate');
        if(current&&current.revision!==mutation.expectedRevision){
            if(current.taskId!==request.taskId||current.taskHash!==request.taskHash||canonicalAttemptJson(current.binding)!==canonicalAttemptJson(b)
                ||current.answerRevision!==null&&current.answerRevision!==mutation.answerRevision
                ||current.diagnostic&&current.diagnostic.status!=='undetermined')throw new AccountFailure(409,'course-evidence-conflict');
            mutation={...mutation,operationId:`ce-recover:${await studyHash([mutation.operationId,current.revision,mutation.diagnosticHash])}`,
                expectedRevision:current.revision,updatedAt:[context.deps.now().toISOString(),current.updatedAt].sort().at(-1)!};
        }
        const receipt=mutation.diagnostic.source==='model'?await store.writeModel(scope,mutation):await store.mutate(scope,mutation);
        if(!receipt.durable||!receipt.evidence||receipt.status==='conflict')throw new AccountFailure(409,'course-evidence-conflict');
        return reply(receipt.evidence,receipt.status);
    }
    if(task.mode==='quiz')return save(await prepare(deterministicCourseDiagnostic(task,answer),null,clientRequestId));
    async function pending(reason:'unavailable'|'cancelled'|'invalid-result'){
        return save(await prepare({schemaVersion:1,status:'undetermined',source:'none',reason,
            feedback:reason==='cancelled'?'已停止核对，原答案保留。':reason==='invalid-result'?'AI回复缺少可靠核对依据，原答案保留。':'AI暂不可用，原答案已保留，等待核对。',
            matchedPointIds:[],missedPointIds:[],errorPointIds:[],wrongOptionIds:[],missingOptionIds:[],pointEvidence:[]},null,clientRequestId));
    }
    if(!context.deps.getCourseAi)return pending('unavailable');
    const aiStore=await context.deps.getAiStore(),settings=await aiStore.getSettings(scope);
    const modelId=settings.model||(settings.provider==='deepseek'?context.deps.getCourseAiTrace?.().modelId??'':'');
    const trace={...courseEvaluationTrace(modelId),operationKind:'question',provider:settings.provider};
    const logical={attemptId:request.attemptId,taskId:request.taskId,taskHash:request.taskHash,answerRevision:request.answerRevision};
    const inputHash=await studyHash({request:logical,answer,provider:settings.provider,model:modelId,baseUrl:settings.baseUrl});
    const requestId=`ai:${await studyHash([clientRequestId,settings.provider,modelId,settings.baseUrl])}`;
    const reservedTokens=new TextEncoder().encode(JSON.stringify([task,answer])).byteLength+settings.maxOutputTokens;
    const day=new Date(context.deps.now().getTime()+8*3600000).toISOString().slice(0,10);
    let reservation;
    try{reservation=await aiStore.begin(scope,{requestId,day,inputHash,reservedTokens,expectedRevision:settings.revision,trace});}
    catch{return pending('unavailable');}
    if(reservation.status==='completed'){
        const prepared=studyObject(reservation.result,['schemaVersion','attemptId','taskId','taskHash','answerRevision','mutation']);
        if(prepared.schemaVersion!==1||prepared.attemptId!==request.attemptId||prepared.taskId!==request.taskId
            ||prepared.taskHash!==request.taskHash||prepared.answerRevision!==request.answerRevision)throw new AccountFailure(409,'course-evaluation-result-binding');
        const mutation=parseCourseEvidenceMutation(prepared.mutation);
        if(mutation.kind!=='diagnose'||mutation.diagnostic.source!=='model')throw new AccountFailure(409,'course-evaluation-result-binding');
        return save(mutation);
    }
    if(reservation.status==='pending')throw new AccountFailure(409,'ai-request-pending');
    if(reservation.status==='failed')return pending('unavailable');
    let completed=false,prepared:Diagnose|null=null;
    try{
        const result=await (await context.deps.getCourseAi(scope,settings.revision)).run({...request,requestId},task,answer,{maxOutputTokens:reservation.settings.maxOutputTokens},signal);
        if(result.trace.requestId!==requestId||result.trace.promptVersion!==trace.promptVersion||result.trace.ruleVersion!==trace.ruleVersion
            ||result.trace.modelId!==modelId)throw Error('course-ai-output-invalid');
        prepared=await prepare(result.diagnostic,result.trace,requestId);
        await aiStore.complete(scope,requestId,inputHash,{schemaVersion:1,attemptId:request.attemptId,taskId:request.taskId,taskHash:request.taskHash,answerRevision:request.answerRevision,mutation:prepared},result.usageTokens??reservedTokens);
        completed=true;
        return await save(prepared);
    }catch(error){
        if(completed||prepared)throw new AccountFailure(503,'course-evidence-receipt-unknown');
        const code=error instanceof Error&&/^[a-z0-9-]+$/.test(error.message)?error.message:'course-ai-provider-error';
        await aiStore.fail(scope,requestId,inputHash,code);
        return pending(signal.aborted?'cancelled':code==='course-ai-output-invalid'?'invalid-result':'unavailable');
    }
}
