import type {SourceAdmissionQuery,SourceAdmissionCapture,SourceAdmissionSubmission,SourceAdmissionOriginalAttempt,
    SourceAdmissionConfirmedCapture,SourceAdmissionExpectedEvaluation,SourceAdmissionExpectedClaim,
    SourceAdmissionClaimRequest,SourceAdmissionFingerprint,SourceAdmissionSubmitReceipt,SourceAdmissionConfirmation,
    SourceAdmissionEvaluation,SourceAdmissionClaimReceipt,SourceAdmissionReadReceipt,SourceSelfAssessment,SourceSelfAssessmentReceipt,
    SourceCodeReport,SourceCodeReportReceipt,SourceCodeHintRequest,SourceCodeHintExpected,SourceCodeHintReceipt} from '../../domain/source-admission';
import {sameSourceAdmission,sourceAdmissionFields,sourceAdmissionId,
    sourceAdmissionCaptureId,parseSourceAdmissionBinding,parseSourceAdmissionQuery,parseSourceAdmissionSubmission,parseSourceAdmissionOriginalAttempt,
    parseSourceAdmissionCapture,parseSourceAdmissionSubmitReceipt,parseSourceAdmissionConfirmation,
    parseSourceAdmissionEvaluation,parseSourceAdmissionClaimRequest,parseSourceAdmissionClaimReceipt,
    parseSourceAdmissionReadReceipt,validateSourceAdmissionScope,validateSourceAdmissionCapture,
    validateSourceAdmissionSave,validateSourceAdmissionConfirmation,validateSourceAdmissionExpected,
    validateSourceAdmissionEvaluation,validateSourceAdmissionClaimPurpose,validateSourceAdmissionClaim,
    // @ts-expect-error TS5097: standalone Node contracts.
    validateSourceAdmissionRead} from '../../domain/source-admission/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseSourceSelfAssessment,parseSourceSelfAssessmentReceipt,validateSourceSelfReceipt,validateSourceSelfBinding} from '../../domain/source-admission/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseSourceCodeReport,parseSourceCodeReportReceipt,validateSourceCodeBinding,validateSourceCodeReceipt} from '../../domain/source-admission/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseSourceCodeHintRequest,parseSourceCodeHintReceipt,validateSourceCodeHintRequest,validateSourceCodeHintReceipt} from '../../domain/source-admission/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {sourceAdmissionFingerprint} from './fingerprint.ts';
export {sourceAdmissionFingerprint};
// @ts-expect-error TS5097: standalone Node contracts.
export {createSourceSelfAssessmentRepository} from './self-assessment.ts';

export const SOURCE_ADMISSION_CAPABILITY='nonword-source-v1' as const;
export const SOURCE_CODE_HINT_CAPABILITY='nonword-source-code-hint-v1' as const;
type ResponseLike={ok:boolean;status:number;json():Promise<unknown>};
export type SourceAdmissionClientOptions={baseUrl:string;sessionToken:string;libraryId:string;remoteOwnerId?:string;
    capabilities?:readonly string[];fetcher?:(url:string,init:RequestInit)=>Promise<ResponseLike>;timeoutMs?:number;
    isCurrent?:()=>boolean;fingerprint?:SourceAdmissionFingerprint};
export type SourceAdmissionClient={
    supported():boolean;hintsSupported():boolean;retire():void;
    capture(query:SourceAdmissionQuery,signal?:AbortSignal):Promise<SourceAdmissionCapture>;
    submit(submission:SourceAdmissionSubmission,capture:SourceAdmissionCapture,signal?:AbortSignal):Promise<SourceAdmissionSubmitReceipt>;
    confirm(request:{attemptId:string;captureId:string},expected:{submission:SourceAdmissionSubmission;capture:SourceAdmissionConfirmedCapture},
        signal?:AbortSignal):Promise<SourceAdmissionConfirmation>;
    evaluate(request:{attemptId:string;requestId:string},expected:SourceAdmissionExpectedEvaluation,signal?:AbortSignal):Promise<SourceAdmissionEvaluation>;
    claim(request:SourceAdmissionClaimRequest,expected:SourceAdmissionExpectedClaim,signal?:AbortSignal):Promise<SourceAdmissionClaimReceipt>;
    read(attemptId:string,expected:SourceAdmissionOriginalAttempt,signal?:AbortSignal):Promise<SourceAdmissionReadReceipt>;
    selfAssess(request:SourceSelfAssessment,submission:SourceAdmissionSubmission,signal?:AbortSignal):Promise<SourceSelfAssessmentReceipt>;
    codeReport(request:SourceCodeReport,submission:SourceAdmissionSubmission,signal?:AbortSignal):Promise<SourceCodeReportReceipt>;
    codeHint(request:SourceCodeHintRequest,expected:SourceCodeHintExpected,signal?:AbortSignal):Promise<SourceCodeHintReceipt>;
};
function endpointFor(value:string):string{
    // Check the original spelling as URL would normalize numeric host tricks.
    if(!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):[1-9][0-9]{3,4}\/?$/u.test(value))
        throw Error('source-admission-endpoint-invalid');
    const url=new URL(value);
    if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)
        ||Number(url.port)<1024||Number(url.port)>65535||url.username||url.password||url.search||url.hash||url.pathname!=='/')
        throw Error('source-admission-endpoint-invalid');
    return url.origin+'/v1/nonword/source';
}
/** Transport and evidence validation only; no scores, local persistence or model ports. */
export function createSourceAdmissionClient(options:SourceAdmissionClientOptions):SourceAdmissionClient{
    const fetcher=options.fetcher??fetch,fingerprint=options.fingerprint??sourceAdmissionFingerprint;
    const baseUrl=options.baseUrl,sessionToken=options.sessionToken,libraryId=options.libraryId;
    const supported=()=>Boolean(options.capabilities?.includes(SOURCE_ADMISSION_CAPABILITY));
    const hintsSupported=()=>supported()&&Boolean(options.capabilities?.includes(SOURCE_CODE_HINT_CAPABILITY));
    let retired=false,owner=options.remoteOwnerId;
    const latest=new Map<string,number>(),controllers=new Set<AbortController>();
    function active():void{
        if(!supported())throw Error('source-admission-unsupported');
        if(retired||options.isCurrent?.()===false)throw Error('source-admission-stale');
    }
    function remoteOwner():string{
        if(owner===undefined)throw Error('source-admission-remote-owner-required');return sourceAdmissionId(owner);
    }
    function scope(submission:SourceAdmissionSubmission):void{
        validateSourceAdmissionScope(submission.binding,libraryId,remoteOwner());
    }
    async function operation<T>(action:string,body:unknown,channel:string,validate:(raw:unknown)=>Promise<T>|T,signal?:AbortSignal):Promise<T>{
        active();const endpoint=endpointFor(baseUrl);
        if(!/^[A-Za-z0-9_-]{43,128}$/u.test(sessionToken))throw Error('source-admission-session-invalid');
        const timeout=options.timeoutMs??15000;
        if(!Number.isSafeInteger(timeout)||timeout<1||timeout>120000)throw Error('source-admission-timeout-invalid');
        sourceAdmissionId(libraryId);
        const revision=(latest.get(channel)??0)+1;latest.set(channel,revision);
        const controller=new AbortController();controllers.add(controller);
        let timer:ReturnType<typeof setTimeout>|undefined,stop=()=>{},rejectEnded:(error:Error)=>void=()=>{};
        function guard():void{
            active();if(controller.signal.aborted)throw Error('source-admission-cancelled');
            if(latest.get(channel)!==revision)throw Error('source-admission-stale');
        }
        const ended=new Promise<never>((_resolve,reject)=>{
            rejectEnded=reject;
            stop=()=>{controller.abort();reject(Error('source-admission-cancelled'));};
            signal?.addEventListener('abort',stop,{once:true});
            controller.signal.addEventListener('abort',()=>reject(Error('source-admission-cancelled')),{once:true});
            timer=setTimeout(()=>{reject(Error('source-admission-timeout'));controller.abort();},timeout);
            if(signal?.aborted)stop();
        });
        try{
            return await Promise.race([ended,Promise.resolve().then(async()=>{
                guard();
                let response:ResponseLike;
                try{response=await fetcher(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Study-Loop-Session':sessionToken},
                    body:JSON.stringify({schemaVersion:1,action,request:body}),signal:controller.signal,redirect:'error',credentials:'omit',cache:'no-store'});}
                catch{guard();throw Error('source-admission-receipt-unavailable');}
                guard();
                const raw=await response.json();guard();
                if(!response.ok){
                    const code=(raw as {error?:unknown})?.error;
                    throw Error(typeof code==='string'&&/^source-admission-[a-z0-9-]{1,100}$/u.test(code)?code:'source-admission-request-failed');
                }
                const result=await validate(raw);guard();return result;
            })]);
        }finally{
            if(timer!==undefined)clearTimeout(timer);
            signal?.removeEventListener('abort',stop);controllers.delete(controller);
            // Keep a cancelled operation unable to apply its late hash/JSON continuation.
            if(signal?.aborted){controller.abort();rejectEnded(Error('source-admission-cancelled'));}
        }
    }
    return {supported,hintsSupported,retire(){retired=true;for(const controller of controllers)controller.abort();},
        async capture(raw,signal){
            active();const query=parseSourceAdmissionQuery(raw);
            return operation('capture',query,'capture:'+query.itemKey,raw=>{
                const result=parseSourceAdmissionCapture(raw);
                validateSourceAdmissionCapture(result,query,libraryId,owner);
                if(owner===undefined)owner=result.binding.ownerId;
                return result;
            },signal);
        },
        async submit(raw,captureRaw,signal){
            active();const submission=parseSourceAdmissionSubmission(raw),capture=parseSourceAdmissionCapture(captureRaw);
            // Only a real capture response (or host-authenticated owner) pins the remote namespace.
            remoteOwner();
            validateSourceAdmissionCapture(capture,{itemKey:submission.binding.itemKey,contentHash:submission.binding.contentHash,presentation:{bound:true}},
                libraryId,owner);
            scope(submission);
            if(!sameSourceAdmission(submission.binding,capture.binding))throw Error('source-admission-receipt-binding');
            return operation('submit',submission,'attempt:'+submission.attemptId,async raw=>{
                const result=parseSourceAdmissionSubmitReceipt(raw);await validateSourceAdmissionSave(result,submission,fingerprint);return result;
            },signal);
        },
        async confirm(raw,expected,signal){
            active();const r=sourceAdmissionFields(raw,['attemptId','captureId']);sourceAdmissionId(r.attemptId);sourceAdmissionCaptureId(r.captureId);
            const submission=parseSourceAdmissionSubmission(expected.submission),capture=parseSourceAdmissionCapture(expected.capture);
            scope(submission);if(capture.status!=='confirmed')throw Error('source-admission-receipt-binding');
            validateSourceAdmissionScope(capture.sourceBinding,libraryId,remoteOwner());
            return operation('confirm',r,'attempt:'+submission.attemptId,raw=>{
                const result=parseSourceAdmissionConfirmation(raw);
                validateSourceAdmissionConfirmation(result,r as {attemptId:string;captureId:string},{submission,capture});return result;
            },signal);
        },
        async evaluate(raw,rawExpected,signal){
            active();
            const expected={submission:parseSourceAdmissionSubmission(rawExpected.submission),
                sourceBinding:rawExpected.sourceBinding===null?null:parseSourceAdmissionBinding(rawExpected.sourceBinding),
                sourceCaptureId:sourceAdmissionCaptureId(rawExpected.sourceCaptureId),
                ...(rawExpected.selfAssessment?{selfAssessment:parseSourceSelfAssessment(rawExpected.selfAssessment)}:{})};
            const r=sourceAdmissionFields(raw,['attemptId','requestId']);sourceAdmissionId(r.attemptId);sourceAdmissionId(r.requestId);
            validateSourceAdmissionExpected(expected,libraryId,remoteOwner());
            return operation('evaluate',r,'attempt:'+expected.submission.attemptId,async raw=>{
                const result=parseSourceAdmissionEvaluation(raw);
                await validateSourceAdmissionEvaluation(result,r as {attemptId:string;requestId:string},expected,fingerprint);return result;
            },signal);
        },
        async claim(raw,rawExpected,signal){
            active();
            const evaluation=parseSourceAdmissionEvaluation(rawExpected.evaluation);
            if(evaluation.status!=='resolved')throw Error('source-admission-receipt-binding');
            const expected={submission:parseSourceAdmissionSubmission(rawExpected.submission),evaluation,eventKind:rawExpected.eventKind};
            const request=parseSourceAdmissionClaimRequest(raw);
            validateSourceAdmissionClaimPurpose(expected);
            validateSourceAdmissionExpected({submission:expected.submission,sourceBinding:expected.evaluation.sourceBinding,
                sourceCaptureId:expected.evaluation.sourceCaptureId},libraryId,remoteOwner());
            return operation('claim',request,'attempt:'+request.attemptId,async raw=>{
                const result=parseSourceAdmissionClaimReceipt(raw);await validateSourceAdmissionClaim(result,request,expected,fingerprint);return result;
            },signal);
        },
        async read(attemptId,raw,signal){
            active();sourceAdmissionId(attemptId);const expected=parseSourceAdmissionOriginalAttempt(raw),remote=remoteOwner();
            if(expected.libraryId!==libraryId)throw Error('source-admission-receipt-binding');
            return operation('read',{attemptId},'attempt:'+attemptId,async raw=>{
                const result=parseSourceAdmissionReadReceipt(raw);
                await validateSourceAdmissionRead(result,attemptId,expected,libraryId,remote,fingerprint);return result;
            },signal);
        },
        async selfAssess(raw,rawSubmission,signal){
            active();const request=parseSourceSelfAssessment(raw),submission=parseSourceAdmissionSubmission(rawSubmission);
            scope(submission);validateSourceSelfBinding(request,submission);
            return operation('self-assess',request,'attempt:'+request.attemptId,async raw=>{
                const receipt=parseSourceSelfAssessmentReceipt(raw);
                await validateSourceSelfReceipt(receipt,request,submission,fingerprint);return receipt;
            },signal);
        },
        async codeReport(raw,rawSubmission,signal){
            active();const request=parseSourceCodeReport(raw),submission=parseSourceAdmissionSubmission(rawSubmission);
            scope(submission);validateSourceCodeBinding(request,submission);
            return operation('code-report',request,'attempt:'+request.attemptId,async raw=>{
                const receipt=parseSourceCodeReportReceipt(raw);
                await validateSourceCodeReceipt(receipt,request,submission,fingerprint);return receipt;
            },signal);
        },
        async codeHint(raw,rawExpected,signal){
            active();if(!hintsSupported())throw Error('source-admission-code-hint-unsupported');
            const request=parseSourceCodeHintRequest(raw),expected={submission:parseSourceAdmissionSubmission(rawExpected.submission),
                sourceBinding:parseSourceAdmissionBinding(rawExpected.sourceBinding),reportId:rawExpected.reportId};
            validateSourceAdmissionExpected({...expected,sourceCaptureId:expected.sourceBinding.captureId},libraryId,remoteOwner());
            validateSourceCodeHintRequest(request,expected);
            return operation('code-hint',request,'attempt:'+request.attemptId,async raw=>{
                const receipt=parseSourceCodeHintReceipt(raw);
                await validateSourceCodeHintReceipt(receipt,request,expected,fingerprint);return receipt;
            },signal);
        },
    };
}
