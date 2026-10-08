import type {NonWordRuntimePort} from '../../application/nonword-study';
import type {NonWordRuntime} from '../nonword-study';
import type {MathVariant,MathMappingPreparationRecordV1} from '../../domain/guided-math';
import type {PracticeEvidenceCloudPort} from '../../application/practice-evidence';
import type {PracticeEvidenceV1,PracticeVariantRecoveryV1} from '../../domain/practice-evidence';
import type {MathStudyRequestV1,MathStudyResultV1} from '../../application/math-study';
import type {AccountMathOriginal} from './mapping-client';
// @ts-expect-error TS5097: standalone Node contracts.
import {attachPracticeDriver,createAccountMathClient} from '../practice-evidence/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {evidenceEqual} from '../../domain/practice-evidence/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createAccountMathMappingClient,validateAccountMathOriginal,rebuildApprovedMathVariant} from './mapping-client.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createMathMappingCache} from './mapping-cache.ts';
type Driver={runtime:NonWordRuntimePort;restore:()=>Record<string,unknown>;fields:(values:Record<string,unknown>)=>Record<string,string>;answer:(values:Record<string,unknown>)=>string};
type Options={fetcher?:typeof fetch;cloud?:PracticeEvidenceCloudPort&{read(id:string):Promise<PracticeEvidenceV1|null>};evaluate?:(request:MathStudyRequestV1,signal?:AbortSignal)=>Promise<MathStudyResultV1>};
/** Frozen original authority is supplied by the existing source compiler at composition. */
export async function attachAccountMathDriver<T extends Driver>(driver:T,runtime:NonWordRuntime,original:AccountMathOriginal,options:Options={}){
    const scope=runtime.scope,initial=runtime.session.snapshot();
    if(!initial||!scope.cloud||initial.checkpoint.mode!=='calculation'||initial.binding.ownerId!==scope.ownerId
        ||initial.binding.libraryId!==scope.libraryId||initial.binding.snapshotId!==original.snapshot.snapshotId
        ||initial.binding.itemKey!==original.item.itemKey||initial.binding.contentHash!==original.item.contentHash)throw Error('math-original-source-binding');
    const support=await validateAccountMathOriginal(original,scope),client=createAccountMathMappingClient(scope,original,options.fetcher),cache=createMathMappingCache(scope,original);
    await runtime.repository.rememberReference(initial.attemptId,original.item);
    let approved:MathMappingPreparationRecordV1|null=await cache.read(),active:MathVariant|null=null;
    // References must never race the original attempt's first upload. Valid historical
    // preparation can remain useful while this optional read is unavailable.
    try{
        await runtime.synchronize();
        if(!runtime.cloud||await runtime.repository.status(initial.attemptId)==='cloud-acked'){
            const remote=await client.read(initial.parentAttemptId??initial.attemptId);
            if(remote){await cache.save(remote);approved=remote;}
        }
    }catch(error){
        if(error instanceof Error&&/binding|integrity|conflict|version|unknown-study-field/.test(error.message))throw error;
    }
    const resolveSource=async(attempt:NonNullable<typeof initial>)=>{
        if(!support||!evidenceEqual(attempt.binding,initial.binding))return null;
        const mapping=(await cache.read())?.preparation.mapping;
        return {binding:attempt.binding,calculation:support,...(mapping?{mapping}:{})};
    };
    const restoreVariant=async(descriptor:PracticeVariantRecoveryV1)=>{
        if(!approved)throw Error('math-variant-approved-source-unavailable');
        const rebuilt=await rebuildApprovedMathVariant(original,approved,descriptor.seed);
        if(!evidenceEqual(descriptor,rebuilt.descriptor))throw Error('math-variant-descriptor-binding');
        return rebuilt.variant;
    };
    const attached=await attachPracticeDriver(driver,runtime,{resolveSource,...(options.cloud?{cloud:options.cloud}:{}),
        calculation:{support,sourceLabel:original.item.kind==='practice'?original.item.practice.sourceLabel:undefined,
            evaluate:options.evaluate??createAccountMathClient(scope,options.fetcher),canVariant:Boolean(approved),activeVariant:()=>active,
            async getVariant(seed,signal){
                if(!approved||active)return null;
                signal?.throwIfAborted();await runtime.synchronize();
                let variant;
                try{variant=await client.variant(initial.attemptId,seed,approved,signal);}
                catch(error){if(signal?.aborted||error instanceof Error&&/binding|integrity|invalid|unsupported/.test(error.message))throw error;}
                signal?.throwIfAborted();return variant??rebuildApprovedMathVariant(original,approved,seed);
            },prepareVariant:restoreVariant}});
    const calculation=attached.runtime.practice.calculation!;
    const oldPrepare=calculation.prepareVariant!;
    calculation.prepareVariant=async descriptor=>{await oldPrepare(descriptor);active=await restoreVariant(descriptor);};
    const restored=attached.runtime.practice.snapshot()?.variant;if(restored)active=await restoreVariant(restored);
    const answer=(values:Record<string,unknown>)=>{
        if(!active)return driver.answer(values);
        const kind=String(values.calculationAnswerKind??'number');
        if(!['number','none','all','allowed','not-allowed'].includes(kind))throw Error('math-variant-answer-kind');
        return JSON.stringify({answerKind:kind,answer:kind==='number'?String(values.value??''):''});
    };
    return {...attached,answer,fields:(values:Record<string,unknown>)=>active?{value:answer(values),phase:values.result?'feedback':'answer'}:driver.fields(values),
        restore:()=>{
            const values=driver.restore();if(!active)return values;
            const saved=runtime.session.snapshot()!,raw=saved.checkpoint.pluginFields?.value??saved.submitted?.answer??saved.answer;
            if(!raw)return {...values,value:'',calculationAnswerKind:'number'};
            let input;try{input=JSON.parse(raw);}catch{throw Error('math-variant-answer-format');}
            if(!input||typeof input.answer!=='string'||!['number','none','all','allowed','not-allowed'].includes(input.answerKind)
                ||Object.keys(input).sort().join(',')!=='answer,answerKind')throw Error('math-variant-answer-format');
            return {...values,value:input.answer,calculationAnswerKind:input.answerKind};
        }};
}
