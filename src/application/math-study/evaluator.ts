import type {AttemptBinding,LearningAttempt} from '../../domain/learning-attempt';
import type {CalculationSupport} from '../../domain/content';
import type {PracticeEvidenceV1,PracticeEvidenceDiagnostic} from '../../domain/practice-evidence';
import type {MathVariantMappingV1,MathVariant} from '../../domain/guided-math';
// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalAttemptJson} from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseCalculationSupport} from '../../domain/content/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {compareExpressions,numericEquivalent} from '../../domain/math/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {gradeCalculationStep} from '../../domain/math-step/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createMappedMathVariant,evaluateMathVariant} from '../../domain/guided-math/index.ts';

export type MathStudyRequestV1={schemaVersion:1;attemptId:string;answerRevision:number;sourceVersion:string;
    mode:'final'|'step';stepRevision?:number};
export type MathStudySource={binding:AttemptBinding;question:string;answer:string;support:CalculationSupport;
    mapping?:MathVariantMappingV1};
export type MathStudyOutcome={status:'correct'|'incorrect'|'undetermined';source:'deterministic';explanation:string};
export type MathStudyResultV1={schemaVersion:1;attemptId:string;answerRevision:number;sourceVersion:string;
    final?:MathStudyOutcome;step?:PracticeEvidenceDiagnostic;evidence?:PracticeEvidenceV1};
type Ports={
    readAttempt:(id:string)=>Promise<LearningAttempt|null>;
    readSource:(attempt:LearningAttempt)=>Promise<MathStudySource|null>;
    readEvidence:(id:string)=>Promise<PracticeEvidenceV1|null>;
    saveDiagnostic:(diagnostic:PracticeEvidenceDiagnostic,attempt:LearningAttempt)=>Promise<void>;
    semanticStep?:(input:{attempt:LearningAttempt;source:MathStudySource;text:string;stepRevision:number},signal?:AbortSignal)=>Promise<PracticeEvidenceDiagnostic>;
};
export function parseMathStudyRequest(raw:unknown):MathStudyRequestV1{
    validatePracticeEvidenceTree(raw);
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||![Object.prototype,null].includes(Object.getPrototypeOf(raw)))throw Error('invalid-math-request');
    const r=raw as Record<string,unknown>,keys=['schemaVersion','attemptId','answerRevision','sourceVersion','mode','stepRevision'];
    if(['schemaVersion','attemptId','answerRevision','sourceVersion','mode'].some(key=>!Object.hasOwn(r,key))||Object.keys(r).some(key=>!keys.includes(key))||r.schemaVersion!==1||typeof r.attemptId!=='string'||!r.attemptId||r.attemptId.length>200
        ||typeof r.sourceVersion!=='string'||!/^[a-f0-9]{64}$/.test(r.sourceVersion)||!Number.isSafeInteger(r.answerRevision)||(r.answerRevision as number)<0
        ||!['final','step'].includes(String(r.mode))||r.stepRevision!==undefined&&(!Number.isSafeInteger(r.stepRevision)||(r.stepRevision as number)<1))throw Error('invalid-math-request');
    return r as MathStudyRequestV1;
}
// @ts-expect-error TS5097: standalone Node contracts.
import {parsePracticeEvidenceDiagnostic,parsePracticeEvidence,validatePracticeEvidenceTree} from '../../domain/practice-evidence/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject} from '../../domain/sync/index.ts';
const same=(a:unknown,b:unknown)=>canonicalAttemptJson(a)===canonicalAttemptJson(b);
const outcome=(status:MathStudyOutcome['status'],explanation:string):MathStudyOutcome=>({status,source:'deterministic',explanation});
function gradeFinal(source:MathStudySource,answer:string):MathStudyOutcome{
    const support=parseCalculationSupport(source.support);
    if(!answer.trim()||!source.answer.trim())return outcome('undetermined','答案或来源参考不足，保留待核对。');
    if(support.mode==='numeric'){
        const correct=numericEquivalent(answer,source.answer,support.tolerance??'0.000001');
        return outcome(correct===null?'undetermined':correct?'correct':'incorrect',correct===null?'当前数值格式不能可靠核对。':correct?'最终结果与来源参考一致。':`你的结果：${answer}；参考结果：${source.answer}。`);
    }
    const result=compareExpressions(answer,source.answer,support.variables);
    if(support.schemaVersion===2&&support.conditions?.length&&result.verdict==='wrong')return outcome('undetermined','当前内核不能核对这些附加条件下的表达式差异。');
    return outcome(result.verdict==='correct'?'correct':result.verdict==='wrong'?'incorrect':'undetermined',result.explanation);
}
/** Source and learner inputs come from authenticated saved records, never request references. */
export function createMathStudyEvaluator(ports:Ports){
    async function evaluate(raw:unknown,signal?:AbortSignal):Promise<MathStudyResultV1>{
        const r=parseMathStudyRequest(raw),attemptRead=await ports.readAttempt(r.attemptId),attempt=attemptRead?structuredClone(attemptRead):null;
        if(!attempt?.submitted||attempt.attemptId!==r.attemptId||attempt.checkpoint.mode!=='calculation'||attempt.submitted.answerRevision!==r.answerRevision
            ||attempt.binding.contentHash!==r.sourceVersion)throw Error('math-evaluation-binding');
        if(r.mode==='final'&&attempt.formal)throw Error('math-formal-existing-result');
        const sourceRead=await ports.readSource(attempt),source=sourceRead?structuredClone(sourceRead):null;
        if(!source||!same(source.binding,attempt.binding))throw Error('math-original-source-unavailable');
        const support=parseCalculationSupport(source.support),evidenceRead=await ports.readEvidence(attempt.attemptId),evidence=evidenceRead?structuredClone(evidenceRead):null;
        if(evidence&&(evidence.attemptId!==attempt.attemptId||!same(evidence.binding,attempt.binding)))throw Error('math-evidence-source-binding');
        const result:MathStudyResultV1={schemaVersion:1,attemptId:attempt.attemptId,answerRevision:r.answerRevision,sourceVersion:r.sourceVersion};
        if(signal?.aborted)throw Error('math-evaluation-cancelled');
        if(evidence?.variant){
            if(r.mode==='step')throw Error('math-variant-step-unavailable');
            if(attempt.checkpoint.purpose!=='remediation'||!attempt.parentAttemptId)throw Error('math-variant-parent-required');
            const parent=await ports.readAttempt(attempt.parentAttemptId);
            if(!parent?.submitted||parent.attemptId!==attempt.parentAttemptId||parent.checkpoint.mode!=='calculation'
                ||!same(parent.binding,attempt.binding))throw Error('math-variant-parent-binding');
            const descriptor=evidence.variant;
            const mapped=await createMappedMathVariant({parent:{parentItemKey:attempt.binding.itemKey,parentContentHash:attempt.binding.contentHash,hashKind:descriptor.hashKind},
                support,mapping:source.mapping,seed:descriptor.seed});
            if(mapped.status!=='available'||mapped.mappingId!==descriptor.mappingId||mapped.variant.variantHash!==descriptor.variantHash
                ||mapped.variant.templateId!==descriptor.templateId||descriptor.templateVersion!==1||descriptor.parentItemKey!==attempt.binding.itemKey
                ||descriptor.parentContentHash!==attempt.binding.contentHash||!same(mapped.variant.parameters,descriptor.parameters))throw Error('math-variant-source-binding');
            let input:{answerKind:string;answer:string};
            try{const rawInput=JSON.parse(attempt.submitted.answer);if(!rawInput||Object.keys(rawInput).some(key=>!['answerKind','answer'].includes(key))
                ||typeof rawInput.answerKind!=='string'||typeof rawInput.answer!=='string')throw Error();input=rawInput;}
            catch{throw Error('math-variant-answer-format');}
            const checked=evaluateMathVariant(mapped.variant,input).final;
            result.final=outcome(checked.verdict==='correct'?'correct':checked.verdict==='wrong'?'incorrect':'undetermined',checked.explanation);
            return result;
        }
        if(r.mode==='final')result.final=gradeFinal(source,attempt.submitted.answer);
        const input=evidence?.calculation?.stepInput;
        if(input?.text.trim()&&support.schemaVersion===2&&support.step){
            if(r.stepRevision!==undefined&&r.stepRevision!==input.revision)throw Error('math-step-revision-binding');
            const old=evidence?.calculation?.diagnostic;
            if(old&&(old.answerRevision!==r.answerRevision||old.stepRevision!==input.revision||old.stepId!==support.step.stepId||old.sourceVersion!==r.sourceVersion))throw Error('math-diagnostic-binding');
            if(old&&old.status!=='undetermined')result.step=parsePracticeEvidenceDiagnostic(old);
            else{
                const checked=gradeCalculationStep(input.text,support);
                let diagnostic:PracticeEvidenceDiagnostic={...checked,answerRevision:r.answerRevision,stepRevision:input.revision,stepId:support.step.stepId,sourceVersion:r.sourceVersion};
                if(support.step.mode==='semantic'&&ports.semanticStep){
                    try{diagnostic=await ports.semanticStep({attempt,source,text:input.text,stepRevision:input.revision},signal);}
                    catch(error){if(error instanceof Error&&/binding|receipt-unknown|cancelled|request-pending/.test(error.message))throw error;diagnostic={...diagnostic,source:'none',explanation:'AI暂不可用，此步骤已保存待核对。'};}
                }
                diagnostic=parsePracticeEvidenceDiagnostic(diagnostic);
                if(!diagnostic.explanation.trim())throw Error('math-diagnostic-binding');
                if(diagnostic.answerRevision!==r.answerRevision||diagnostic.stepRevision!==input.revision||diagnostic.stepId!==support.step.stepId
                    ||diagnostic.sourceVersion!==r.sourceVersion||!['correct','incorrect','undetermined'].includes(diagnostic.status))throw Error('math-diagnostic-binding');
                if(signal?.aborted)throw Error('math-evaluation-cancelled');
                const latest=await ports.readAttempt(attempt.attemptId),latestEvidence=await ports.readEvidence(attempt.attemptId),latestSource=latest&&await ports.readSource(latest);
                if(!same(latestEvidence?.calculation?.stepInput,input)||!same(latestSource,source))throw Error('math-step-input-binding');
                if(!latest?.submitted||!same(latest.binding,attempt.binding)||latest.submitted.answerRevision!==r.answerRevision||latest.submitted.answer!==attempt.submitted.answer
                    ||r.mode==='final'&&latest.formal)throw Error('math-evaluation-binding');
                try{await ports.saveDiagnostic(diagnostic,latest);result.step=diagnostic;}
                catch(error){
                    const code=error instanceof Error?error.message:'';
                    if(r.mode!=='final'||!result.final||result.final.status==='undetermined'
                        ||/binding|source|conflict|cancel|invalid/.test(code)||signal?.aborted)throw error;
                    const current=await ports.readAttempt(attempt.attemptId),currentEvidence=await ports.readEvidence(attempt.attemptId);
                    const currentSource=current&&await ports.readSource(current);
                    if(!current?.submitted||current.formal||!same(current.binding,attempt.binding)||!same(current.submitted,attempt.submitted)
                        ||!same(currentSource,source)||!same(currentEvidence?.calculation?.stepInput,input))throw Error('math-evaluation-binding');
                    result.step=same(currentEvidence?.calculation?.diagnostic,diagnostic)?diagnostic:
                        {...diagnostic,status:'undetermined',source:'none',explanation:'步骤反馈尚未确认保存，原步骤保留，可稍后核对。'};
                }
            }
        }else if(r.mode==='step'&&input?.text.trim())throw Error('math-step-source-unavailable');
        return result;
    }
    async function variant(id:string,seed:number):Promise<MathVariant|null>{
        const a=await ports.readAttempt(id);if(!a||a.checkpoint.mode!=='calculation')throw Error('math-variant-attempt-binding');
        const source=await ports.readSource(a);if(!source||!same(source.binding,a.binding))throw Error('math-original-source-unavailable');
        const mapped=await createMappedMathVariant({parent:{parentItemKey:a.binding.itemKey,parentContentHash:a.binding.contentHash,hashKind:'content'},support:source.support,mapping:source.mapping,seed});
        return mapped.status==='available'?mapped.variant:null;
    }
    return {evaluate,variant};
}
export {evaluateMathVariant};

export function parseMathStudyResult(raw:unknown,request?:MathStudyRequestV1):MathStudyResultV1{
    validatePracticeEvidenceTree(raw);
    if(new TextEncoder().encode(JSON.stringify(raw)).byteLength>128000)throw Error('invalid-math-result');
    const r=studyObject(raw,['schemaVersion','attemptId','answerRevision','sourceVersion'],['final','step','evidence']);
    parseMathStudyRequest({schemaVersion:r.schemaVersion,attemptId:r.attemptId,answerRevision:r.answerRevision,sourceVersion:r.sourceVersion,mode:'final'});
    if(request&&(r.attemptId!==request.attemptId||r.answerRevision!==request.answerRevision||r.sourceVersion!==request.sourceVersion||request.mode==='step'&&r.final!==undefined))throw Error('invalid-math-result-binding');
    if(r.evidence!==undefined){const e=parsePracticeEvidence(r.evidence);if(e.attemptId!==r.attemptId||e.binding.contentHash!==r.sourceVersion)throw Error('invalid-math-result-binding');}
    if(request?.mode==='final'&&r.final===undefined)throw Error('invalid-math-result-binding');
    if(r.final!==undefined){
        const f=studyObject(r.final,['status','source','explanation']);
        if(!['correct','incorrect','undetermined'].includes(String(f.status))||f.source!=='deterministic'||typeof f.explanation!=='string'||!f.explanation.trim()||f.explanation.length>4000)throw Error('invalid-math-result');
    }
    if(r.step!==undefined){const d=parsePracticeEvidenceDiagnostic(r.step);if(d.answerRevision!==r.answerRevision||d.sourceVersion!==r.sourceVersion||request?.stepRevision!==undefined&&d.stepRevision!==request.stepRevision)throw Error('invalid-math-result');}
    return r as MathStudyResultV1;
}
