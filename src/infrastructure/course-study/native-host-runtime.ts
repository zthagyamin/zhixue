import type {NonWordHostScope, NonWordRuntimePort} from '../../application/nonword-study';
import type {NativeCourseTransport, CourseLearningPort} from '../../application/course-study';
import type {NonWordRuntime} from '../nonword-study';
import type {NativeCourseIdentity, NativeCourseItem, NativeCourseCapture, NativeGradeRequest, CourseEvidence} from '../../domain/course-study';
import type {CourseGradeRequest} from '../../domain/course-ai';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseNativeCourseIdentity, parseNativeCourseCapture, assertNativeCaptureBinding, resolveCourseSupportV2, resolveCourseTask, courseTaskHash, chooseCourseRemediation, validateNativeGradeReceipt, parseNativeGradeRequest, parseNativeClaimRequest, validateNativeClaimReceipt, courseDiagnosticHash, validateCourseDiagnostic, attemptEvaluationForDiagnostic} from '../../domain/course-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalAttemptJson} from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createCourseLearningSession} from '../../application/course-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createLocalAttemptRepository, evaluationFingerprint} from '../learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createNativeCourseSourceCache} from './native-source-cache.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createLocalCourseEvidenceRepository} from './evidence-local.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createCourseRequestJournal} from './request-journal.ts';

type NativeScope = NonWordHostScope & {nativeCourseIdentity?:NativeCourseIdentity; nativeCoursePresentation?:NativeCourseItem; nativeCourseCapture?:NativeCourseCapture};
const same = (a:unknown,b:unknown) => canonicalAttemptJson(a)===canonicalAttemptJson(b);
function sourceMatches(scope:NonWordHostScope,identity:NativeCourseIdentity):boolean {
    return scope.snapshotId==='local'&&scope.libraryId===identity.libraryId&&scope.itemKey===identity.itemKey&&scope.contentHash===identity.contentHash;
}
/** Capture is authoritative; display metadata is sufficient only for saving an ungraded answer. */
export async function nativeCourseTask(scope:NativeScope,purpose:string,parentId?:string,requestedTaskId?:string,transport?:NativeCourseTransport){
    if(scope.cloud||!scope.nativeCourseIdentity)return null;
    const identity=parseNativeCourseIdentity(scope.nativeCourseIdentity);
    if(!sourceMatches(scope,identity))throw Error('native-course-source-binding');
    const storage={userId:scope.ownerId,libraryId:scope.libraryId},cache=createNativeCourseSourceCache(storage);
    let capture:NativeCourseCapture|null=null,parentEvidenceHash:string|null=null,selected=requestedTaskId;
    if(parentId){
        if(purpose!=='remediation')throw Error('course-parent-purpose-binding');
        const attempts=createLocalAttemptRepository(storage),parentAttempt=await attempts.read(parentId);
        if(!parentAttempt||parentAttempt.binding.ownerId!==scope.ownerId||!sourceMatches(scope,{...identity,...parentAttempt.binding}))throw Error('course-parent-source-binding');
        capture=await cache.read(parentAttempt.binding,parentId);
        if(!capture||!same(capture.identity,identity))throw Error('course-parent-native-capture-required');
        const repository=createLocalCourseEvidenceRepository(storage,{cloud:false,readAttempt:id=>attempts.read(id),readItem:async()=>capture!.item,readNativeCapture:(binding,id)=>cache.read(binding,id)});
        const parent=await repository.read(parentId);
        if(!parent?.diagnostic||parent.diagnostic.status==='undetermined'||!parent.diagnosticHash||parentAttempt.evaluation.status!=='resolved'
            ||parent.attemptEvaluationHash!==parentAttempt.evaluation.evaluationHash||!same(parent.binding,parentAttempt.binding))throw Error('course-parent-evidence-required');
        const task=resolveCourseTask(capture.item,parent.taskId);
        if(!parentAttempt.submitted||parent.answerRevision!==parentAttempt.submitted.answerRevision)throw Error('course-parent-evidence-binding');
        validateCourseDiagnostic(parent.diagnostic,task,parentAttempt.submitted.answer);
        const evaluation=attemptEvaluationForDiagnostic(parent.diagnostic,parentAttempt.binding.contentHash);
        if(parent.taskHash!==await courseTaskHash(task)||parent.diagnosticHash!==await courseDiagnosticHash(parent.diagnostic,parent.trace)
            ||evaluation.status!=='resolved'||await evaluationFingerprint(evaluation)!==parentAttempt.evaluation.evaluationHash)throw Error('course-parent-evidence-binding');
        const target=chooseCourseRemediation(resolveCourseSupportV2(capture.item),parent.diagnostic)?.taskId??parent.taskId;
        if(selected&&selected!==target)throw Error('course-remediation-binding');
        selected=target;parentEvidenceHash=parent.diagnosticHash;
    }else{
        if(scope.nativeCourseCapture){
            capture=await parseNativeCourseCapture(scope.nativeCourseCapture);
            if(!same(capture.identity,identity))throw Error('native-course-source-binding');
            await cache.save(capture);
        }else capture=await cache.byIdentity(identity);
        if(!capture&&transport?.supported()){
            try{
                capture=await parseNativeCourseCapture(await transport.capture(identity));
                if(!same(capture.identity,identity))throw Error('native-course-source-binding');
                await cache.save(capture);
            }catch(error){
                if(error instanceof Error&&/binding|integrity|conflict/.test(error.message))throw error;
                capture=null;
            }
        }
    }
    const item=capture?.item??scope.nativeCoursePresentation;
    if(!item||item.itemKey!==identity.itemKey||item.contentHash!==identity.contentHash)return null;
    let support;
    try{support=resolveCourseSupportV2(item);}catch(error){if(capture)throw error;return null;}
    if(!parentId&&selected&&selected!==support.task.taskId)throw Error('course-original-task-binding');
    return {identity,capture,item,support,task:resolveCourseTask(item,selected),parentEvidenceHash,cache};
}

type RuntimeDriver={runtime:NonWordRuntimePort;restore:()=>Record<string,unknown>;fields:(values:Record<string,unknown>)=>Record<string,string>;answer:(values:Record<string,unknown>)=>string;phase:()=> 'answering'|'submitted'|'feedback'|'lesson'};
type Prepared=NonNullable<Awaited<ReturnType<typeof nativeCourseTask>>>;

/** Attaches to the actual V1 runtime after its group and round hashes have been fixed. */
export async function attachNativeCourseDriver<T extends RuntimeDriver>(driver:T,runtime:NonWordRuntime,prepared:Prepared,transport?:NativeCourseTransport){
    const scope=runtime.scope,attempt=runtime.session.snapshot();
    if(!attempt||scope.cloud||!sourceMatches(scope,prepared.identity))throw Error('native-course-attempt-source-binding');
    const capture=prepared.capture;
    let course:CourseLearningPort;
    if(!capture){
        course={task:prepared.task,originalAnswer:()=>runtime.session.snapshot()?.submitted?.answer??runtime.session.snapshot()?.answer??'',
            evidence:()=>null,evaluate:async()=>{throw Error('native-course-unsupported');},remediationTaskId:()=>null,
            beforeFormal:async()=>{throw Error('native-course-source-capture-required');}};
    }else{
        assertNativeCaptureBinding(capture,attempt.binding);
        await prepared.cache.bindAttempt(attempt.attemptId,attempt.binding,capture.captureId);
        const repository=createLocalCourseEvidenceRepository({userId:scope.ownerId,libraryId:scope.libraryId},{cloud:false,
            readAttempt:id=>runtime.repository.read(id),readItem:async()=>capture.item,readNativeCapture:(binding,id)=>prepared.cache.read(binding,id)});
        const grade=async(request:CourseGradeRequest,requestId:string,action:NativeGradeRequest['action'],signal?:AbortSignal,selfStatus?:'correct'|'partial'|'incorrect'):Promise<CourseEvidence>=>{
            if(signal?.aborted)throw Error('course-evaluation-cancelled');
            if(!transport?.supported())throw Error('native-course-unsupported');
            const saved=await runtime.repository.read(attempt.attemptId),record=await repository.read(attempt.attemptId);
            if(!saved?.submitted||!record||saved.checkpoint.purpose!==runtime.purpose||!same(saved.binding,attempt.binding)||request.attemptId!==saved.attemptId
                ||request.answerRevision!==saved.submitted.answerRevision||request.evidenceRevision!==record.revision
                ||request.taskId!==prepared.task.taskId||request.taskHash!==record.taskHash)throw Error('native-course-submission-binding');
            const nativeRequest=parseNativeGradeRequest({schemaVersion:1,action,requestId,binding:saved.binding,identity:prepared.identity,
                captureId:capture.captureId,attemptId:saved.attemptId,purpose:runtime.purpose,parentAttemptId:saved.parentAttemptId,
                parentDiagnosticHash:prepared.parentEvidenceHash,taskId:request.taskId,taskHash:request.taskHash,submission:saved.submitted,
                ...(action==='self-assess'?{selfStatus}:{})});
            const receipt=await validateNativeGradeReceipt(await transport.grade(nativeRequest,signal),nativeRequest,capture);
            if(signal?.aborted)throw Error('course-evaluation-cancelled');
            const current=await runtime.repository.read(saved.attemptId);
            if(!current?.submitted||!same(current.binding,saved.binding)||!same(current.submitted,saved.submitted))throw Error('native-course-submission-binding');
            const existing=await repository.read(saved.attemptId);
            if(!existing)throw Error('course-evidence-not-bound');
            const matches=(value:CourseEvidence|null)=>Boolean(value&&same(value.binding,saved.binding)&&value.taskId===receipt.taskId
                &&value.taskHash===receipt.taskHash&&value.answerRevision===receipt.answerRevision&&value.diagnosticHash===receipt.diagnosticHash
                &&value.attemptEvaluationHash===receipt.attemptEvaluationHash&&same(value.diagnostic,receipt.diagnostic)&&same(value.trace,receipt.trace));
            if(existing.diagnostic&&existing.diagnostic.status!=='undetermined'){
                if(!matches(existing))throw Error('course-formal-existing-result');
                return existing;
            }
            const mutation={schemaVersion:1 as const,kind:'diagnose' as const,attemptId:saved.attemptId,binding:saved.binding,
                operationId:`native:${receipt.receiptHash}`,expectedRevision:existing.revision,updatedAt:new Date().toISOString(),
                answerRevision:receipt.answerRevision,diagnostic:receipt.diagnostic,trace:receipt.trace,diagnosticHash:receipt.diagnosticHash,
                attemptEvaluationHash:receipt.attemptEvaluationHash};
            try{
                const persisted=await repository.mutate(mutation);
                if(!persisted.durable||persisted.status==='conflict'||!matches(persisted.evidence))throw Error('course-evidence-save-failed');
            }catch(error){
                const recovered=await repository.read(saved.attemptId);
                if(!matches(recovered))throw error;
            }
            const confirmed=await repository.read(saved.attemptId);
            if(!matches(confirmed))throw Error('course-evaluation-receipt-mismatch');
            return confirmed!;
        };
        course=await createCourseLearningSession({runtime,repository,support:prepared.support,task:prepared.task,parentEvidenceHash:prepared.parentEvidenceHash,
            grade:(request,id,signal)=>grade(request,id,'evaluate',signal),nativeSelfAssess:(request,id,status,signal)=>grade(request,id,'self-assess',signal,status),
            journal:createCourseRequestJournal({userId:scope.ownerId,libraryId:scope.libraryId}),requestKeyPrefix:canonicalAttemptJson(['native-course-v1',prepared.identity,capture.captureId,prepared.parentEvidenceHash]),
            now:()=>new Date().toISOString(),newId:()=>crypto.randomUUID(),evaluationFingerprint,
            nativeBeforeFormal:async()=>{
                const saved=await runtime.repository.read(attempt.attemptId),local=runtime.session.snapshot(),evidence=await repository.read(attempt.attemptId);
                if(runtime.purpose!=='first'||saved?.parentAttemptId||!saved?.formal||!saved.submitted||saved.evaluation.status!=='resolved'
                    ||!local||!same(saved,local)||!evidence?.diagnostic||evidence.diagnostic.status==='undetermined'
                    ||!same(evidence.binding,saved.binding)||evidence.answerRevision!==saved.submitted.answerRevision
                    ||evidence.taskId!==prepared.task.taskId||evidence.attemptEvaluationHash!==saved.evaluation.evaluationHash
                    ||saved.formal.evaluationHash!==saved.evaluation.evaluationHash)throw Error('native-course-formal-evidence-required');
                validateCourseDiagnostic(evidence.diagnostic,prepared.task,saved.submitted.answer);
                const evaluation=attemptEvaluationForDiagnostic(evidence.diagnostic,saved.binding.contentHash);
                if(evidence.taskHash!==await courseTaskHash(prepared.task)||evidence.diagnosticHash!==await courseDiagnosticHash(evidence.diagnostic,evidence.trace)||evaluation.status!=='resolved'
                    ||await evaluationFingerprint(evaluation)!==saved.evaluation.evaluationHash)throw Error('native-course-formal-evidence-binding');
                if(!transport?.supported())throw Error('native-course-unsupported');
                const request=parseNativeClaimRequest({schemaVersion:1,binding:saved.binding,identity:prepared.identity,captureId:capture.captureId,
                    attemptId:saved.attemptId,diagnosticHash:evidence.diagnosticHash,attemptEvaluationHash:saved.evaluation.evaluationHash,
                    eventId:saved.formal.eventId,occurredAt:saved.formal.occurredAt,rating:saved.formal.rating});
                await validateNativeClaimReceipt(await transport.claim(request),request);
            }});
    }
    const answer=(values:Record<string,unknown>)=>prepared.task.mode==='quiz'?JSON.stringify(values.courseSelection??[]):String(values.answer??'');
    return {...driver,course,answer,fields:(values:Record<string,unknown>)=>({answer:answer(values)}),restore:()=>{
        const saved=runtime.session.snapshot()!,raw=saved.submitted?.answer??saved.answer;
        let selection:string[]=[];try{const value=JSON.parse(raw);if(Array.isArray(value)&&value.every(id=>typeof id==='string'))selection=value;}catch{/* Recall answers are text. */}
        return {answer:prepared.task.mode==='recall'?raw:'',courseSelection:selection};
    },phase:()=>runtime.session.snapshot()?.evaluation.status==='resolved'?'feedback':runtime.session.snapshot()?.submitted?'submitted':'answering'};
}
