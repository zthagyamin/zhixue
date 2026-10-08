import type {AccountContext,AccountReply,Authenticated,StudyScope} from '../account-study';
import type {AttemptBinding} from '../../domain/learning-attempt';
import type {AccountPracticeEvidenceMappingPort} from '../practice-evidence';
import type {MathMappingPreparationV1,MathMappingPreparationRecordV1} from '../../domain/guided-math';
// @ts-expect-error TS5097: standalone Node contracts.
import {AccountFailure} from '../../domain/account-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject,studyId} from '../../domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseMathMappingPreparation} from '../../domain/guided-math/index.ts';
export type MathMappingPublishReceipt={status:'accepted'|'duplicate'|'conflict';durable:boolean;record:MathMappingPreparationRecordV1|null};
export interface AccountMathMappingStorePort extends AccountPracticeEvidenceMappingPort{
    supported():Promise<boolean>;
    publish(scope:StudyScope,preparation:MathMappingPreparationV1,provenance:{originGrantId:string;publishedAt:string}):Promise<MathMappingPublishReceipt>;
    readPreparation(scope:StudyScope,binding:AttemptBinding):Promise<MathMappingPreparationRecordV1|null>;
}
/** Browser reads refer only to a saved attempt. Existing publishing devices
 * may publish reviewed preparation; this does not create a new account grant. */
export async function executeMathMappingAction(body:Record<string,unknown>,auth:Authenticated,context:AccountContext):Promise<AccountReply|null>{
    if(!['math-mapping-publish','math-mapping-read'].includes(String(body.action)))return null;
    const publish=body.action==='math-mapping-publish';
    context.requireRole(auth.principal,publish?'device':'browser');
    const scope=await context.scope(auth.principal,body.libraryId);
    try{
        studyObject(body,['action',publish?'preparation':'attemptId'],['libraryId']);
        const preparation=publish?parseMathMappingPreparation(body.preparation):null;
        if(!publish)studyId(body.attemptId);
        const store=await context.deps.getMathMappingStore?.();
        if(!store||!await store.supported()){
            if(publish)throw new AccountFailure(409,'math-mapping-unsupported');
            return {kind:'value',status:200,value:{status:'unavailable'}};
        }
        if(publish){
            if(auth.principal.kind!=='device')throw new AccountFailure(403,'action-not-allowed');
            const value=await store.publish(scope,preparation!,{originGrantId:auth.principal.grantId,publishedAt:context.deps.now().toISOString()});
            return {kind:'value',status:200,value};
        }
        studyId(body.attemptId);
        const attempts=await context.deps.getAttemptStore?.();
        if(!attempts||!await attempts.supported())return {kind:'value',status:200,value:{status:'unavailable'}};
        const attempt=await attempts.read(scope,body.attemptId);
        if(attempt&&(attempt.binding.ownerId!==scope.userId||attempt.binding.libraryId!==scope.libraryId))throw new AccountFailure(403,'math-mapping-scope-binding');
        const record=attempt?.checkpoint.mode==='calculation'?await store.readPreparation(scope,attempt.binding):null;
        return {kind:'value',status:200,value:record?{status:'available',...record}:{status:'unavailable'}};
    }catch(error){
        if(error instanceof AccountFailure)throw error;
        const code=error instanceof Error?error.message:'';
        throw new AccountFailure(/^(math-mapping-|study-content-|incomplete-study)/u.test(code)?409:400,code||'invalid-math-mapping-request');
    }
}
