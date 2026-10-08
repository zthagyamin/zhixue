import type {Authenticated,AccountContext,AccountReply} from '../account-study';
// @ts-expect-error TS5097: standalone Node contracts.
import {AccountFailure} from '../../domain/account-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject} from '../../domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {attemptId} from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parsePracticeEvidenceMutation} from '../../domain/practice-evidence/index.ts';

export async function executePracticeEvidenceAction(body:Record<string,unknown>,auth:Authenticated,context:AccountContext):Promise<AccountReply|null> {
    if(!['practice-evidence-read','practice-evidence-list','practice-evidence-mutate'].includes(String(body.action)))return null;
    if(auth.principal.kind==='device')context.requireRole(auth.principal,'device');
    const scope=await context.scope(auth.principal,body.libraryId),store=await context.deps.getPracticeEvidenceStore?.();
    if(!store||!await store.supported())throw new AccountFailure(409,'practice-evidence-unsupported');
    try {
        if(body.action==='practice-evidence-read') {
            studyObject(body,['action','attemptId'],['libraryId']);
            return {kind:'value',status:200,value:{record:await store.read(scope,attemptId(body.attemptId))}};
        }
        if(body.action==='practice-evidence-list') {
            studyObject(body,['action'],['libraryId','cursor','limit']);
            if(body.limit!==undefined&&(typeof body.limit!=='number'||!Number.isSafeInteger(body.limit)||body.limit<1||body.limit>200))throw Error('practice-evidence-page-limit');
            return {kind:'value',status:200,value:await store.list(scope,{...(body.cursor===undefined?{}:{cursor:attemptId(body.cursor)}),...(body.limit===undefined?{}:{limit:body.limit as number})})};
        }
        studyObject(body,['action','mutation'],['libraryId']);
        const mutation=parsePracticeEvidenceMutation(body.mutation);
        if(mutation.binding.ownerId!==scope.userId||mutation.binding.libraryId!==scope.libraryId)throw new AccountFailure(403,'practice-evidence-scope-mismatch');
        return {kind:'value',status:200,value:await store.mutate(scope,mutation)};
    } catch(error) {
        if(error instanceof AccountFailure)throw error;
        const code=error instanceof Error?error.message:'';
        if(code.startsWith('practice-evidence-'))throw new AccountFailure(409,code);
        throw new AccountFailure(400,'invalid-practice-evidence-request');
    }
}
