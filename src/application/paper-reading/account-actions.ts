import type {Authenticated,AccountContext} from '../account-study';
import type {AccountReply} from '../account-study';
// @ts-expect-error TS5097: standalone Node contracts.
import {AccountFailure} from '../../domain/account-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject} from '../../domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {paperReadingTask,parsePaperReadingMutation,paperReadingDiscoveryQuery,parsePaperReadingDiscoveryPage} from '../../domain/paper-reading/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createPaperReadingService} from './service.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createControlledPaperReadingAi} from './controlled-ai.ts';
const actions=['list-paper-reading','read-paper-reading','mutate-paper-reading','prepare-paper-reading','evaluate-paper-reading'];
export async function executePaperReadingAction(body:Record<string,unknown>,auth:Authenticated,context:AccountContext,signal:AbortSignal):Promise<AccountReply|null>{
    if(!actions.includes(body.action as string))return null;
    context.requireRole(auth.principal,'browser');
    const action=body.action;
    const required=action==='list-paper-reading'?['action']:action==='mutate-paper-reading'?['action','mutation']:action==='read-paper-reading'?['action','unitId']:action==='prepare-paper-reading'?['action','unitId','requestId']:['action','unitId','attemptId','requestId'];
    const optional=['libraryId',...(action==='list-paper-reading'?['cursor','limit']:[]),...(action==='prepare-paper-reading'?['preparedTask']:[])];
    let value;try{value=studyObject(body,required,optional);}catch{throw new AccountFailure(400,'invalid-paper-reading-fields');}
    const accountScope=await context.scope(auth.principal,value.libraryId),scope={ownerId:'account:'+accountScope.userId,libraryId:'account:'+accountScope.libraryId};
    const store=await context.deps.getPaperReadingStore?.();
    if(!store||!await store.supported())throw new AccountFailure(503,'paper-reading-unsupported');
    const service=createPaperReadingService({scope,store,ai:createControlledPaperReadingAi(context,accountScope)});
    try{
        if(action==='list-paper-reading'){
            if(!store.list)throw Error('paper-reading-discovery-unsupported');
            const query={...(value.cursor!==undefined?{cursor:value.cursor as string|null}:{}),...(value.limit!==undefined?{limit:value.limit as number}:{})};
            paperReadingDiscoveryQuery(scope,query);signal.throwIfAborted();
            const page=await store.list(scope,query);signal.throwIfAborted();
            return {kind:'value',status:200,value:parsePaperReadingDiscoveryPage(page,scope,query)};
        }
        if(action==='mutate-paper-reading')return {kind:'value',status:200,value:await store.mutate(scope,parsePaperReadingMutation(value.mutation))};
        if(typeof value.unitId!=='string'||!value.unitId.trim()||value.unitId.length>200)throw Error('invalid-paper-unit');
        if(action==='read-paper-reading')return {kind:'value',status:200,value:{workspace:await store.read(scope,value.unitId as string)}};
        if(typeof value.requestId!=='string'||!value.requestId.trim()||value.requestId.length>200)throw Error('invalid-paper-request');
        if(action==='prepare-paper-reading'){
            const task=value.preparedTask===undefined?undefined:paperReadingTask(value.preparedTask as Parameters<typeof paperReadingTask>[0]);
            if(task&&task.origin!=='prepared')throw Error('paper-prepared-task-binding');
            return {kind:'value',status:200,value:{workspace:await service.begin(value.unitId as string,value.requestId as string,signal,task)}};
        }
        if(typeof value.attemptId!=='string'||!value.attemptId.trim()||value.attemptId.length>200)throw Error('invalid-paper-attempt');
        return {kind:'value',status:200,value:{workspace:await service.evaluate(value.unitId as string,value.attemptId as string,value.requestId as string,signal)}};
    }catch(error){
        if(signal.aborted)throw error;
        const code=error instanceof Error?error.message:'paper-reading-invalid';
        throw new AccountFailure(/conflict|pending|binding|unknown|not-registered/.test(code)?409:/unsupported|unavailable/.test(code)?503:400,/^[a-z0-9-]+$/.test(code)?code:'paper-reading-invalid');
    }
}
