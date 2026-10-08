import type {NonWordHostScope,NonWordRuntimePort} from '../../application/nonword-study';
import type {NonWordRuntime} from '../nonword-study';
// @ts-expect-error TS5097: standalone Node contracts.
import {resolveCourseSupportV2,resolveCourseTask,chooseCourseRemediation} from '../../domain/course-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createCourseLearningSession} from '../../application/course-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createLocalAttemptRepository,evaluationFingerprint} from '../learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createLocalCourseEvidenceRepository} from './evidence-local.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createAccountCourseEvidenceClient} from './evidence-client.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createCourseRequestJournal} from './request-journal.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createAccountCourseGradeClient} from './evaluation-client.ts';

export async function portableCourseTask(scope:NonWordHostScope,purpose:string,parentId?:string,requestedTaskId?:string){
    const reference=scope.courseReference;if(!scope.cloud||!reference)return null;
    const item=reference.item;
    if(!['recall','quiz'].includes(item.learningSupport?.type??''))return null;
    const support=resolveCourseSupportV2(item);
    if(item.itemKey!==scope.itemKey||item.contentHash!==scope.contentHash||reference.snapshot.libraryId!==scope.libraryId
        ||reference.snapshot.snapshotId!==scope.snapshotId||!reference.snapshot.items.some(row=>row.itemKey===item.itemKey&&row.contentHash===item.contentHash))throw Error('course-original-binding');
    let selected=requestedTaskId??support.task.taskId,parentEvidenceHash:string|null=null;
    if(purpose==='remediation'&&parentId){
        const attempts=createLocalAttemptRepository({userId:scope.ownerId,libraryId:scope.libraryId});
        const repository=createLocalCourseEvidenceRepository({userId:scope.ownerId,libraryId:scope.libraryId},{cloud:true,readAttempt:id=>attempts.read(id),readItem:async()=>item});
        const parent=await repository.read(parentId);if(!parent?.diagnostic||parent.diagnostic.status==='undetermined'||!parent.diagnosticHash)throw Error('course-parent-evidence-required');
        const target=chooseCourseRemediation(support,parent.diagnostic)?.taskId??support.task.taskId;
        if(requestedTaskId&&requestedTaskId!==target)throw Error('course-remediation-binding');
        selected=target;parentEvidenceHash=parent.diagnosticHash;
    }
    return {item,support,task:resolveCourseTask(item,selected),parentEvidenceHash};
}
type RuntimeDriver={runtime:NonWordRuntimePort;restore:()=>Record<string,unknown>;fields:(values:Record<string,unknown>)=>Record<string,string>;answer:(values:Record<string,unknown>)=>string;phase:()=> 'answering'|'submitted'|'feedback'|'lesson'};
export async function attachPortableCourseDriver<T extends RuntimeDriver>(driver:T,runtime:NonWordRuntime,prepared:NonNullable<Awaited<ReturnType<typeof portableCourseTask>>>){
    const scope=runtime.scope,attempt=runtime.session.snapshot()!;
    await runtime.repository.rememberReference(attempt.attemptId,prepared.item);
    const repository=createLocalCourseEvidenceRepository({userId:scope.ownerId,libraryId:scope.libraryId},{cloud:true,readAttempt:id=>runtime.repository.read(id),readItem:async()=>prepared.item});
    const course=await createCourseLearningSession({runtime,repository,support:prepared.support,task:prepared.task,parentEvidenceHash:prepared.parentEvidenceHash,
        cloud:createAccountCourseEvidenceClient({ownerId:scope.ownerId,libraryId:scope.libraryId}),grade:createAccountCourseGradeClient({ownerId:scope.ownerId,libraryId:scope.libraryId}),
        journal:createCourseRequestJournal({userId:scope.ownerId,libraryId:scope.libraryId}),now:()=>new Date().toISOString(),newId:()=>crypto.randomUUID(),evaluationFingerprint,
        confirmCloudClaim:async()=>{
            const local=runtime.session.snapshot();if(!local?.formal||local.evaluation.status!=='resolved'||await runtime.repository.status(local.attemptId)!=='cloud-acked')return false;
            const remote=await runtime.cloud?.read(local.attemptId);
            return Boolean(remote?.formal&&remote.evaluation.status==='resolved'&&remote.evaluation.evaluationHash===local.evaluation.evaluationHash
                &&remote.formal.eventId===local.formal.eventId&&remote.formal.rating===local.formal.rating&&remote.formal.occurredAt===local.formal.occurredAt);
        }});
    const answer=(values:Record<string,unknown>)=>prepared.task.mode==='quiz'?JSON.stringify(values.courseSelection??[]):String(values.answer??'');
    return {...driver,course,restore:()=>{
        const saved=runtime.session.snapshot()!,raw=saved.submitted?.answer??saved.answer;
        let selection:string[]=[];try{const value=JSON.parse(raw);if(Array.isArray(value)&&value.every(id=>typeof id==='string'))selection=value;}catch{/* A recall answer is not a choice-ID array. */}
        return {answer:prepared.task.mode==='recall'?raw:'',courseSelection:selection};
    },fields:(values:Record<string,unknown>)=>({answer:answer(values)}),answer,
        phase:()=>runtime.session.snapshot()?.evaluation.status==='resolved'?'feedback':runtime.session.snapshot()?.submitted?'submitted':'answering'};
}
