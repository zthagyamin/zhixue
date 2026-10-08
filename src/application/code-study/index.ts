import type {AccountContext,AccountReply,Authenticated} from '../account-study';
import type {PracticeEvidenceHint,PracticeEvidenceV1} from '../../domain/practice-evidence';
// @ts-expect-error TS5097: standalone Node contracts.
import {AccountFailure} from '../../domain/account-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject,studyId,studyHash} from '../../domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {courseEvidenceOriginal} from '../course-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {evidenceEqual,parsePracticeEvidenceHint} from '../../domain/practice-evidence/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseCodeLearningSupportV1} from '../../domain/content/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {controlledPracticeAi} from '../math-study/index.ts';
export type CodeHintRequestV1={schemaVersion:1;attemptId:string;answerRevision:number;sourceVersion:string;runId:number;caseId?:string};
export type CodeHintResultV1={status:'accepted'|'duplicate'|'pending';hint?:PracticeEvidenceHint;evidence?:PracticeEvidenceV1};
export function parseCodeHintRequest(raw:unknown):CodeHintRequestV1{
    const r=studyObject(raw,['schemaVersion','attemptId','answerRevision','sourceVersion','runId'],['caseId']);
    studyId(r.attemptId);if(r.caseId!==undefined)studyId(r.caseId);
    if(r.schemaVersion!==1||!Number.isSafeInteger(r.answerRevision)||(r.answerRevision as number)<0||!Number.isSafeInteger(r.runId)||(r.runId as number)<1
        ||typeof r.sourceVersion!=='string'||!/^[a-f0-9]{64}$/.test(r.sourceVersion))throw Error('invalid-code-hint-request');
    return r as CodeHintRequestV1;
}
/** Explicit account intent only; no formal event/evaluation writer and no client answer/reference authority. */
export async function executeCodeHintAction(body:Record<string,unknown>,auth:Authenticated,context:AccountContext,signal:AbortSignal):Promise<AccountReply|null>{
    if(body.action!=='code-hint')return null;
    context.requireRole(auth.principal,'browser');
    const scope=await context.scope(auth.principal,body.libraryId);
    try{
        studyObject(body,['action','requestId','request'],['libraryId']);studyId(body.requestId);
        const r=parseCodeHintRequest(body.request),attempts=await context.deps.getAttemptStore?.();
        if(!attempts||!await attempts.supported())throw new AccountFailure(409,'learning-attempts-unsupported');
        const a=await attempts.read(scope,r.attemptId);
        if(!a?.submitted||a.attemptId!==r.attemptId||a.checkpoint.mode!=='code'||a.binding.ownerId!==scope.userId||a.binding.libraryId!==scope.libraryId
            ||a.submitted.answerRevision!==r.answerRevision||a.binding.contentHash!==r.sourceVersion)throw Error('code-hint-attempt-binding');
        const original=courseEvidenceOriginal(await context.deps.getStudyStore(),attempts),item=await original.readItem(scope,a.binding);
        if(!item||item.kind!=='practice'||item.practice.questionType!=='code')throw Error('code-hint-original-unavailable');
        let approved:PracticeEvidenceHint|null=null;
        const store=await context.deps.getPracticeEvidenceStore?.({resolveModelHint:async input=>approved&&evidenceEqual(input.hint,approved)
            &&evidenceEqual(input.attempt.binding,a.binding)&&input.attempt.submitted?.answerRevision===r.answerRevision&&input.attempt.submitted.answer===a.submitted!.answer?approved:null});
        if(!store||!await store.supported())throw Error('practice-evidence-unsupported');
        const evidence=await store.read(scope,r.attemptId),report=evidence?.execution?.latest;
        if(!evidence||evidence.attemptId!==a.attemptId||!evidenceEqual(evidence.binding,a.binding)||!report||report.runId!==r.runId||!report.identity
            ||report.identity.attemptId!==r.attemptId||report.identity.revision!==r.answerRevision||report.identity.sourceVersion!==r.sourceVersion
            ||report.identity.testVersion!==r.sourceVersion||r.caseId!==report.firstFailure?.caseId)throw Error('code-hint-report-binding');
        const support=item.learningSupport===undefined?null:parseCodeLearningSupportV1(item.learningSupport);
        if(report.firstFailure){
            const c=support?.cases.find(c=>c.id===r.caseId),failure=report.firstFailure;
            if(!c||!evidenceEqual(c.args,failure.args)||!evidenceEqual(c.kwargs,failure.kwargs)||!evidenceEqual(c.expected,failure.expected)||c.functionName!==failure.functionName)
                throw Error('code-hint-case-source-binding');
        }
        const existing=evidence.execution?.hint;
        if(existing?.source==='model'&&existing.runId===r.runId&&existing.caseId===r.caseId)return {kind:'value',status:200,value:{status:'duplicate',hint:existing,evidence}};
        const source={question:item.practice.prompt,testCode:item.practice.testCode??'',support},code=a.submitted.answer;
        const frozen={attemptId:a.attemptId,binding:a.binding,answerRevision:r.answerRevision,source,code,report};
        const hint=await controlledPracticeAi({context,scope,requestId:body.requestId as string,kind:'code-hint',input:frozen,signal,validate:raw=>{
            const out=studyObject(raw,['text','sourceQuote','codeQuote','reason']);
            if(typeof out.text!=='string'||!out.text.trim()||out.text.length>1000||/```|(?:^|\n)\s*(?:def |class |import |from )/m.test(out.text)
                ||typeof out.sourceQuote!=='string'||!out.sourceQuote.trim()||!JSON.stringify(source).includes(out.sourceQuote)&&!source.question.includes(out.sourceQuote)&&!source.testCode.includes(out.sourceQuote)
                ||typeof out.codeQuote!=='string'||!out.codeQuote.trim()||!code.includes(out.codeQuote)||typeof out.reason!=='string'||!out.reason.trim()||out.reason.length>2000)
                throw Error('practice-ai-output-invalid');
            return parsePracticeEvidenceHint({runId:r.runId,...(r.caseId===undefined?{}:{caseId:r.caseId}),text:out.text,source:'model'});
        }});
        if(!hint)return {kind:'value',status:200,value:{status:'pending',evidence}};
        if(signal.aborted)throw Error('code-hint-cancelled');
        const latest=await attempts.read(scope,a.attemptId),current=await store.read(scope,a.attemptId),currentItem=await original.readItem(scope,a.binding);
        if(!latest?.submitted||!evidenceEqual(latest.binding,a.binding)||latest.submitted.answerRevision!==r.answerRevision||latest.submitted.answer!==code
            ||!evidenceEqual(current?.execution?.latest,report)||!evidenceEqual(currentItem,item))throw Error('code-hint-current-binding');
        approved=hint;
        let receipt;
        try{receipt=await store.trustedWriter().mutate(scope,{schemaVersion:1,kind:'code-hint',operationId:`ch:${await studyHash([body.requestId,hint])}`,
            attemptId:a.attemptId,binding:a.binding,expectedRevision:current!.revision,updatedAt:context.deps.now().toISOString(),hint});}
        catch{throw new AccountFailure(503,'code-hint-evidence-receipt-unknown');}
        if(!receipt.durable||receipt.status==='conflict'||!receipt.record)throw Error('code-hint-evidence-conflict');
        return {kind:'value',status:200,value:{status:receipt.status,hint,evidence:receipt.record}};
    }catch(error){
        if(error instanceof AccountFailure)throw error;
        const code=error instanceof Error?error.message:'';
        if(code==='practice-ai-receipt-unknown')throw new AccountFailure(503,code);
        if(/^(code-hint-|practice-)/.test(code))throw new AccountFailure(409,code);
        throw new AccountFailure(400,'invalid-code-hint-request');
    }
}
