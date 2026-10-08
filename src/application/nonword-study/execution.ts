import type {NonWordOutcome,NonWordRuntimePort,NonWordMode} from './index';
import type {CodeRunIdentity,CodeRunReportV1} from '../../domain/code-execution';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseCodeRunReport} from '../../domain/code-execution/index.ts';

type Options={
    current:()=>NonWordRuntimePort|null;
    primary:()=>NonWordRuntimePort|null;
    createChild:(parentId:string,instanceId:string)=>Promise<NonWordRuntimePort>;
    readInstance:(parent:NonWordRuntimePort)=>{instanceId:string;attemptId:string}|undefined;
    rememberInstance:(parent:NonWordRuntimePort,pointer:{instanceId:string;attemptId:string})=>Promise<void>;
    /** Versioned evidence sidecar; never add fields to the strict V1 checkpoint. */
    recordReport?:(runtime:NonWordRuntimePort,report:CodeRunReportV1,output?:string)=>Promise<void>;
    newId:()=>string;
};
/** Existing auxiliary write sequence, shared without a formal event port. */
export async function recordNonWordAuxiliary(options:{parent:NonWordRuntimePort|null;mode:NonWordMode;
    createChild:(parentId:string,instanceId:string)=>Promise<NonWordRuntimePort>;newId:()=>string},answer:string,outcome:NonWordOutcome){
    const parent=options.parent?.session.snapshot();
    if(!parent?.submitted)throw Error('请先保存首轮答案。');
    const child=await options.createChild(parent.attemptId,options.newId());
    const fields:Record<string,string>=options.mode==='calculation'?{value:answer}:{answer};
    await child.session.save(answer,fields);
    await child.session.submit(answer,'observed');
    await child.session.assess(outcome);await child.afterWrite();
}
/** An auxiliary answer gets its own durable submission before execution starts. */
export function createNonWordExecutionCoordinator(options:Options){
    let prepared:{runtime:NonWordRuntimePort;answer:string;instance?:string}|null=null;
    let queue:Promise<unknown>=Promise.resolve();
    function serial<T>(work:()=>Promise<T>):Promise<T>{
        const task=queue.then(work);queue=task.catch(()=>{});return task;
    }
    function identity(runtime:NonWordRuntimePort):CodeRunIdentity{
        const attempt=runtime.session.snapshot();
        if(!attempt?.submitted)throw Error('execution-submission-required');
        return {attemptId:attempt.attemptId,revision:attempt.submitted.answerRevision,
            sourceVersion:attempt.binding.contentHash,testVersion:attempt.binding.contentHash};
    }
    function checkCurrent(current:NonWordRuntimePort){
        if(options.current()!==current)throw Error('execution-source-changed');
    }
    function matchesSource(runtime:NonWordRuntimePort):boolean{
        const source=options.primary()?.session.snapshot()?.binding,binding=runtime.session.snapshot()?.binding;
        return Boolean(source&&binding&&Object.keys(source).every(key=>
            source[key as keyof typeof source]===binding[key as keyof typeof binding]));
    }
    const prepare=(answer:string)=>serial(async()=>{
        const current=options.current(),primary=options.primary();
        if(!current||!primary||!current.session.snapshot()?.submitted||!matchesSource(current))throw Error('execution-submission-required');
        const anchor=primary.session.snapshot()?.submitted?primary:current,original=anchor.session.snapshot()!;
        const existing=current.session.snapshot();
        // The editor's durable draft must precede the run, not its debounce timer.
        // Keep the immutable submitted answer while storing the actual visible code.
        await current.session.save(existing!.answer,{...existing!.checkpoint.pluginFields,code:answer},existing!.checkpoint.phase);
        await current.afterWrite();checkCurrent(current);
        if(existing?.submitted?.answer===answer&&existing.evaluation.status==='pending'){
            prepared={runtime:current,answer};await current.afterWrite();checkCurrent(current);
            return identity(current);
        }
        if(prepared?.answer===answer&&prepared.instance&&matchesSource(prepared.runtime)
            &&prepared.runtime.session.snapshot()?.evaluation.status==='pending'){
            await options.rememberInstance(anchor,{instanceId:prepared.instance,attemptId:identity(prepared.runtime).attemptId});checkCurrent(current);
            return identity(prepared.runtime);
        }
        const pointer=options.readInstance(anchor);
        let instance=pointer?.instanceId,child:NonWordRuntimePort|undefined;
        if(pointer){
            child=await options.createChild(original.attemptId,pointer.instanceId);checkCurrent(current);
            const saved=child.session.snapshot();
            if(saved?.attemptId!==pointer.attemptId||!saved.submitted)throw Error('execution-child-pointer-invalid');
            if(saved?.submitted&&(saved.submitted.answer!==answer||saved.evaluation.status!=='pending'))child=undefined;
        }
        if(!child){instance=options.newId();child=await options.createChild(original.attemptId,instance);checkCurrent(current);}
        const binding=child.session.snapshot()?.binding;
        if(!binding||Object.keys(original.binding).some(key=>
            binding[key as keyof typeof binding]!==original.binding[key as keyof typeof binding]))
            throw Error('execution-child-binding');
        await child.session.save(answer,{code:answer,phase:'coding'});
        await child.session.submit(answer,'observed');await child.afterWrite();checkCurrent(current);
        prepared={runtime:child,answer,instance};
        await options.rememberInstance(anchor,{instanceId:instance!,attemptId:identity(child).attemptId});checkCurrent(current);
        return identity(child);
    });
    const recordExecutionReport=(raw:CodeRunReportV1,output?:string)=>serial(async()=>{
        if(!prepared)throw Error('execution-submission-required');
        const current=options.current();if(!current)throw Error('execution-source-changed');
        if(!matchesSource(prepared.runtime))throw Error('execution-report-binding');
        const report=parseCodeRunReport(raw),expected=identity(prepared.runtime);
        if(!report.identity||Object.keys(expected).some(key=>report.identity![key as keyof CodeRunIdentity]!==expected[key as keyof CodeRunIdentity]))
            throw Error('execution-report-binding');
        if(!options.recordReport)throw Error('execution-evidence-unsupported');
        await options.recordReport(prepared.runtime,report,output);checkCurrent(current);
    });
    const recordRemediation=(answer:string,outcome:NonWordOutcome)=>serial(async()=>{
        const current=options.current(),primary=options.primary();
        if(!current||!primary||!matchesSource(current))throw Error('execution-submission-required');
        const original=(primary.session.snapshot()?.submitted?primary:current).session.snapshot();
        if(!original?.submitted)throw Error('execution-submission-required');
        const runtime=prepared?.answer===answer&&matchesSource(prepared.runtime)?prepared.runtime:
            await options.createChild(original.attemptId,options.newId());
        checkCurrent(current);
        if(!runtime.session.snapshot()?.submitted){
            await runtime.session.save(answer,{code:answer,phase:'coding'});
            await runtime.session.submit(answer,'observed');
        }
        await runtime.session.assess(outcome);await runtime.afterWrite();checkCurrent(current);
    });
    return {prepare,recordExecutionReport,recordRemediation};
}
