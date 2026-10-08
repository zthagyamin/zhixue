import type {AccountContext,StudyScope} from '../account-study';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyHash,studyObject} from '../../domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalAttemptJson} from '../../domain/learning-attempt/index.ts';
export type PracticeAiKind='math-step'|'code-hint';
export type PracticeAiTrace={requestId:string;modelId:string;promptVersion:string;ruleVersion:string};
export interface PracticeAiPort {
    run(kind:PracticeAiKind,input:unknown,trace:PracticeAiTrace,budget:{maxOutputTokens:number},signal:AbortSignal):Promise<{output:unknown;trace:PracticeAiTrace;usageTokens?:number}>;
}
export const PRACTICE_AI_PROMPT_VERSION='practice-assistance-v1';
export const PRACTICE_AI_RULE_VERSION='source-bound-assistance-v1';
const same=(a:unknown,b:unknown)=>canonicalAttemptJson(a)===canonicalAttemptJson(b);
/** Durable AI receipt is saved before sidecar writing, so receipt loss never charges a second model call. */
export async function controlledPracticeAi<T>(options:{context:AccountContext;scope:StudyScope;requestId:string;kind:PracticeAiKind;input:unknown;validate:(raw:unknown)=>T;signal:AbortSignal}):Promise<T|null>{
    const {context,scope,kind,input,signal}=options;
    if(signal.aborted)throw Error('practice-ai-cancelled');
    if(!context.deps.getPracticeAi)return null;
    const store=await context.deps.getAiStore(),settings=await store.getSettings(scope);
    const modelId=settings.model||(settings.provider==='deepseek'?context.deps.getCourseAiTrace?.().modelId??'':'');
    if(!settings.enabled||!settings.configured||!modelId)return null;
    const requestId=`pa:${await studyHash([options.requestId,kind,settings.provider,modelId,settings.baseUrl])}`;
    const trace={requestId,modelId,promptVersion:PRACTICE_AI_PROMPT_VERSION,ruleVersion:PRACTICE_AI_RULE_VERSION};
    const inputHash=await studyHash({kind,input,trace,provider:settings.provider,baseUrl:settings.baseUrl});
    const maxOutputTokens=Math.min(2000,settings.maxOutputTokens),reservedTokens=new TextEncoder().encode(JSON.stringify(input)).byteLength+maxOutputTokens+3000;
    if(reservedTokens>100000)return null;
    const day=new Date(context.deps.now().getTime()+8*3600000).toISOString().slice(0,10);
    let reservation;
    try{reservation=await store.begin(scope,{requestId,inputHash,day,reservedTokens,expectedRevision:settings.revision,trace:{modelId,promptVersion:trace.promptVersion,ruleVersion:trace.ruleVersion,operationKind:'question',provider:settings.provider}});}
    catch(error){if(error instanceof Error&&error.message==='ai-request-conflict')throw Error('practice-ai-input-binding');return null;}
    if(reservation.status==='pending')throw Error('practice-ai-request-pending');
    if(reservation.status==='failed')return null;
    if(reservation.status==='completed'){
        let saved;
        try{saved=studyObject(reservation.result,['schemaVersion','kind','input','trace','output']);}catch{throw Error('practice-ai-prepared-binding');}
        if(saved.schemaVersion!==1||saved.kind!==kind||!same(saved.input,input)||!same(saved.trace,trace))throw Error('practice-ai-prepared-binding');
        if(signal.aborted)throw Error('practice-ai-cancelled');
        try{return options.validate(saved.output);}catch{throw Error('practice-ai-prepared-binding');}
    }
    let prepared=false;
    try{
        const result=await (await context.deps.getPracticeAi(scope,settings.revision)).run(kind,input,trace,{maxOutputTokens:Math.min(maxOutputTokens,reservation.settings.maxOutputTokens)},signal);
        if(signal.aborted)throw Error('practice-ai-cancelled');
        if(!same(result.trace,trace))throw Error('practice-ai-output-invalid');
        const output=options.validate(result.output);
        const receipt={schemaVersion:1,kind,input,trace,output:result.output};
        prepared=true;
        await store.complete(scope,requestId,inputHash,receipt,result.usageTokens??reservedTokens);
        return output;
    }catch(error){
        if(prepared)throw Error('practice-ai-receipt-unknown');
        await store.fail(scope,requestId,inputHash,signal.aborted?'practice-ai-cancelled':'practice-ai-output-invalid');
        if(signal.aborted)throw Error('practice-ai-cancelled');
        if(error instanceof Error&&/binding/.test(error.message))throw error;
        return null;
    }
}
