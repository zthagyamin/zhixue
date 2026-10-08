import type {LearningAttempt} from '../learning-attempt';
import type {PracticeEvidenceDiagnostic,PracticeVariantRecoveryV1} from '../practice-evidence';
import type {NativeMathCapture,NativeMathIdentity} from './native-source';
import type {NativeMathMappingRecord,NativePreparedMathVariant} from './native-mapping';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseNativeMathIdentity,assertNativeMathCaptureBinding} from './native-source.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseAttemptBinding,parseAttemptEvaluation,canonicalAttemptJson} from '../learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject,studyId,studyDigest,studyCount,studyText,studyHash,studySize} from '../sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parsePracticeEvidenceDiagnostic,parsePracticeVariantRecovery,validatePracticeEvidenceTree} from '../practice-evidence/index.ts';

export type NativeMathClaim={schemaVersion:1;identity:NativeMathIdentity;captureId:string;attempt:LearningAttempt;
    stepInput?:{text:string;revision:number;answerRevision:number};variant?:PracticeVariantRecoveryV1};
export type NativeMathRequest={schemaVersion:1;requestId:string;attemptId:string;answerRevision:number;sourceVersion:string;mode:'final'|'step';stepRevision?:number};
export type NativeMathFinal={status:'correct'|'incorrect'|'undetermined';source:'deterministic';explanation:string};
export type NativeMathReceipt={schemaVersion:1;durable:true;requestId:string;attemptId:string;answerRevision:number;sourceVersion:string;
    final?:NativeMathFinal;step?:PracticeEvidenceDiagnostic;capability?:{variant?:'available'|'unavailable';semanticStep?:'available'|'pending';reason?:string};receiptHash:string};
export type NativeMathFormal={schemaVersion:1;action:'formal';attemptId:string;answerRevision:number;sourceVersion:string;eventId:string;evaluationHash:string;occurredAt:string;coreHash?:string};
export type NativeMathRead={schemaVersion:1;durable:true;claim:NativeMathClaim;results:NativeMathReceipt[];formalBarrier:NativeMathFormal|null};
export type NativeMathTransport={supported:()=>boolean;variantSupported?:()=>boolean;
    mapping?:(capture:NativeMathCapture,signal?:AbortSignal)=>Promise<NativeMathMappingRecord|null>;
    variant?:(capture:NativeMathCapture,attemptId:string,seed:number,approved:NativeMathMappingRecord,signal?:AbortSignal)=>Promise<NativePreparedMathVariant|null>;
    capture:(identity:NativeMathIdentity,signal?:AbortSignal)=>Promise<NativeMathCapture>;
    read:(identity:NativeMathIdentity,captureId:string,signal?:AbortSignal)=>Promise<NativeMathCapture>;
    claim:(request:NativeMathClaim,signal?:AbortSignal)=>Promise<{schemaVersion:1;durable:true;attemptId:string;answerRevision:number;captureId:string;claimHash:string}>;
    evaluate:(request:NativeMathRequest,signal?:AbortSignal)=>Promise<NativeMathReceipt>;
    recover:(attemptId:string,requestId?:string,signal?:AbortSignal)=>Promise<NativeMathRead>;
    formal:(request:NativeMathFormal,signal?:AbortSignal)=>Promise<{schemaVersion:1;durable:true;status:'barrier-saved';attemptId:string;eventId:string;claimHash:string}>};
const same=(a:unknown,b:unknown)=>canonicalAttemptJson(a)===canonicalAttemptJson(b);
function time(raw:unknown):void{if(typeof raw!=='string'||raw.length>64||!Number.isFinite(Date.parse(raw)))throw Error('native-math-time');}
export function parseNativeMathClaim(raw:unknown):NativeMathClaim{
    validatePracticeEvidenceTree(raw);studySize(raw,150000);
    const r=studyObject(raw,['schemaVersion','identity','captureId','attempt'],['stepInput','variant']);
    if(r.schemaVersion!==1)throw Error('native-math-claim-version');studyDigest(r.captureId);
    const identity=parseNativeMathIdentity(r.identity),a=studyObject(r.attempt,['schemaVersion','attemptId','binding','parentAttemptId','revision','answerRevision','answer','updatedAt','checkpoint','submitted','evaluation','formal','operations'],['startedAt']);
    const binding=parseAttemptBinding(a.binding),s=studyObject(a.submitted,['answer','answerRevision','submittedAt','assistance'],['maxPreHintLevel','answerRevealed']);
    const checkpoint=a.checkpoint as LearningAttempt['checkpoint'];
    studyId(a.attemptId);studyCount(a.revision,'revision');studyCount(a.answerRevision,'answer-revision');studyText(a.answer,'math-answer',32000,true);
    time(a.updatedAt);time(s.submittedAt);if(a.startedAt!==undefined)time(a.startedAt);
    studyText(s.answer,'math-answer',32000,true);studyCount(s.answerRevision,'answer-revision');
    if(a.schemaVersion!==1||a.formal!==null||!Array.isArray(a.operations)||!checkpoint||checkpoint.mode!=='calculation'
        ||!['first','guided','remediation'].includes(checkpoint.purpose??'first')||s.answer!==a.answer||s.answerRevision!==a.answerRevision
        ||!['independent','observed','unknown'].includes(String(s.assistance)))throw Error('native-math-claim-binding');
    if(a.parentAttemptId!==null){studyId(a.parentAttemptId);if(a.parentAttemptId===a.attemptId||checkpoint.purpose!=='remediation')throw Error('native-math-parent-binding');}
    if(s.maxPreHintLevel!==undefined){studyCount(s.maxPreHintLevel,'hint-level');if(s.maxPreHintLevel>3)throw Error('native-math-assistance');}
    if(s.answerRevealed!==undefined&&typeof s.answerRevealed!=='boolean')throw Error('native-math-assistance');
    parseAttemptEvaluation(a.evaluation);assertNativeMathCaptureBinding({identity} as NativeMathCapture,binding);
    if(r.stepInput!==undefined){const step=studyObject(r.stepInput,['text','revision','answerRevision']);studyText(step.text,'math-step-text',32000,true);
        studyCount(step.revision,'step-revision',1);if(step.answerRevision!==s.answerRevision)throw Error('native-math-step-revision-binding');}
    if(r.variant!==undefined){const v=parsePracticeVariantRecovery(r.variant);if(v.hashKind!=='content'||v.parentItemKey!==identity.itemKey||v.parentContentHash!==identity.contentHash
        ||!a.parentAttemptId||checkpoint.purpose!=='remediation'||r.stepInput!==undefined)throw Error('native-math-variant-binding');
        let input;try{input=JSON.parse(s.answer);}catch{throw Error('native-math-variant-answer-format');}
        const values=studyObject(input,['answerKind','answer']);studyText(values.answerKind,'math-answer-kind',128);studyText(values.answer,'math-answer',32000,true);
    }
    return structuredClone({...r,identity,attempt:{...a,binding}}) as NativeMathClaim;
}
export function nativeMathLogicalClaim(raw:NativeMathClaim):unknown{
    const r=parseNativeMathClaim(raw),a=r.attempt;
    return {schemaVersion:1,identity:r.identity,captureId:r.captureId,attempt:{schemaVersion:1,attemptId:a.attemptId,binding:a.binding,parentAttemptId:a.parentAttemptId,submitted:a.submitted},
        purpose:a.checkpoint.purpose??'first',...(r.stepInput?{stepInput:r.stepInput}:{}),...(r.variant?{variant:r.variant}:{})};
}
export const nativeMathClaimHash=(claim:NativeMathClaim)=>studyHash(nativeMathLogicalClaim(claim));
export function parseNativeMathRequest(raw:unknown):NativeMathRequest{
    validatePracticeEvidenceTree(raw);const r=studyObject(raw,['schemaVersion','requestId','attemptId','answerRevision','sourceVersion','mode'],['stepRevision']);
    if(r.schemaVersion!==1||!['final','step'].includes(String(r.mode)))throw Error('native-math-request');
    studyId(r.requestId);studyId(r.attemptId);studyCount(r.answerRevision,'answer-revision');studyDigest(r.sourceVersion);
    if(r.stepRevision!==undefined)studyCount(r.stepRevision,'step-revision',1);
    return structuredClone(r) as NativeMathRequest;
}
export async function parseNativeMathReceipt(raw:unknown):Promise<NativeMathReceipt>{
    validatePracticeEvidenceTree(raw);studySize(raw,128000);
    const r=studyObject(raw,['schemaVersion','durable','requestId','attemptId','answerRevision','sourceVersion','receiptHash'],['final','step','capability']);
    if(r.schemaVersion!==1||r.durable!==true)throw Error('native-math-receipt');
    studyId(r.requestId);studyId(r.attemptId);studyCount(r.answerRevision,'answer-revision');studyDigest(r.sourceVersion);studyDigest(r.receiptHash);
    if(r.final!==undefined){const f=studyObject(r.final,['status','source','explanation']);if(!['correct','incorrect','undetermined'].includes(String(f.status))||f.source!=='deterministic')throw Error('native-math-final');studyText(f.explanation,'math-final',4000);}
    if(r.step!==undefined){const s=parsePracticeEvidenceDiagnostic(r.step);if(s.answerRevision!==r.answerRevision||s.sourceVersion!==r.sourceVersion||!s.explanation.trim())throw Error('native-math-step-binding');}
    if(r.capability!==undefined){const c=studyObject(r.capability,[],['variant','semanticStep','reason']);
        if(c.variant!==undefined&&!['available','unavailable'].includes(String(c.variant))||c.semanticStep!==undefined&&!['available','pending'].includes(String(c.semanticStep)))throw Error('native-math-capability');
        if(c.reason!==undefined)studyText(c.reason,'math-capability',200);}
    const {receiptHash,...body}=r;if(await studyHash(body)!==receiptHash)throw Error('native-math-receipt-integrity');
    return structuredClone(r) as NativeMathReceipt;
}
export async function validateNativeMathReceipt(raw:unknown,request:NativeMathRequest,claim:NativeMathClaim,capture:NativeMathCapture):Promise<NativeMathReceipt>{
    const r=await parseNativeMathReceipt(raw),q=parseNativeMathRequest(request),c=parseNativeMathClaim(claim);
    if(c.captureId!==capture.captureId||!same(c.identity,capture.identity)||q.attemptId!==c.attempt.attemptId||q.answerRevision!==c.attempt.submitted!.answerRevision
        ||q.sourceVersion!==c.identity.contentHash||r.requestId!==q.requestId||r.attemptId!==q.attemptId||r.answerRevision!==q.answerRevision||r.sourceVersion!==q.sourceVersion
        ||q.mode==='step'&&r.final!==undefined||q.mode==='final'&&(!r.final||r.step?.source==='model'))throw Error('native-math-result-binding');
    if(r.step){const support=capture.item.learningSupport,step=support?.schemaVersion===2?support.step:undefined;
        if(!step||!c.stepInput||r.step.stepId!==step.stepId||r.step.stepRevision!==c.stepInput.revision||q.stepRevision!==undefined&&q.stepRevision!==c.stepInput.revision)throw Error('native-math-step-binding');}
    if(c.variant&&r.final?.status!=='undetermined'&&r.capability?.variant!=='available')throw Error('native-math-variant-capability');
    return r;
}
export function parseNativeMathFormal(raw:unknown):NativeMathFormal{
    const r=studyObject(raw,['schemaVersion','action','attemptId','answerRevision','sourceVersion','eventId','evaluationHash','occurredAt'],['coreHash']);
    if(r.schemaVersion!==1||r.action!=='formal')throw Error('native-math-formal');studyId(r.attemptId);studyId(r.eventId);studyCount(r.answerRevision,'answer-revision');
    studyDigest(r.sourceVersion);studyDigest(r.evaluationHash);if(r.coreHash!==undefined)studyDigest(r.coreHash);time(r.occurredAt);
    return structuredClone(r) as NativeMathFormal;
}
