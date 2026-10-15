import type {SourceCodeReport,SourceCodeReportReceipt,SourceAdmissionSubmission,SourceAdmissionFingerprint} from './types';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseCodeRunReport} from '../code-execution/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {sourceAdmissionFields,sourceAdmissionId,sourceAdmissionHash,sourceAdmissionTime,parseSourceAdmissionBinding} from './fields.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {sameSourceAdmission,canonicalSourceAdmissionJson} from './json.ts';

/** Validate without rewriting the original declaration whose hash the server retains. */
export function parseSourceCodeReport(raw:unknown):SourceCodeReport{
    const r=sourceAdmissionFields(raw,['schemaVersion','attemptId','binding','answerRevision','submittedAt','report']);
    if(r.schemaVersion!==1)throw Error('source-admission-code-report-version');
    sourceAdmissionId(r.attemptId);r.binding=parseSourceAdmissionBinding(r.binding);sourceAdmissionTime(r.submittedAt);
    if(typeof r.answerRevision!=='number'||!Number.isSafeInteger(r.answerRevision)||r.answerRevision<0)
        throw Error('source-admission-code-report-revision');
    const identity=parseCodeRunReport(r.report).identity,binding=r.binding as SourceCodeReport['binding'];
    if(!identity||identity.attemptId!==r.attemptId||identity.revision!==r.answerRevision
        ||identity.sourceVersion!==binding.contentHash||identity.testVersion!==binding.contentHash)
        throw Error('source-admission-code-report-identity');
    return r as SourceCodeReport;
}
export function parseSourceCodeReportReceipt(raw:unknown):SourceCodeReportReceipt{
    const r=sourceAdmissionFields(raw,['schemaVersion','durable','reportId','evidence','evidenceHash','provenance']);
    if(r.schemaVersion!==1||r.durable!==true||r.provenance!=='client-public-tests')throw Error('source-admission-code-report-receipt');
    sourceAdmissionHash(r.evidenceHash);
    if(r.reportId!=='code-report:'+r.evidenceHash)throw Error('source-admission-code-report-hash');
    r.evidence=parseSourceCodeReport(r.evidence);return r as SourceCodeReportReceipt;
}
export function validateSourceCodeBinding(request:SourceCodeReport,submission:SourceAdmissionSubmission):void{
    if(request.attemptId!==submission.attemptId||request.answerRevision!==submission.answerRevision
        ||request.submittedAt!==submission.submittedAt||!sameSourceAdmission(request.binding,submission.binding))
        throw Error('source-admission-code-report-binding');
}
export async function validateSourceCodeReceipt(receipt:SourceCodeReportReceipt,request:SourceCodeReport,
    submission:SourceAdmissionSubmission,fingerprint:SourceAdmissionFingerprint):Promise<void>{
    validateSourceCodeBinding(request,submission);validateSourceCodeBinding(receipt.evidence,submission);
    if(!sameSourceAdmission(receipt.evidence,request)||receipt.evidenceHash!==await fingerprint(request))
        throw Error('source-admission-code-report-hash');
}
export function parseSourceCodeReports(raw:unknown):SourceCodeReportReceipt[]{
    if(!Array.isArray(raw))throw Error('source-admission-code-report-receipt');
    const reports=raw.map(parseSourceCodeReportReceipt),ids=new Set(reports.map(row=>row.reportId));
    if(ids.size!==reports.length||reports.reduce((size,row)=>size+new TextEncoder().encode(canonicalSourceAdmissionJson(row)).byteLength,0)>350000)
        throw Error('source-admission-code-report-size');
    return reports;
}
