import type {Authenticated,AccountContext,AccountReply} from '../account-study';
// @ts-expect-error TS5097: standalone Node contracts.
import {AccountFailure} from '../../domain/account-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject} from '../../domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {attemptId} from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseCourseEvidenceMutation} from '../../domain/course-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {evaluateAccountCourse} from './account-evaluation.ts';

export async function executeCourseAction(body:Record<string,unknown>,auth:Authenticated,context:AccountContext,signal:AbortSignal):Promise<AccountReply|null>{
    if(!['course-evidence-read','course-evidence-mutate','course-grade'].includes(String(body.action)))return null;
    if(auth.principal.kind==='device')context.requireRole(auth.principal,'device');
    const scope=await context.scope(auth.principal,body.libraryId),store=await context.deps.getCourseEvidenceStore?.();
    if(!store||!await store.supported())throw new AccountFailure(409,'course-evidence-unsupported');
    if(body.action==='course-grade'){
        context.requireRole(auth.principal,'browser');
        return evaluateAccountCourse(body,scope,context,store,signal);
    }
    try{
        if(body.action==='course-evidence-read'){
            studyObject(body,['action','attemptId'],['libraryId']);
            return {kind:'value',status:200,value:{evidence:await store.read(scope,attemptId(body.attemptId))}};
        }
        studyObject(body,['action','mutation'],['libraryId']);
        const mutation=parseCourseEvidenceMutation(body.mutation);
        if(mutation.binding.ownerId!==scope.userId||mutation.binding.libraryId!==scope.libraryId)throw new AccountFailure(403,'course-evidence-scope-mismatch');
        return {kind:'value',status:200,value:await store.mutate(scope,mutation)};
    }catch(error){
        if(error instanceof AccountFailure)throw error;
        const code=error instanceof Error?error.message:'';
        if(/^(course-|invalid-course-|unsupported-course-)/.test(code))throw new AccountFailure(409,code);
        throw new AccountFailure(400,'invalid-course-evidence-request');
    }
}
