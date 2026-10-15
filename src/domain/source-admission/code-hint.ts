import type {SourceAdmissionBinding,SourceAdmissionSubmission,SourceAdmissionFingerprint} from './types';
// @ts-expect-error TS5097: standalone Node contracts.
import {sourceAdmissionFields,sourceAdmissionId,sourceAdmissionHash,parseSourceAdmissionBinding} from './fields.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {sameSourceAdmission} from './json.ts';

export type SourceCodeHintRequest={attemptId:string;requestId:string;reportId:string};
export type SourceCodeHintExpected={submission:SourceAdmissionSubmission;sourceBinding:SourceAdmissionBinding;reportId:string};
export type SourceCodeHint={text:string;sourceQuote:string;codeQuote:string;reason:string};
type HintBase={schemaVersion:1;durable:true;requestId:string;attemptId:string;binding:SourceAdmissionBinding;
    sourceBinding:SourceAdmissionBinding;answerRevision:number;answerHash:string;reportId:string;receiptHash:string};
export type SourceCodeHintReceipt=HintBase&({status:'ready';hint:SourceCodeHint}|{status:'pending';reason:string});

function reportId(raw:unknown):string{
    const id=sourceAdmissionId(raw);
    if(!/^code-report:[a-f0-9]{64}$/u.test(id))throw Error('source-admission-code-hint-report');
    return id;
}
function text(raw:unknown,max:number):string{
    if(typeof raw!=='string'||!raw.trim()||raw!==raw.trim()||Array.from(raw).length>max)
        throw Error('source-admission-code-hint-text');
    return raw;
}
export function parseSourceCodeHintRequest(raw:unknown):SourceCodeHintRequest{
    const r=sourceAdmissionFields(raw,['attemptId','requestId','reportId']);
    sourceAdmissionId(r.attemptId);sourceAdmissionId(r.requestId);reportId(r.reportId);
    return r as SourceCodeHintRequest;
}
export function parseSourceCodeHintReceipt(raw:unknown):SourceCodeHintReceipt{
    const status=(raw as {status?:unknown})?.status;
    if(status!=='ready'&&status!=='pending')throw Error('source-admission-code-hint-status');
    const r=sourceAdmissionFields(raw,['schemaVersion','durable','requestId','attemptId','binding','sourceBinding',
        'answerRevision','answerHash','reportId','status','receiptHash',status==='ready'?'hint':'reason']);
    if(r.schemaVersion!==1||r.durable!==true)throw Error('source-admission-code-hint-receipt');
    sourceAdmissionId(r.requestId);sourceAdmissionId(r.attemptId);reportId(r.reportId);
    r.binding=parseSourceAdmissionBinding(r.binding);r.sourceBinding=parseSourceAdmissionBinding(r.sourceBinding);
    sourceAdmissionHash(r.answerHash);sourceAdmissionHash(r.receiptHash);
    if(typeof r.answerRevision!=='number'||!Number.isSafeInteger(r.answerRevision)||r.answerRevision<0)
        throw Error('source-admission-code-hint-revision');
    if(status==='ready'){
        const hint=sourceAdmissionFields(r.hint,['text','sourceQuote','codeQuote','reason']);
        text(hint.text,300);for(const field of ['sourceQuote','codeQuote','reason'])text(hint[field],1000);
        if((hint.text as string).includes('```')
            ||/^[ \t]*(?:async\s+)?(?:def|class)\s+/mu.test(hint.text as string)
            ||/^[ \t]*\w+\s*=\s*lambda\b/mu.test(hint.text as string))
            throw Error('source-admission-code-hint-complete-code');
        r.hint=hint;
    }else text(r.reason,1000);
    return r as SourceCodeHintReceipt;
}
export function validateSourceCodeHintRequest(request:SourceCodeHintRequest,expected:SourceCodeHintExpected):void{
    if(request.attemptId!==expected.submission.attemptId||request.reportId!==expected.reportId)
        throw Error('source-admission-code-hint-binding');
    reportId(expected.reportId);
    if(typeof expected.submission.answer!=='string')throw Error('source-admission-code-hint-answer');
}
export async function validateSourceCodeHintReceipt(receipt:SourceCodeHintReceipt,request:SourceCodeHintRequest,
    expected:SourceCodeHintExpected,fingerprint:SourceAdmissionFingerprint):Promise<void>{
    validateSourceCodeHintRequest(request,expected);
    if(receipt.attemptId!==request.attemptId||receipt.requestId!==request.requestId||receipt.reportId!==request.reportId
        ||!sameSourceAdmission(receipt.binding,expected.submission.binding)||!sameSourceAdmission(receipt.sourceBinding,expected.sourceBinding)
        ||receipt.answerRevision!==expected.submission.answerRevision)throw Error('source-admission-code-hint-binding');
    if(receipt.answerHash!==sourceAdmissionHash(await fingerprint(expected.submission.answer)))throw Error('source-admission-answer-hash');
    if(receipt.status==='ready'&&!(expected.submission.answer as string).includes(receipt.hint.codeQuote))
        throw Error('source-admission-code-hint-code-quote');
    const {receiptHash,...body}=receipt;
    if(receiptHash!==sourceAdmissionHash(await fingerprint(body)))throw Error('source-admission-code-hint-hash');
}
