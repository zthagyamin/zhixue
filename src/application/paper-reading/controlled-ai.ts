// @ts-expect-error TS5097: standalone Node contracts.
import {paperReadingDerivedId} from './identity.ts';
import type {AccountContext,StudyScope} from '../account-study';
import type {PaperReadingAiPort,PaperReadingModelTrace} from './ports';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyHash,studyObject} from '../../domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {paperReadingPreparation,paperReadingModelEvaluation} from '../../domain/paper-reading/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalAttemptJson} from '../../domain/learning-attempt/index.ts';
const same=(a:unknown,b:unknown)=>canonicalAttemptJson(a)===canonicalAttemptJson(b);
export function createControlledPaperReadingAi(context:AccountContext,scope:StudyScope):PaperReadingAiPort{
    async function run<T>(kind:'prepare'|'evaluate',input:unknown,request:string,validate:(output:unknown)=>T,signal:AbortSignal):Promise<T|null>{
        signal.throwIfAborted();if(!context.deps.getPaperReadingProvider)return null;
        const store=await context.deps.getAiStore(),settings=await store.getSettings(scope);
        const modelId=settings.model||(settings.provider==='deepseek'?context.deps.getCourseAiTrace?.().modelId??'':'');
        if(!settings.enabled||!settings.configured||!modelId)return null;
        const requestId='paper-ai:'+await studyHash([request,kind,settings.provider,modelId,settings.baseUrl]);
        const trace:PaperReadingModelTrace={requestId,modelId,promptVersion:'paper-reading-v1',ruleVersion:'paper-source-and-answer-evidence-v1'};
        const inputHash=await studyHash({kind,input,trace,provider:settings.provider,baseUrl:settings.baseUrl});
        const maxOutputTokens=Math.min(2400,settings.maxOutputTokens),reservedTokens=new TextEncoder().encode(JSON.stringify(input)).byteLength+maxOutputTokens+3000;
        if(reservedTokens>100000)return null;
        const day=new Date(context.deps.now().getTime()+8*3600000).toISOString().slice(0,10);
        let reservation;
        try{reservation=await store.begin(scope,{requestId,inputHash,day,reservedTokens,expectedRevision:settings.revision,
            trace:{operationKind:'question',provider:settings.provider,modelId,promptVersion:trace.promptVersion,ruleVersion:trace.ruleVersion}});}
        catch{return null;}
        if(reservation.status==='pending')throw Error('paper-ai-request-pending');
        if(reservation.status==='failed')return null;
        if(reservation.status==='completed'){
            const receipt=studyObject(reservation.result,['schemaVersion','kind','input','trace','output']);
            if(receipt.schemaVersion!==1||receipt.kind!==kind||!same(receipt.input,input)||!same(receipt.trace,trace))throw Error('paper-ai-receipt-binding');
            signal.throwIfAborted();return validate(receipt.output);
        }
        let prepared=false;
        try{
            const result=await(await context.deps.getPaperReadingProvider(scope,settings.revision)).run(kind,input,trace,{maxOutputTokens:Math.min(maxOutputTokens,reservation.settings.maxOutputTokens)},signal);
            signal.throwIfAborted();if(!same(result.trace,trace))throw Error('paper-ai-result-binding');
            const output=validate(result.output);prepared=true;
            await store.complete(scope,requestId,inputHash,{schemaVersion:1,kind,input,trace,output:result.output},result.usageTokens??reservedTokens);
            return output;
        }catch(error){
            if(prepared)throw Error('paper-ai-receipt-unknown');
            await store.fail(scope,requestId,inputHash,signal.aborted?'paper-ai-cancelled':'paper-ai-result-invalid');
            signal.throwIfAborted();if(error instanceof Error&&/binding/.test(error.message))throw error;
            return null;
        }
    }
    return {
        prepare:async(unit,requestId,signal)=>{const taskId=await paperReadingDerivedId('paper-task:'+unit.unitId,194);return run('prepare',{unit},requestId,
            output=>paperReadingPreparation(output,unit,taskId),signal);},
        evaluate:async(task,answer,requestId,signal)=>await run('evaluate',{task,answer},requestId,
            output=>paperReadingModelEvaluation(output,task,answer),signal)??{status:'pending',reason:'offline'},
    };
}
