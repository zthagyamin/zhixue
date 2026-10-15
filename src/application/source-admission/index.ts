import type {LearningAttempt} from '../../domain/learning-attempt';
import type {NonWordSourceAdmission,NonWordOutcome} from '../nonword-study';
import type {SourceAdmissionQuery,SourceAdmissionCapture,SourceAdmissionSubmission,SourceAdmissionOriginalAttempt,
    SourceAdmissionConfirmedCapture,SourceAdmissionReadReceipt,SourceAdmissionExpectedEvaluation,SourceAdmissionEvaluation,
    SourceAdmissionSubmitReceipt,SourceAdmissionConfirmation,SourceAdmissionClaimRequest,SourceAdmissionClaimReceipt,
    SourceAdmissionExpectedClaim,SourceSelfAssessment,SourceSelfAssessmentReceipt,SourceLocalSelfAssessment,
    SourceCodeReport,SourceCodeReportReceipt,SourceCodeHintRequest,SourceCodeHintExpected,SourceCodeHintReceipt} from '../../domain/source-admission';
import type {CodeRunReportV1} from '../../domain/code-execution';
// @ts-expect-error TS5097: standalone Node contracts.
import {sameSourceAdmission} from '../../domain/source-admission/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseSourceCodeReport,validateSourceCodeBinding,validateSourceCodeReceipt} from '../../domain/source-admission/index.ts';

export interface SourceAdmissionTransport {
    supported():boolean;
    capture(query:SourceAdmissionQuery):Promise<SourceAdmissionCapture>;
    read(id:string,expected:SourceAdmissionOriginalAttempt):Promise<SourceAdmissionReadReceipt>;
    submit(submission:SourceAdmissionSubmission,capture:SourceAdmissionCapture):Promise<SourceAdmissionSubmitReceipt>;
    confirm(request:{attemptId:string;captureId:string},expected:{submission:SourceAdmissionSubmission;capture:SourceAdmissionConfirmedCapture}):Promise<SourceAdmissionConfirmation>;
    evaluate(request:{attemptId:string;requestId:string},expected:SourceAdmissionExpectedEvaluation):Promise<SourceAdmissionEvaluation>;
    claim(request:SourceAdmissionClaimRequest,expected:SourceAdmissionExpectedClaim):Promise<SourceAdmissionClaimReceipt>;
    selfAssess?(request:SourceSelfAssessment,submission:SourceAdmissionSubmission):Promise<SourceSelfAssessmentReceipt>;
    codeReport?(request:SourceCodeReport,submission:SourceAdmissionSubmission):Promise<SourceCodeReportReceipt>;
    hintsSupported?():boolean;
    codeHint?(request:SourceCodeHintRequest,expected:SourceCodeHintExpected):Promise<SourceCodeHintReceipt>;
}
export interface SourceSelfAssessmentPort{
    read(attempt:LearningAttempt):Promise<SourceLocalSelfAssessment|null>;
    save(attempt:LearningAttempt,rating:SourceLocalSelfAssessment['rating']):Promise<SourceLocalSelfAssessment>;
}
type Options={query:SourceAdmissionQuery;libraryId:string;transport?:SourceAdmissionTransport;
    fingerprint:(value:unknown)=>Promise<string>;newId:()=>string;current?:()=>boolean;selfAssessment?:SourceSelfAssessmentPort;
    readCodeReports?:(attempt:LearningAttempt)=>Promise<readonly CodeRunReportV1[]>};
/** Sources and immutable raw submissions remain separate from portable formal events. */
export function createSourceLearningSession(options:Options){
    const query=structuredClone(options.query);
    let ready:SourceAdmissionExpectedClaim|null=null;
    let firstSelf:SourceLocalSelfAssessment|null=null;
    const flashcard=query.presentation.questionType==='flashcard';
    const code=query.presentation.questionType==='code';
    const live=()=>{if(options.current?.()===false)throw Error('source-admission-stale');};
    function original(attempt:LearningAttempt):SourceAdmissionOriginalAttempt{
        if(!attempt.submitted||attempt.binding.libraryId!==options.libraryId
            ||attempt.binding.itemKey!==query.itemKey||attempt.binding.contentHash!==query.contentHash)
            throw Error('source-admission-local-binding');
        const {answer,answerRevision,submittedAt,assistance,maxPreHintLevel,answerRevealed}=attempt.submitted;
        return {attemptId:attempt.attemptId,itemKey:query.itemKey,contentHash:query.contentHash,libraryId:options.libraryId,
            answer,answerRevision,submittedAt,purpose:attempt.checkpoint.purpose??'unknown',parentAttemptId:attempt.parentAttemptId,
            assistance,...(maxPreHintLevel===undefined?{}:{maxPreHintLevel}),...(answerRevealed===undefined?{}:{answerRevealed})};
    }
    const pending=(reason:string,reasonCode:'offline'|'invalid'|'no-reference'='no-reference'):NonWordSourceAdmission=>
        ({status:'pending',reason,reasonCode});
    async function restoreSelf(attempt:LearningAttempt){
        live();firstSelf=flashcard?await options.selfAssessment?.read(attempt)??null:null;live();
    }
    async function beforeContinue(attempt:LearningAttempt){
        if(!flashcard)return;
        await restoreSelf(attempt);if(!firstSelf)throw Error('首轮自评尚未可靠保存，请重试保存。');
    }
    async function assess(attempt:LearningAttempt,candidate?:NonWordOutcome,saveOnly=false):Promise<NonWordSourceAdmission>{
        if(!saveOnly)ready=null;
        live();const core=original(attempt),client=options.transport;
        await restoreSelf(attempt);
        if(flashcard&&candidate?.source==='self-assess'&&candidate.rating){
            if(!options.selfAssessment)throw Error('source-self-assessment-storage-required');
            firstSelf=await options.selfAssessment.save(attempt,candidate.rating);live();
        }
        if(!client?.supported())return pending('答案已保存；同步助手暂不支持来源核对。');
        try{
            const capture=await client.capture(query);live();
            let submission:SourceAdmissionSubmission,sourceBinding:SourceAdmissionExpectedEvaluation['sourceBinding'];
            let sourceCaptureId:string,previous:SourceAdmissionReadReceipt|null=null;
            try{
                const recovered=await client.read(attempt.attemptId,core);live();
                previous=recovered;
                submission=recovered.submission;sourceBinding=recovered.sourceBinding;
                sourceCaptureId=sourceBinding?.captureId??submission.binding.captureId;
            }catch(error){
                if(!(error instanceof Error)||error.message!=='source-admission-submission-required')throw error;
                const {itemKey:ignoredKey,contentHash:ignoredHash,libraryId:ignoredLibrary,...answer}=core;
                void ignoredKey;void ignoredHash;void ignoredLibrary;
                submission={...answer,binding:capture.binding};
                await client.submit(submission,capture);live();
                sourceBinding=capture.status==='confirmed'?capture.sourceBinding:null;
                sourceCaptureId=capture.captureId;
            }
            if(code){
                const reports=await options.readCodeReports?.(attempt);live();
                if(!reports?.length||!client.codeReport)return pending('原代码已保存，运行报告尚待可靠核对。');
                for(const report of reports){
                    const request=parseSourceCodeReport({schemaVersion:1,attemptId:submission.attemptId,binding:submission.binding,
                        answerRevision:submission.answerRevision,submittedAt:submission.submittedAt,report});
                    validateSourceCodeBinding(request,submission);
                    const receipt=await client.codeReport(request,submission);live();
                    if(!previous?.codeReports?.some(row=>row.reportId===receipt.reportId))previous=null;
                }
            }
            if(saveOnly)return pending('原代码和运行报告已保存，等待可靠核对。');
            let self:SourceSelfAssessment|undefined;
            if(flashcard){
                if(!firstSelf&&previous?.selfAssessment){
                    if(!options.selfAssessment)throw Error('source-self-assessment-storage-required');
                    firstSelf=await options.selfAssessment.save(attempt,previous.selfAssessment.rating);live();
                }
                if(!firstSelf||!client.selfAssess)return pending('原答案已保存，首轮自评尚待可靠保存。');
                self={schemaVersion:1,attemptId:submission.attemptId,binding:submission.binding,
                    answerRevision:submission.answerRevision,submittedAt:submission.submittedAt,rating:firstSelf.rating};
                if(previous?.selfAssessment&&!sameSourceAdmission(previous.selfAssessment,self))throw Error('source-admission-self-assessment-conflict');
                await client.selfAssess(self,submission);live();
                if(!previous?.selfAssessment)previous=null;
            }
            if(capture.status!=='confirmed')return pending('答案已保存，来源待核对。');
            if(!sameSourceAdmission(sourceBinding,capture.sourceBinding)){
                const confirmation=await client.confirm({attemptId:attempt.attemptId,captureId:capture.captureId},
                    {submission,capture});live();
                sourceBinding=confirmation.sourceBinding;sourceCaptureId=confirmation.sourceCaptureId;
            }
            const matching=previous&&sameSourceAdmission(previous.sourceBinding,sourceBinding)?previous:null;
            const inFlight=matching?.activeRequestId&&matching.activeRequestId!==matching.evaluation?.requestId;
            const retained=matching?.evaluation?.status==='resolved'?matching.evaluation.requestId:null;
            const requestId=inFlight?matching!.activeRequestId!:retained??'source:'+await options.fingerprint(
                [attempt.attemptId,submission,sourceCaptureId,options.newId()]);live();
            const evaluation=await client.evaluate({attemptId:attempt.attemptId,requestId},
                {submission,sourceBinding,sourceCaptureId,...(self?{selfAssessment:self}:{})});live();
            if(evaluation.status!=='resolved')return pending('答案已保存，暂时无法可靠核对。','offline');
            ready={submission,evaluation,eventKind:capture.eventKind};
            return {status:'confirmed',outcome:{status:evaluation.outcome,
                source:flashcard?'self-assess':code||query.presentation.questionType==='recall'?'model':'deterministic',
                rating:evaluation.selfAssessment?.rating??(evaluation.correct?'good':evaluation.outcome==='partial'?'hard':'again'),explanation:evaluation.explanation}};
        }catch(error){
            live();
            if(error instanceof Error&&/binding|identity|conflict|purpose|integrity|hash|stale/u.test(error.message))throw error;
            return pending('答案已保存在本机，核对暂不可用。','offline');
        }
    }
    async function beforeFormal(attempt:LearningAttempt):Promise<void>{
        live();original(attempt);
        if(attempt.checkpoint.purpose!=='first'||attempt.parentAttemptId||!attempt.formal||attempt.evaluation.status!=='resolved')
            throw Error('source-admission-formal-evidence-required');
        // A page refresh loses only this cache, never the immutable saved evidence.
        if(!ready){await assess(attempt);live();}
        if(!ready||ready.submission.attemptId!==attempt.attemptId
            ||ready.submission.answerRevision!==attempt.submitted!.answerRevision
            ||ready.submission.answer!==attempt.submitted!.answer
            ||ready.evaluation.outcome!==attempt.evaluation.outcome
            ||ready.evaluation.explanation!==attempt.evaluation.feedback)throw Error('source-admission-formal-evidence-required');
        await options.transport!.claim({attemptId:attempt.attemptId,eventId:attempt.formal.eventId,rating:attempt.formal.rating},ready);
        live();
    }
    async function requestHint(attempt:LearningAttempt,report:CodeRunReportV1):Promise<SourceCodeHintReceipt>{
        live();const core=original(attempt),client=options.transport;
        const reportSnapshot=structuredClone(report);
        if(!client?.supported()||!client.hintsSupported?.()||!client.codeHint)throw Error('source-admission-code-hint-unsupported');
        await assess(attempt,undefined,true);live();
        const capture=await client.capture(query);live();
        if(capture.status!=='confirmed')throw Error('source-admission-code-hint-source-unconfirmed');
        let saved=await client.read(attempt.attemptId,core);live();
        if(!sameSourceAdmission(saved.sourceBinding,capture.sourceBinding)){
            await client.confirm({attemptId:attempt.attemptId,captureId:capture.captureId},{submission:saved.submission,capture});live();
            saved=await client.read(attempt.attemptId,core);live();
        }
        if(!saved.sourceBinding||!sameSourceAdmission(saved.sourceBinding,capture.sourceBinding))
            throw Error('source-admission-code-hint-source-binding');
        if(ready&&(!saved.evaluation||!sameSourceAdmission(saved.evaluation,ready.evaluation)))ready=null;
        const latest=saved.codeReports?.at(-1);
        if(!latest)throw Error('source-admission-code-hint-report-required');
        const evidence=parseSourceCodeReport({schemaVersion:1,attemptId:saved.submission.attemptId,binding:saved.submission.binding,
            answerRevision:saved.submission.answerRevision,submittedAt:saved.submission.submittedAt,report:reportSnapshot});
        await validateSourceCodeReceipt(latest,evidence,saved.submission,options.fingerprint);live();
        // Explicit retries get a new request; the remote ledger retains logical attempt/report recovery authority.
        const reportId=latest.reportId,requestId='source-hint:'+await options.fingerprint(
            [saved.submission,saved.sourceBinding,reportId,options.newId()]);live();
        const receipt=await client.codeHint({attemptId:attempt.attemptId,requestId,reportId},
            {submission:saved.submission,sourceBinding:saved.sourceBinding,reportId});live();
        if(receipt.status!=='ready')throw Error('source-admission-code-hint-pending: '+receipt.reason);
        return receipt;
    }
    return {assess,beforeFormal,restoreSelf,beforeContinue,
        ...(code?{savePending:async(attempt:LearningAttempt)=>{await assess(attempt,undefined,true);},requestHint}:{}),
        selfRating:()=>firstSelf?.rating,supported:()=>Boolean(options.transport?.supported())};
}
