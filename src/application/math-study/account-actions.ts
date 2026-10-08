import type {AccountContext,AccountReply,Authenticated} from '../account-study';
import type {LearningAttempt} from '../../domain/learning-attempt';
import type {PracticeEvidenceDiagnostic,PracticeEvidenceV1} from '../../domain/practice-evidence';
// @ts-expect-error TS5097: standalone Node contracts.
import {AccountFailure} from '../../domain/account-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject,studyId,studyHash} from '../../domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {courseEvidenceOriginal} from '../course-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {resolveCalculationReferenceSupport} from '../../domain/math-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {evidenceEqual,parsePracticeEvidenceDiagnostic} from '../../domain/practice-evidence/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createMathStudyEvaluator,parseMathStudyRequest,type MathStudySource} from './evaluator.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {controlledPracticeAi} from './controlled-ai.ts';

export async function executeMathStudyAction(body:Record<string,unknown>,auth:Authenticated,context:AccountContext,signal:AbortSignal):Promise<AccountReply|null>{
    if(!['math-evaluate','math-variant'].includes(String(body.action)))return null;
    context.requireRole(auth.principal,'browser');
    const scope=await context.scope(auth.principal,body.libraryId);
    try{
        const variant=body.action==='math-variant';
        studyObject(body,variant?['action','attemptId','seed']:['action','requestId','request'],['libraryId']);
        if(variant){studyId(body.attemptId);if(!Number.isSafeInteger(body.seed)||(body.seed as number)<0||(body.seed as number)>0xffffffff)throw Error('invalid-math-request');}
        else studyId(body.requestId);
        const request=variant?null:parseMathStudyRequest(body.request),attempts=await context.deps.getAttemptStore?.();
        if(!attempts||!await attempts.supported())throw new AccountFailure(409,'learning-attempts-unsupported');
        const original=courseEvidenceOriginal(await context.deps.getStudyStore(),attempts);
        const mapping=await context.deps.getPracticeEvidenceMapping?.();
        const readAttempt=async(id:string)=>{
            const a=await attempts.read(scope,id);
            if(a&&(a.binding.ownerId!==scope.userId||a.binding.libraryId!==scope.libraryId))throw new AccountFailure(403,'math-evidence-scope-mismatch');
            return a;
        };
        const readSource=async(a:LearningAttempt):Promise<MathStudySource|null>=>{
            const item=await original.readItem(scope,a.binding);
            if(!item||item.kind!=='practice'||item.practice.questionType!=='calculation')return null;
            const support=resolveCalculationReferenceSupport(item.learningSupport,item.practice.answer);
            if(!support)return null;
            const approved=await mapping?.resolveMapping(scope,a.binding);
            return {binding:a.binding,question:item.practice.prompt,answer:typeof item.practice.answer==='number'?String(item.practice.answer):item.practice.answer??'',support,...(approved?{mapping:approved}:{})};
        };
        let approvedDiagnostic:PracticeEvidenceDiagnostic|null=null,approvedAttempt:LearningAttempt|null=null;
        let saved:PracticeEvidenceV1|null=null;
        const store=await context.deps.getPracticeEvidenceStore?.({resolveModelDiagnostic:async input=>
            approvedDiagnostic&&approvedAttempt&&evidenceEqual(input.attempt.binding,approvedAttempt.binding)&&input.attempt.submitted?.answer===approvedAttempt.submitted?.answer
                &&input.attempt.submitted?.answerRevision===approvedAttempt.submitted?.answerRevision&&evidenceEqual(input.diagnostic,approvedDiagnostic)?approvedDiagnostic:null});
        if(!store||!await store.supported())throw new AccountFailure(409,'practice-evidence-unsupported');
        const engine=createMathStudyEvaluator({readAttempt,readSource,readEvidence:id=>store.read(scope,id),
            saveDiagnostic:async(d,a)=>{
                if(signal.aborted)throw Error('math-evaluation-cancelled');
                const current=await store.read(scope,a.attemptId);
                if(evidenceEqual(current?.calculation?.diagnostic,d)){saved=current;return;}
                // Formal answers may resolve a pending optional step; unavailable diagnostics never change it.
                if(a.formal&&d.status==='undetermined'){saved=current;return;}
                const operationId=`ms:${await studyHash([body.requestId,d])}`;
                let receipt;
                try{receipt=await store.trustedWriter().mutate(scope,{schemaVersion:1,kind:'step-diagnostic',operationId,attemptId:a.attemptId,binding:a.binding,
                    expectedRevision:current?.revision??0,updatedAt:context.deps.now().toISOString(),diagnostic:d});}
                catch{throw new AccountFailure(503,'math-evidence-receipt-unknown');}
                if(!receipt.durable||receipt.status==='conflict'||!receipt.record)throw Error('math-evidence-conflict');
                saved=receipt.record;
            },semanticStep:async input=>{
                const step=input.source.support.schemaVersion===2?input.source.support.step:undefined;
                if(!step||step.mode!=='semantic')throw Error('math-step-source-binding');
                if(request!.mode!=='step')return {answerRevision:request!.answerRevision,stepRevision:input.stepRevision,stepId:step.stepId,sourceVersion:input.attempt.binding.contentHash,
                    status:'undetermined',source:'none',explanation:'步骤已保存；可按需请求语义核对。'};
                const frozen={attemptId:input.attempt.attemptId,binding:input.attempt.binding,answer:input.attempt.submitted!.answer,answerRevision:request!.answerRevision,
                    source:input.source,stepText:input.text,stepRevision:input.stepRevision};
                const diagnostic=await controlledPracticeAi({context,scope,requestId:body.requestId as string,kind:'math-step',input:frozen,signal,validate:raw=>{
                    const row=studyObject(raw,['diagnostic','evidence']);
                    const d=parsePracticeEvidenceDiagnostic(row.diagnostic);
                    if(d.source!=='model'||d.answerRevision!==request!.answerRevision||d.stepRevision!==input.stepRevision||d.stepId!==step.stepId
                        ||d.sourceVersion!==input.attempt.binding.contentHash||!d.explanation.trim())throw Error('practice-ai-output-invalid');
                    if(d.status!=='undetermined'){
                        const e=studyObject(row.evidence,['sourceQuote','answerQuote','reason']);
                        if(typeof e.sourceQuote!=='string'||!e.sourceQuote.trim()||!step.reference.includes(e.sourceQuote)||typeof e.answerQuote!=='string'||!e.answerQuote.trim()
                            ||!input.text.includes(e.answerQuote)||typeof e.reason!=='string'||!e.reason.trim()||e.reason.length>2000)throw Error('practice-ai-output-invalid');
                        if(d.status==='incorrect'&&step.reference.trim()===input.text.trim())throw Error('practice-ai-output-invalid');
                    }else if(row.evidence!==null)throw Error('practice-ai-output-invalid');
                    return d;
                }});
                if(!diagnostic)return {answerRevision:request!.answerRevision,stepRevision:input.stepRevision,stepId:step.stepId,sourceVersion:input.attempt.binding.contentHash,
                    status:'undetermined',source:'none',explanation:'AI暂不可用，此步骤已保存待核对。'};
                approvedDiagnostic=diagnostic;approvedAttempt=input.attempt;return diagnostic;
            }});
        if(variant){
            const rebuilt=await engine.variant(body.attemptId as string,body.seed as number);
            if(!rebuilt)return {kind:'value',status:200,value:{status:'unavailable'}};
            const a=await readAttempt(body.attemptId as string),source=a&&await readSource(a);
            if(!source?.mapping)throw Error('math-variant-source-binding');
            const descriptor={schemaVersion:1,mappingId:source.mapping.mappingId,...rebuilt.parent,templateVersion:1,templateId:rebuilt.templateId,seed:rebuilt.seed,parameters:rebuilt.parameters,variantHash:rebuilt.variantHash};
            return {kind:'value',status:200,value:{status:'available',variant:rebuilt,descriptor,mapping:source.mapping}};
        }
        const result=await engine.evaluate(request!,signal);
        const evidence=saved??await store.read(scope,request!.attemptId);
        return {kind:'value',status:200,value:{...result,...(evidence?{evidence}:{})}};
    }catch(error){
        if(error instanceof AccountFailure)throw error;
        const code=error instanceof Error?error.message:'';
        if(code==='practice-ai-receipt-unknown')throw new AccountFailure(503,code);
        if(/^(math-|practice-|invalid-calculation)/.test(code))throw new AccountFailure(409,code);
        throw new AccountFailure(400,'invalid-math-study-request');
    }
}
