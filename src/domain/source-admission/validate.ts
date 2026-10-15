import type {SourceAdmissionBinding,SourceAdmissionQuery,SourceAdmissionCapture,SourceAdmissionSubmission,SourceAdmissionSubmitReceipt,
    SourceAdmissionConfirmation,SourceAdmissionExpectedEvaluation,SourceAdmissionEvaluation,SourceAdmissionFingerprint,
    SourceAdmissionConfirmedCapture,SourceAdmissionClaimRequest,SourceAdmissionResolvedEvaluation,
    SourceAdmissionClaimReceipt,SourceAdmissionOriginalAttempt,SourceAdmissionReadReceipt,SourceSelfAssessment,SourceSelfAssessmentReceipt} from './types';
// @ts-expect-error TS5097: standalone Node contracts.
import {sameSourceAdmission} from './json.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {sourceAdmissionHash,parseSourceAdmissionSubmission,parseSourceAdmissionEvaluation} from './parse.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {validateSourceCodeReceipt} from './code-report.ts';
const bindingFailure=():never=>{throw Error('source-admission-receipt-binding');};
export function validateSourceAdmissionScope(binding:SourceAdmissionBinding,libraryId:string,ownerId?:string):void{
    if(binding.libraryId!==libraryId||ownerId!==undefined&&binding.ownerId!==ownerId)bindingFailure();
}
export function validateSourceAdmissionCapture(capture:SourceAdmissionCapture,query:SourceAdmissionQuery,libraryId:string,ownerId?:string):void{
    validateSourceAdmissionScope(capture.binding,libraryId,ownerId);
    if(capture.binding.itemKey!==query.itemKey||capture.binding.contentHash!==query.contentHash)bindingFailure();
    if(capture.status==='confirmed')validateSourceAdmissionScope(capture.sourceBinding,libraryId,capture.binding.ownerId);
}
export async function validateSourceAdmissionSave(receipt:SourceAdmissionSubmitReceipt,submission:SourceAdmissionSubmission,
    fingerprint:SourceAdmissionFingerprint):Promise<void>{
    if(receipt.attemptId!==submission.attemptId||receipt.answerRevision!==submission.answerRevision
        ||receipt.submittedAt!==submission.submittedAt)bindingFailure();
    if(receipt.submissionHash!==sourceAdmissionHash(await fingerprint(submission)))throw Error('source-admission-submission-hash');
}
export function validateSourceAdmissionConfirmation(receipt:SourceAdmissionConfirmation,request:{attemptId:string;captureId:string},
    expected:{submission:SourceAdmissionSubmission;capture:SourceAdmissionConfirmedCapture}):void{
    if(receipt.attemptId!==request.attemptId||request.attemptId!==expected.submission.attemptId
        ||request.captureId!==expected.capture.captureId||receipt.sourceCaptureId!==request.captureId
        ||!sameSourceAdmission(receipt.binding,expected.submission.binding)
        ||!sameSourceAdmission(receipt.sourceBinding,expected.capture.sourceBinding))bindingFailure();
}
export function validateSourceAdmissionExpected(expected:SourceAdmissionExpectedEvaluation,libraryId:string,ownerId:string):void{
    parseSourceAdmissionSubmission(expected.submission);
    validateSourceAdmissionScope(expected.submission.binding,libraryId,ownerId);
    if(expected.selfAssessment)validateSourceSelfBinding(expected.selfAssessment,expected.submission);
    if(expected.sourceBinding){
        validateSourceAdmissionScope(expected.sourceBinding,libraryId,ownerId);
        if(expected.sourceBinding.captureId!==expected.sourceCaptureId)bindingFailure();
    }else if(expected.sourceCaptureId!==expected.submission.binding.captureId)bindingFailure();
}
export async function validateSourceAdmissionEvaluation(receipt:SourceAdmissionEvaluation,request:{attemptId:string;requestId:string},
    expected:SourceAdmissionExpectedEvaluation,fingerprint:SourceAdmissionFingerprint):Promise<void>{
    if(receipt.attemptId!==request.attemptId||request.attemptId!==expected.submission.attemptId
        ||receipt.requestId!==request.requestId||!sameSourceAdmission(receipt.binding,expected.submission.binding)
        ||!sameSourceAdmission(receipt.sourceBinding,expected.sourceBinding)||receipt.sourceCaptureId!==expected.sourceCaptureId
        ||receipt.answerRevision!==expected.submission.answerRevision)bindingFailure();
    if(receipt.answerHash!==sourceAdmissionHash(await fingerprint(expected.submission.answer)))throw Error('source-admission-answer-hash');
    if(receipt.status==='resolved'&&receipt.selfAssessment){
        validateSourceSelfBinding(receipt.selfAssessment,expected.submission);
        if(expected.selfAssessment&&!sameSourceAdmission(receipt.selfAssessment,expected.selfAssessment))bindingFailure();
        const rating=receipt.selfAssessment.rating,correct=['good','easy'].includes(rating);
        if(receipt.correct!==correct||receipt.outcome!==(correct?'correct':rating==='hard'?'partial':'incorrect'))bindingFailure();
    }else if(receipt.status==='resolved'&&expected.selfAssessment)bindingFailure();
    const {evaluationHash,...body}=receipt;
    if(evaluationHash!==sourceAdmissionHash(await fingerprint(body)))throw Error('source-admission-evaluation-hash');
}
export type SourceAdmissionExpectedClaim={submission:SourceAdmissionSubmission;evaluation:SourceAdmissionResolvedEvaluation;eventKind:'due'|'python'};
export function validateSourceAdmissionClaimPurpose(expected:SourceAdmissionExpectedClaim):void{
    if(expected.submission.purpose!=='first'||expected.submission.parentAttemptId!=null)throw Error('source-admission-purpose');
    parseSourceAdmissionEvaluation(expected.evaluation);
    if(expected.evaluation.status!=='resolved'||!['due','python'].includes(expected.eventKind))bindingFailure();
}
export async function validateSourceAdmissionClaim(receipt:SourceAdmissionClaimReceipt,request:SourceAdmissionClaimRequest,
    expected:SourceAdmissionExpectedClaim,fingerprint:SourceAdmissionFingerprint):Promise<void>{
    validateSourceAdmissionClaimPurpose(expected);
    const evaluation=expected.evaluation,claim=receipt.claim;
    await validateSourceAdmissionEvaluation(evaluation,{attemptId:request.attemptId,requestId:evaluation.requestId},
        {submission:expected.submission,sourceBinding:evaluation.sourceBinding,sourceCaptureId:evaluation.sourceCaptureId},fingerprint);
    const defaultRating=evaluation.selfAssessment?.rating??(evaluation.correct?'good':evaluation.outcome==='partial'?'hard':'again');
    if(evaluation.selfAssessment&&(request.rating??defaultRating)!==evaluation.selfAssessment.rating)bindingFailure();
    if(claim.attemptId!==request.attemptId||claim.eventId!==request.eventId||claim.rating!==(request.rating??defaultRating)
        ||claim.correct!==(evaluation.correct&&['good','easy'].includes(claim.rating))||claim.eventKind!==expected.eventKind||claim.occurredAt!==expected.submission.submittedAt
        ||!sameSourceAdmission(claim.binding,expected.submission.binding)||!sameSourceAdmission(claim.sourceBinding,evaluation.sourceBinding)
        ||claim.sourceCaptureId!==evaluation.sourceCaptureId||claim.evaluationHash!==evaluation.evaluationHash
        ||claim.answerRevision!==evaluation.answerRevision||claim.answerHash!==evaluation.answerHash)bindingFailure();
    if(receipt.claimHash!==sourceAdmissionHash(await fingerprint(claim)))throw Error('source-admission-claim-hash');
}
function sameOriginal(receipt:SourceAdmissionSubmission,expected:SourceAdmissionOriginalAttempt):boolean{
    if(receipt.attemptId!==expected.attemptId||receipt.binding.itemKey!==expected.itemKey
        ||receipt.binding.contentHash!==expected.contentHash||receipt.binding.libraryId!==expected.libraryId
        ||receipt.answerRevision!==expected.answerRevision||receipt.submittedAt!==expected.submittedAt
        ||!sameSourceAdmission(receipt.answer,expected.answer))return false;
    return(receipt.purpose??'unknown')===(expected.purpose??'unknown')
        &&(receipt.parentAttemptId??null)===(expected.parentAttemptId??null)
        &&(receipt.assistance??'unknown')===(expected.assistance??'unknown')
        &&receipt.maxPreHintLevel===expected.maxPreHintLevel&&receipt.answerRevealed===expected.answerRevealed;
}
export async function validateSourceAdmissionRead(receipt:SourceAdmissionReadReceipt,attemptId:string,
    expected:SourceAdmissionOriginalAttempt,libraryId:string,ownerId:string,fingerprint:SourceAdmissionFingerprint):Promise<void>{
    if(expected.attemptId!==attemptId||expected.libraryId!==libraryId||!sameOriginal(receipt.submission,expected)
        ||!sameSourceAdmission(receipt.binding,receipt.submission.binding))bindingFailure();
    validateSourceAdmissionScope(receipt.binding,libraryId,ownerId);
    if(receipt.sourceBinding)validateSourceAdmissionScope(receipt.sourceBinding,libraryId,ownerId);
    await validateSourceAdmissionSave(receipt.receipt,receipt.submission,fingerprint);
    if(receipt.selfAssessment)validateSourceSelfBinding(receipt.selfAssessment,receipt.submission);
    for(const report of receipt.codeReports??[])await validateSourceCodeReceipt(report,report.evidence,receipt.submission,fingerprint);
    if(receipt.evaluation){
        await validateSourceAdmissionEvaluation(receipt.evaluation,{attemptId,requestId:receipt.evaluation.requestId},
            {submission:receipt.submission,sourceBinding:receipt.sourceBinding,
             sourceCaptureId:receipt.sourceBinding?.captureId??receipt.binding.captureId,
             ...(receipt.selfAssessment?{selfAssessment:receipt.selfAssessment}:{})},fingerprint);
    }
}
export function validateSourceSelfBinding(self:SourceSelfAssessment,submission:SourceAdmissionSubmission):void{
    if(self.attemptId!==submission.attemptId||self.answerRevision!==submission.answerRevision
        ||self.submittedAt!==submission.submittedAt||!sameSourceAdmission(self.binding,submission.binding))bindingFailure();
}
export async function validateSourceSelfReceipt(receipt:SourceSelfAssessmentReceipt,request:SourceSelfAssessment,
    submission:SourceAdmissionSubmission,fingerprint:SourceAdmissionFingerprint):Promise<void>{
    validateSourceSelfBinding(request,submission);validateSourceSelfBinding(receipt.selfAssessment,submission);
    if(!sameSourceAdmission(receipt.selfAssessment,request)||receipt.selfAssessmentHash!==await fingerprint(request))bindingFailure();
}
