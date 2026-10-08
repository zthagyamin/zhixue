import type {PracticeLearningPort,PracticeEvidenceAttemptPort,PracticeEvidenceCloudPort,PracticeEvidenceServiceWritePort} from '../../application/practice-evidence';
import type {PracticeEvidenceMutationV1,PracticeEvidenceV1,PracticeEvidenceHint,PracticeEvidenceDiagnostic} from '../../domain/practice-evidence';
import type {CodeRunReportV1} from '../../domain/code-execution';
import type {CalculationSupport} from '../../domain/content';
import type {MathVariant} from '../../domain/guided-math';
import type {MathStudyRequestV1,MathStudyResultV1} from '../../application/math-study';
import type {NonWordRuntime} from '../nonword-study';
// @ts-expect-error TS5097: standalone Node contracts.
import {createPracticeEvidenceSession,createTrustedPracticeEvidenceWriter} from '../../application/practice-evidence/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createLocalPracticeEvidenceRepository} from './local.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createAccountPracticeEvidenceClient} from './account-client.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createAccountCodeHintClient} from './code-hint-client.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {evidenceEqual} from '../../domain/practice-evidence/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseMathStudyResult} from '../../application/math-study/index.ts';

type Change=PracticeEvidenceMutationV1 extends infer M?M extends PracticeEvidenceMutationV1?
    Omit<M,'schemaVersion'|'operationId'|'attemptId'|'binding'|'expectedRevision'|'updatedAt'>:never:never;
type Cloud=PracticeEvidenceCloudPort&{read(id:string):Promise<PracticeEvidenceV1|null>};
type Options={resolveSource?:PracticeEvidenceAttemptPort['resolveSource'];cloud?:Cloud;
    calculation?:{support?:CalculationSupport;sourceLabel?:string;persistLocalDiagnostic?:boolean;
        canVariant?:boolean;activeVariant?:()=>MathVariant|null;
        getVariant?:NonNullable<PracticeLearningPort['calculation']>['getVariant'];
        prepareVariant?:(descriptor:NonNullable<PracticeEvidenceV1['variant']>)=>Promise<MathVariant>;
        evaluate:(request:MathStudyRequestV1,signal?:AbortSignal)=>Promise<MathStudyResultV1>};
    requestHint?:(input:{answer:string;report:CodeRunReportV1})=>Promise<string>};
/** Attach an independent evidence adapter without extending any V1 checkpoint fields. */
export async function attachPracticeDriver<T>(driver:T,original:NonWordRuntime,options:Options={}){
    const id=original.session.snapshot()!.attemptId;
    const scope={ownerId:original.scope.ownerId,libraryId:original.scope.libraryId};
    const attempts:PracticeEvidenceAttemptPort={readAttempt:value=>original.repository.read(value),
        ...(options.resolveSource?{resolveSource:options.resolveSource}:{})};
    let approvedHint:{attemptId:string;hint:PracticeEvidenceHint}|null=null;
    let approvedDiagnostic:{attemptId:string;diagnostic:PracticeEvidenceDiagnostic}|null=null;
    const service:PracticeEvidenceServiceWritePort={resolveModelHint:async input=>approvedHint?.attemptId===input.attempt.attemptId
        &&evidenceEqual(approvedHint.hint,input.hint)?approvedHint.hint:null,
        resolveModelDiagnostic:async input=>approvedDiagnostic?.attemptId===input.attempt.attemptId
            &&evidenceEqual(approvedDiagnostic.diagnostic,input.diagnostic)?approvedDiagnostic.diagnostic:null};
    const repository=createLocalPracticeEvidenceRepository(scope,attempts,{service});
    const session=createPracticeEvidenceSession({scope,attempts,store:repository});
    const trusted=createTrustedPracticeEvidenceWriter({scope,attempts,store:repository,service});
    let cached:PracticeEvidenceV1|null=await session.open(id),tail:Promise<unknown>=Promise.resolve();
    let activeVariant:MathVariant|null=options.calculation?.activeVariant?.()??null;
    const cloud=original.scope.cloud?(options.cloud??createAccountPracticeEvidenceClient(scope)):null;
    const listeners=new Set<()=>void>();let syncJob:Promise<void>|null=null;
    const synchronize=async()=>{
        await original.synchronize();
        if(!cloud)return;
        const pending=await repository.pending();
        // Child reports and navigation pointers may refer to different saved originals.
        // Never upload them while any required original is still awaiting its receipt.
        if(original.cloud){
            const required=new Set(pending.flatMap(row=>[row.mutation.attemptId,
                ...(row.mutation.kind==='execution-pointer'?[row.mutation.prepared.attemptId]:[])]));
            for(const target of required)if(await original.repository.status(target)!=='cloud-acked')return;
        }
        const result=await repository.sync(cloud);
        if(result.conflict)throw Error('练习详情同步冲突，本机记录保留。');
    };
    const scheduleSync=()=>{
        if(!syncJob)syncJob=synchronize().finally(()=>{
            syncJob=null;for(const listener of listeners)try{listener();}catch{/* UI cannot revoke a saved receipt. */}
        });
        return syncJob;
    };
    const refresh=async()=>{cached=await session.read(id);};
    const restoreCloud=async()=>{
        if(!cloud)return;
        const remote=await cloud.read(id);if(!remote)return;
        const child=remote.execution?.prepared;
        if(child&&!await original.repository.read(child.attemptId)&&original.cloud){
            const raw=await original.cloud.read(child.attemptId);if(raw)await original.repository.hydrate(raw);
        }
        await repository.hydrate(remote);await refresh();
        if(child){const details=await cloud.read(child.attemptId);if(details)await repository.hydrate(details);}
    };
    try{await restoreCloud();}catch{/* Local durable work remains available; status distinguishes missing ACK. */}
    const write=(change:Change,targetId=id,model=false):Promise<void>=>{
        const operation=tail.then(async()=>{
            const existing=await session.read(targetId);
            const attempt=await original.repository.read(targetId);if(!attempt)throw Error('practice-evidence-attempt-unavailable');
            const receipt=await (model?trusted:session).mutate({schemaVersion:1,operationId:crypto.randomUUID(),attemptId:targetId,
                binding:attempt.binding,expectedRevision:existing?.revision??0,updatedAt:new Date().toISOString(),...change} as PracticeEvidenceMutationV1);
            if(!receipt.durable||receipt.status==='conflict'||!receipt.record)throw Error('practice-evidence-conflict');
            if(targetId===id)cached=receipt.record;else await refresh();
        });
        tail=operation.catch(()=>{});return operation;
    };
    let stepDraft:string|undefined,stepTimer:ReturnType<typeof setTimeout>|undefined,stepJob:Promise<void>|null=null,stepError='';
    const flushStep=async():Promise<void>=>{
        if(stepTimer!==undefined){clearTimeout(stepTimer);stepTimer=undefined;}
        if(stepJob){await stepJob;if(stepDraft!==undefined)return flushStep();return;}
        const task=(async()=>{
            while(stepDraft!==undefined){
                const text=stepDraft;
                if(cached?.calculation?.stepInput.text!==text)await write({kind:'step-input',text});
                if(stepDraft===text)stepDraft=undefined;
            }
            stepError='';
        })();
        stepJob=task;
        try{await task;}catch(error){stepError='步骤尚未保存，输入保留，请重试。';throw error;}
        finally{stepJob=null;for(const listener of listeners)try{listener();}catch{/* View listeners cannot alter durability. */}}
    };
    const beforeSubmit=async()=>{
        await flushStep();
        if(cloud&&cached?.calculation&&!original.session.snapshot()?.submitted){
            await synchronize();
            if((await repository.pending()).some(row=>row.mutation.attemptId===id))throw Error('步骤已存本机，尚未取得同步回执，请重试保存。');
        }
    };
    const practice:PracticeLearningPort={snapshot:()=>cached?structuredClone(cached):null,refresh,
        ...(options.calculation?{calculation:{support:options.calculation.support,sourceLabel:options.calculation.sourceLabel,
            get canVariant(){return !activeVariant&&!cached?.variant&&Boolean(options.calculation?.canVariant);},
            activeVariant:()=>activeVariant??options.calculation?.activeVariant?.()??null,
            ...(options.calculation.getVariant?{getVariant:options.calculation.getVariant}:{}),
            ...(options.calculation.prepareVariant?{async prepareVariant(descriptor:NonNullable<PracticeEvidenceV1['variant']>){
                if(stepDraft!==undefined||cached?.calculation)throw Error('math-variant-step-unavailable');
                const rebuilt=await options.calculation!.prepareVariant!(descriptor);
                if(cached?.variant){
                    if(!evidenceEqual(cached.variant,descriptor))throw Error('math-variant-descriptor-binding');
                    activeVariant=rebuilt;return;
                }
                if(original.session.snapshot()?.submitted||original.session.snapshot()?.formal)throw Error('math-variant-answer-already-submitted');
                await write({kind:'variant',variant:descriptor});activeVariant=rebuilt;
            }}:{}),
            async evaluate(mode:'final'|'step',signal?:AbortSignal){
                if(mode==='step'&&(activeVariant||cached?.variant))throw Error('math-variant-step-unavailable');
                await synchronize();await refresh();
                if(cloud&&(await repository.pending()).some(row=>row.mutation.attemptId===id))throw Error('计算答案详情尚未同步，请稍后重试。');
                const attempt=await original.repository.read(id),input=cached?.calculation?.stepInput;
                if(!attempt?.submitted)throw Error('计算答案尚未保存。');
                const request:MathStudyRequestV1={schemaVersion:1,attemptId:id,answerRevision:attempt.submitted.answerRevision,
                    sourceVersion:attempt.binding.contentHash,mode,...(input?{stepRevision:input.revision}:{})};
                const result=parseMathStudyResult(await options.calculation!.evaluate(request,signal),request);
                if(signal?.aborted)throw Error('math-evaluation-cancelled');
                const current=await original.repository.read(id);
                if(!evidenceEqual(current?.submitted,attempt.submitted))throw Error('math-evaluation-binding');
                try{
                    if(result.evidence){await repository.hydrate(result.evidence);await refresh();}
                    else if(result.step&&options.calculation!.persistLocalDiagnostic){
                        approvedDiagnostic={attemptId:id,diagnostic:result.step};
                        try{await write({kind:'step-diagnostic',diagnostic:result.step},id,result.step.source==='model');}
                        finally{approvedDiagnostic=null;}
                    }else if(result.step)throw Error('math-step-evidence-not-saved');
                }catch(error){
                    if(mode==='step'||!result.final||result.final.status==='undetermined')throw error;
                    return {...result,step:result.step?{...result.step,status:'undetermined' as const,source:'none' as const,
                        explanation:'步骤反馈尚未保存，可稍后核对。'}:undefined};
                }
                return result;
            }}}:{}),
        recordPrepared:prepared=>write({kind:'execution-pointer',prepared}),
        async recordCodeReport(report,output){
            await write({kind:'code-report',report,...(output===undefined?{}:{output})});
            // Publish the saved run before the caller can reserve a formal result.
            // A remote formal reservation must never overtake its original run evidence.
            if(cloud){
                await synchronize();
                if((await repository.pending()).some(row=>row.mutation.attemptId===id))throw Error('运行报告已存本机，尚未取得同步回执，可稍后核对。');
            }
        },
        recordCodeHint:async hint=>{
            await refresh();const child=cached?.execution?.prepared;
            await write({kind:'code-hint',hint},child?.attemptId??id);
        },
        async codeFeedback(){
            await refresh();
            const attempt=await original.repository.read(id);
            if(!attempt)throw Error('practice-evidence-attempt-unavailable');
            const evaluation=attempt.evaluation;
            const firstState={status:evaluation.status==='pending'?'pending' as const:
                attempt.checkpoint.pluginFields?.firstRunKind==='forgotten'?'forgotten' as const:
                evaluation.correct?'correct' as const:'incorrect' as const,
                explanation:evaluation.feedback??'原代码已保存，等待核对。'};
            const own=cached?.execution,child=own?.prepared?await session.read(own.prepared.attemptId):null;
            const active=child?.execution?.latest?child.execution:own;
            return {...(own?.first?{first:own.first}:{}),...(active?.latest?{latest:active.latest}:{}),
                ...(active?.latestOutput===undefined?{}:{output:active.latestOutput}),...(active?.hint?{hint:active.hint}:{}),firstState};
        },
        async saveStep(text){if(activeVariant||cached?.variant)throw Error('math-variant-step-unavailable');stepDraft=text;await beforeSubmit();},flush:flushStep,beforeSubmit,
        stageStep(text){
            if(activeVariant||cached?.variant)throw Error('math-variant-step-unavailable');
            if(original.session.snapshot()?.submitted)throw Error('步骤已随答案保存，不能改写。');
            stepDraft=text;if(stepTimer!==undefined)clearTimeout(stepTimer);
            stepTimer=setTimeout(()=>{stepTimer=undefined;void flushStep().catch(()=>{});},250);
        },
        ...((cloud||options.requestHint)?{requestCodeHint:async(report:CodeRunReportV1)=>{
            const target=report.identity?.attemptId;
            if(!target)throw Error('提示尚未绑定已保存的代码。');
            const record=await session.read(target),attempt=await original.repository.read(target);
            if(!attempt?.submitted||!evidenceEqual(record?.execution?.latest,report))throw Error('当前运行结果已变化，请重新查看反馈。');
            const hint=record?.execution?.hint;
            if(hint?.runId===report.runId&&hint.caseId===report.firstFailure?.caseId)return hint.text;
            if(cloud){
                await synchronize();
                if((await repository.pending()).some(row=>row.mutation.attemptId===target))throw Error('代码详情尚未同步，请稍后重试提示。');
                const result=await createAccountCodeHintClient(scope)(report);
                await repository.hydrate(result.evidence);await refresh();return result.hint.text;
            }
            const text=await options.requestHint!({answer:attempt.submitted.answer,report});
            if(!text.trim()||text.length>2000)throw Error('提示内容无法可靠保存，请重试。');
            const current=await original.repository.read(target),latest=await session.read(target);
            if(!evidenceEqual(current?.submitted,attempt.submitted)||!evidenceEqual(latest?.execution?.latest,report))throw Error('当前作答已变化，旧提示未应用。');
            const prepared:PracticeEvidenceHint={runId:report.runId,...(report.firstFailure?{caseId:report.firstFailure.caseId}:{}),text,source:'model'};
            approvedHint={attemptId:target,hint:prepared};
            try{await write({kind:'code-hint',hint:prepared},target,true);return text;}finally{approvedHint=null;}
        }}:{}),
        status:async()=>{
            if(stepError)return stepError;
            if(!cloud)return '练习详情已保存在本机。';
            const state=await repository.status(id);
            return state==='cloud-acked'?'练习详情已同步。':state==='cloud-conflict'?'练习详情同步冲突，本机记录保留。':
                state==='cloud-unsupported'?'当前服务不支持练习详情同步，本机记录保留。':
                state==='cloud-incompatible'?'服务版本不兼容，本机练习详情保留。':'练习详情已保存，等待同步。';
        }};
    return {...driver,runtime:{...original,practice,synchronize,
        async afterWrite(){await original.afterWrite();void scheduleSync().catch(()=>{});},
        subscribeStatus(listener:()=>void){listeners.add(listener);const remove=original.subscribeStatus(listener);
            return ()=>{listeners.delete(listener);remove();};},
        async status(){const status=await original.status();return cached&&!/冲突/.test(status)?practice.status():status;}}};
}
