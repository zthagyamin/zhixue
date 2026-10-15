// @ts-expect-error TS5097: standalone Node contracts.
import {sourceAdmissionFields,sourceAdmissionId,sourceAdmissionHash,sourceAdmissionCaptureId,sourceAdmissionTime,parseSourceAdmissionBinding} from './fields.ts';
// @ts-expect-error TS5097: standalone Node contracts.
export {sourceAdmissionFields,sourceAdmissionId,sourceAdmissionHash,sourceAdmissionCaptureId,sourceAdmissionTime,parseSourceAdmissionBinding} from './fields.ts';
import type {SourceAdmissionBinding,SourceAdmissionQuery,SourceAdmissionSubmission,SourceAdmissionOriginalAttempt,
    SourceAdmissionCapture,SourceAdmissionSubmitReceipt,SourceAdmissionConfirmation,SourceAdmissionEvaluation,
    SourceAdmissionClaimRequest,SourceAdmissionClaimReceipt,SourceAdmissionReadReceipt,SourceSelfAssessment,SourceSelfAssessmentReceipt} from './types';
// @ts-expect-error TS5097: standalone Node contracts.
import {sameSourceAdmission} from './json.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseSourceCodeReports} from './code-report.ts';
function count(raw:unknown):void{if(typeof raw!=='number'||!Number.isSafeInteger(raw)||raw<0)throw Error('source-admission-revision');}
function code(raw:unknown):void{if(typeof raw!=='string'||raw.length>120||!/^[a-z][a-z0-9-]*$/u.test(raw))throw Error('source-admission-receipt');}
function version(raw:Record<string,unknown>,status?:string,durable=true):void{
    if(raw.schemaVersion!==1||durable&&raw.durable!==true||status&&raw.status!==status)throw Error('source-admission-receipt');
}
export function parseSourceAdmissionQuery(raw:unknown):SourceAdmissionQuery {
    const r=sourceAdmissionFields(raw,['itemKey','contentHash','presentation'],['sourceItemKey']);
    sourceAdmissionId(r.itemKey);sourceAdmissionHash(r.contentHash);if(r.sourceItemKey!==undefined)sourceAdmissionId(r.sourceItemKey);
    if(!r.presentation||typeof r.presentation!=='object'||Array.isArray(r.presentation)||!Object.keys(r.presentation).length)
        throw Error('source-admission-presentation');return r as SourceAdmissionQuery;
}
const metadata=['purpose','parentAttemptId','assistance','maxPreHintLevel','answerRevealed'] as const;
function parseMetadata(r:Record<string,unknown>):void {
    if(r.purpose!==undefined&&!['first','guided','remediation','unknown'].includes(String(r.purpose)))throw Error('source-admission-purpose');
    if(r.parentAttemptId!==undefined&&r.parentAttemptId!==null)sourceAdmissionId(r.parentAttemptId);
    if(r.purpose==='first'&&r.parentAttemptId!=null||r.purpose==='remediation'&&r.parentAttemptId==null
        ||r.parentAttemptId===r.attemptId)throw Error('source-admission-purpose');
    if(r.assistance!==undefined&&!['independent','observed','unknown'].includes(String(r.assistance)))throw Error('source-admission-assistance');
    if(r.maxPreHintLevel!==undefined&&(!Number.isInteger(r.maxPreHintLevel)||Number(r.maxPreHintLevel)<0||Number(r.maxPreHintLevel)>3)
        ||r.answerRevealed!==undefined&&typeof r.answerRevealed!=='boolean')throw Error('source-admission-assistance');
}
export function parseSourceAdmissionSubmission(raw:unknown):SourceAdmissionSubmission {
    const r=sourceAdmissionFields(raw,['attemptId','binding','answerRevision','answer','submittedAt'],metadata);
    sourceAdmissionId(r.attemptId);r.binding=parseSourceAdmissionBinding(r.binding);count(r.answerRevision);
    sourceAdmissionTime(r.submittedAt);parseMetadata(r);
    if(new TextEncoder().encode(JSON.stringify(r.answer)).byteLength>64000)throw Error('source-admission-answer-size');
    return r as SourceAdmissionSubmission;
}
export function parseSourceAdmissionOriginalAttempt(raw:unknown):SourceAdmissionOriginalAttempt {
    const r=sourceAdmissionFields(raw,['attemptId','itemKey','contentHash','libraryId','answerRevision','answer','submittedAt'],metadata);
    for(const key of ['attemptId','itemKey','libraryId'])sourceAdmissionId(r[key]);
    sourceAdmissionHash(r.contentHash);count(r.answerRevision);sourceAdmissionTime(r.submittedAt);parseMetadata(r);
    return r as SourceAdmissionOriginalAttempt;
}
export function parseSourceAdmissionCapture(raw:unknown):SourceAdmissionCapture {
    const status=(raw as {status?:unknown})?.status;
    const r=sourceAdmissionFields(raw,['schemaVersion','status','durable','captureId','binding','originalBinding',
        ...(status==='pending'?['reason']:status==='confirmed'?['item','sourceBinding','eventKind']:[])]);
    version(r);if(!['pending','confirmed'].includes(String(status)))throw Error('source-admission-receipt');
    sourceAdmissionCaptureId(r.captureId);r.binding=parseSourceAdmissionBinding(r.binding);r.originalBinding=parseSourceAdmissionBinding(r.originalBinding);
    if(!sameSourceAdmission(r.binding,r.originalBinding)||(r.binding as SourceAdmissionBinding).captureId!==r.captureId)throw Error('source-admission-receipt-binding');
    if(status==='pending')code(r.reason);else{
        r.sourceBinding=parseSourceAdmissionBinding(r.sourceBinding);
        if((r.sourceBinding as SourceAdmissionBinding).captureId!==r.captureId||!['due','python'].includes(String(r.eventKind))
            ||!r.item||typeof r.item!=='object'||Array.isArray(r.item))throw Error('source-admission-receipt-binding');
    }return r as SourceAdmissionCapture;
}
export function parseSourceAdmissionSubmitReceipt(raw:unknown):SourceAdmissionSubmitReceipt {
    const r=sourceAdmissionFields(raw,['schemaVersion','status','durable','attemptId','answerRevision','submissionHash','submittedAt','savedAt']);
    version(r,'saved');sourceAdmissionId(r.attemptId);count(r.answerRevision);sourceAdmissionHash(r.submissionHash);
    sourceAdmissionTime(r.submittedAt);sourceAdmissionTime(r.savedAt,false);return r as SourceAdmissionSubmitReceipt;
}
export function parseSourceAdmissionConfirmation(raw:unknown):SourceAdmissionConfirmation {
    const r=sourceAdmissionFields(raw,['schemaVersion','status','durable','attemptId','binding','sourceBinding','sourceCaptureId']);
    version(r,'confirmed');sourceAdmissionId(r.attemptId);r.binding=parseSourceAdmissionBinding(r.binding);
    r.sourceBinding=parseSourceAdmissionBinding(r.sourceBinding);sourceAdmissionCaptureId(r.sourceCaptureId);
    if((r.sourceBinding as SourceAdmissionBinding).captureId!==r.sourceCaptureId)throw Error('source-admission-receipt-binding');
    return r as SourceAdmissionConfirmation;
}
export function parseSourceAdmissionEvaluation(raw:unknown):SourceAdmissionEvaluation {
    const status=(raw as {status?:unknown})?.status;
    const r=sourceAdmissionFields(raw,['schemaVersion','durable','requestId','attemptId','binding','sourceBinding','sourceCaptureId',
        'answerRevision','answerHash','evaluationHash','status',...(status==='pending'?['reason']:status==='resolved'?['correct','outcome','explanation']:[])],status==='resolved'?['selfAssessment']:[]);
    version(r,undefined,false);if(typeof r.durable!=='boolean'||!['pending','resolved'].includes(String(status)))throw Error('source-admission-receipt');
    sourceAdmissionId(r.requestId);sourceAdmissionId(r.attemptId);count(r.answerRevision);sourceAdmissionHash(r.answerHash);
    sourceAdmissionHash(r.evaluationHash);sourceAdmissionCaptureId(r.sourceCaptureId);r.binding=parseSourceAdmissionBinding(r.binding);
    if(r.sourceBinding!==null)r.sourceBinding=parseSourceAdmissionBinding(r.sourceBinding);
    if(r.sourceBinding&&(r.sourceBinding as SourceAdmissionBinding).captureId!==r.sourceCaptureId)throw Error('source-admission-receipt-binding');
    if(status==='pending')code(r.reason);else{
        if(r.durable!==true||r.sourceBinding===null||typeof r.correct!=='boolean'
            ||!['correct','partial','incorrect'].includes(String(r.outcome))||r.correct!==(r.outcome==='correct')
            ||typeof r.explanation!=='string'||Array.from(r.explanation).length>8000)throw Error('source-admission-outcome-receipt');
        if(r.selfAssessment!==undefined)r.selfAssessment=parseSourceSelfAssessment(r.selfAssessment);
    }return r as SourceAdmissionEvaluation;
}
export function parseSourceAdmissionClaimRequest(raw:unknown):SourceAdmissionClaimRequest {
    const r=sourceAdmissionFields(raw,['attemptId','eventId'],['rating']);sourceAdmissionId(r.attemptId);sourceAdmissionId(r.eventId);
    if(r.rating!==undefined&&!['again','hard','good','easy'].includes(String(r.rating)))throw Error('source-admission-rating');
    return r as SourceAdmissionClaimRequest;
}
export function parseSourceAdmissionClaimReceipt(raw:unknown):SourceAdmissionClaimReceipt {
    const r=sourceAdmissionFields(raw,['schemaVersion','status','durable','claim','claimHash']);version(r,'accepted');sourceAdmissionHash(r.claimHash);
    const c=sourceAdmissionFields(r.claim,['schemaVersion','attemptId','eventId','binding','sourceBinding','sourceCaptureId',
        'evaluationHash','answerRevision','answerHash','rating','correct','occurredAt','eventKind']);
    if(c.schemaVersion!==1||typeof c.correct!=='boolean'||!['due','python'].includes(String(c.eventKind)))throw Error('source-admission-receipt');
    sourceAdmissionId(c.attemptId);sourceAdmissionId(c.eventId);c.binding=parseSourceAdmissionBinding(c.binding);
    c.sourceBinding=parseSourceAdmissionBinding(c.sourceBinding);sourceAdmissionCaptureId(c.sourceCaptureId);
    sourceAdmissionHash(c.evaluationHash);sourceAdmissionHash(c.answerHash);count(c.answerRevision);sourceAdmissionTime(c.occurredAt);
    if(!(c.correct?['good','easy']:['again','hard']).includes(String(c.rating)))throw Error('source-admission-receipt-binding');
    r.claim=c;return r as SourceAdmissionClaimReceipt;
}
export function parseSourceAdmissionReadReceipt(raw:unknown):SourceAdmissionReadReceipt {
    const r=sourceAdmissionFields(raw,['schemaVersion','status','durable','submission','binding','sourceBinding','evaluation','receipt'],['activeRequestId','selfAssessment','codeReports']);
    if(r.activeRequestId!==undefined&&r.activeRequestId!==null)sourceAdmissionId(r.activeRequestId);
    version(r,'saved');r.submission=parseSourceAdmissionSubmission(r.submission);r.binding=parseSourceAdmissionBinding(r.binding);
    if(r.sourceBinding!==null)r.sourceBinding=parseSourceAdmissionBinding(r.sourceBinding);
    if(r.evaluation!==null)r.evaluation=parseSourceAdmissionEvaluation(r.evaluation);
    if(r.selfAssessment!==undefined&&r.selfAssessment!==null)r.selfAssessment=parseSourceSelfAssessment(r.selfAssessment);
    if(r.codeReports!==undefined)r.codeReports=parseSourceCodeReports(r.codeReports);
    r.receipt=parseSourceAdmissionSubmitReceipt(r.receipt);return r as SourceAdmissionReadReceipt;
}
export function sourceSelfRating(raw:unknown):SourceSelfAssessment['rating']{
    if(typeof raw!=='string'||!['again','hard','good','easy'].includes(raw))throw Error('source-admission-self-assessment-rating');
    return raw as SourceSelfAssessment['rating'];
}
export function parseSourceSelfAssessment(raw:unknown):SourceSelfAssessment{
    const r=sourceAdmissionFields(raw,['schemaVersion','attemptId','binding','answerRevision','submittedAt','rating']);
    if(r.schemaVersion!==1)throw Error('source-admission-self-assessment-version');
    sourceAdmissionId(r.attemptId);r.binding=parseSourceAdmissionBinding(r.binding);count(r.answerRevision);
    sourceAdmissionTime(r.submittedAt);sourceSelfRating(r.rating);return r as SourceSelfAssessment;
}
export function parseSourceSelfAssessmentReceipt(raw:unknown):SourceSelfAssessmentReceipt{
    const r=sourceAdmissionFields(raw,['schemaVersion','durable','selfAssessment','selfAssessmentHash']);version(r);
    r.selfAssessment=parseSourceSelfAssessment(r.selfAssessment);sourceAdmissionHash(r.selfAssessmentHash);
    return r as SourceSelfAssessmentReceipt;
}
