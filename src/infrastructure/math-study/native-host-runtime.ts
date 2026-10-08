import type {NonWordHostScope,NonWordRuntimePort} from '../../application/nonword-study';
import type {NonWordRuntime} from '../nonword-study';
import type {NativeMathIdentity,NativeMathItem,NativeMathCapture,NativeMathTransport} from '../../domain/math-study';
import type {MathStudyRequestV1,MathStudyResultV1} from '../../application/math-study';
import type {MathVariant} from '../../domain/guided-math';
import type {PracticeVariantRecoveryV1} from '../../domain/practice-evidence';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseNativeMathIdentity,parseNativeMathItem,parseNativeMathCapture,assertNativeMathCaptureBinding,resolveNativeMathSupport,parseNativeMathClaim,nativeMathLogicalClaim,validateNativeMathReceipt} from '../../domain/math-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalAttemptJson} from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyHash} from '../../domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createLocalAttemptRepository} from '../learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createLocalPracticeEvidenceRepository,attachPracticeDriver} from '../practice-evidence/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createNativeMathSourceCache} from './native-source-cache.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createCourseRequestJournal} from '../course-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createNativeMathMappingCache} from './native-mapping-cache.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {rebuildNativeMathVariant} from '../../domain/math-study/index.ts';

type NativeScope=NonWordHostScope&{nativeMathIdentity?:NativeMathIdentity;nativeMathPresentation?:NativeMathItem;nativeMathCapture?:NativeMathCapture};
const same=(a:unknown,b:unknown)=>canonicalAttemptJson(a)===canonicalAttemptJson(b);
function matches(scope:NonWordHostScope,i:NativeMathIdentity):boolean{
    return !scope.cloud&&scope.snapshotId==='local'&&scope.libraryId===i.libraryId&&scope.itemKey===i.itemKey&&scope.contentHash===i.contentHash;
}
/** Display metadata permits an ungraded draft. Only a paired frozen capture permits grading. */
export async function nativeMathTask(scope:NativeScope,purpose:string,parentId?:string,transport?:NativeMathTransport){
    if(scope.cloud||!scope.nativeMathIdentity)return null;
    const identity=parseNativeMathIdentity(scope.nativeMathIdentity);if(!matches(scope,identity))throw Error('native-math-source-binding');
    const storage={userId:scope.ownerId,libraryId:scope.libraryId},cache=createNativeMathSourceCache(storage);
    let capture:NativeMathCapture|null=null;
    if(parentId){
        if(purpose!=='remediation')throw Error('native-math-parent-purpose-binding');
        const parent=await createLocalAttemptRepository(storage).read(parentId);
        if(!parent||parent.binding.ownerId!==scope.ownerId||parent.checkpoint.mode!=='calculation')throw Error('native-math-parent-binding');
        capture=await cache.read(parent.binding,parentId);
        if(!capture||!same(capture.identity,identity))throw Error('native-math-parent-source-binding');
    }else{
        if(scope.nativeMathCapture){capture=await parseNativeMathCapture(scope.nativeMathCapture);
            if(!same(capture.identity,identity))throw Error('native-math-source-binding');await cache.save(capture);
        }else capture=await cache.byIdentity(identity);
        if(!capture&&transport?.supported()){
            try{capture=await parseNativeMathCapture(await transport.capture(identity));
                if(!same(capture.identity,identity))throw Error('native-math-source-binding');await cache.save(capture);
            }catch(error){if(error instanceof Error&&/binding|integrity|conflict/.test(error.message))throw error;capture=null;}
        }
    }
    const raw=capture?.item??scope.nativeMathPresentation;if(!raw)return null;
    const item=parseNativeMathItem(raw,identity),support=resolveNativeMathSupport(item);
    if(!support)return null;
    return {identity,capture,item,support,cache};
}
type RuntimeDriver={runtime:NonWordRuntimePort;restore:()=>Record<string,unknown>;fields:(values:Record<string,unknown>)=>Record<string,string>;
    answer:(values:Record<string,unknown>)=>string;phase:()=> 'answering'|'submitted'|'feedback'|'lesson'};
type Prepared=NonNullable<Awaited<ReturnType<typeof nativeMathTask>>>;
/** Binds the actual browser-saved original before any Companion evaluation. */
export async function attachNativeMathDriver<T extends RuntimeDriver>(driver:T,runtime:NonWordRuntime,prepared:Prepared,transport?:NativeMathTransport){
    const snapshot=runtime.session.snapshot(),scope=runtime.scope,capture=prepared.capture;
    if(!snapshot||!matches(scope,prepared.identity)||snapshot.checkpoint.mode!=='calculation')throw Error('native-math-attempt-source-binding');
    const initial=snapshot;
    if(capture){assertNativeMathCaptureBinding(capture,initial.binding);await prepared.cache.bindAttempt(initial.attemptId,initial.binding,capture.captureId);}
    const mappingCache=capture?createNativeMathMappingCache(scope,capture):null;
    let approved=await mappingCache?.read()??null,active:MathVariant|null=null;
    if(capture&&mappingCache&&prepared.support.schemaVersion===2&&prepared.support.variantMappingId&&transport?.variantSupported?.()&&transport.mapping){
        try{const record=await transport.mapping(capture);if(record){await mappingCache.save(record);approved=record;}}
        catch(error){if(error instanceof Error&&/binding|integrity|conflict|invalid|version|unknown-study-field/.test(error.message))throw error;}
    }
    const resolveSource=async(attempt:typeof initial)=>{
        if(!attempt||!capture||!same(attempt.binding,initial.binding))return null;
        const saved=await prepared.cache.read(attempt.binding,attempt.attemptId);
        if(!saved||saved.captureId!==capture.captureId)return null;
        const calculation=resolveNativeMathSupport(saved.item);
        const mapping=(await mappingCache?.read())?.preparation.mapping;
        return calculation?{binding:attempt.binding,calculation,...(mapping?{mapping}:{})}:null;
    };
    const evidence=createLocalPracticeEvidenceRepository({ownerId:scope.ownerId,libraryId:scope.libraryId},{readAttempt:id=>runtime.repository.read(id),resolveSource});
    const journal=createCourseRequestJournal({userId:scope.ownerId,libraryId:scope.libraryId});
    let tail:Promise<unknown>=Promise.resolve();
    const cancelled=(signal?:AbortSignal)=>{if(signal?.aborted)throw Error('native-math-cancelled');};
    const restoreVariant=async(descriptor:PracticeVariantRecoveryV1)=>{
        if(!capture||!approved)throw Error('native-math-variant-approved-source-unavailable');
        const saved=await runtime.repository.read(initial.attemptId),parent=saved?.parentAttemptId?await runtime.repository.read(saved.parentAttemptId):null;
        const parentDetails=parent?await evidence.read(parent.attemptId):null,parentSource=parent?await prepared.cache.read(parent.binding,parent.attemptId):null;
        if(!saved||saved.formal||saved.checkpoint.purpose!=='remediation'||!parent?.submitted||parent.checkpoint.mode!=='calculation'
            ||!same(parent.binding,saved.binding)||parentDetails?.variant||parentSource?.captureId!==capture.captureId)throw Error('native-math-variant-parent-binding');
        const rebuilt=await rebuildNativeMathVariant(capture,approved,descriptor.seed);
        if(!same(descriptor,rebuilt.descriptor))throw Error('native-math-variant-descriptor-binding');return rebuilt.variant;
    };
    const getVariant=async(seed:number,signal?:AbortSignal)=>{
        const run=tail.then(async()=>{
        cancelled(signal);if(!capture||!approved||active)return null;
        const saved=await runtime.repository.read(initial.attemptId),details=await evidence.read(initial.attemptId);
        if(!saved?.submitted||!same(saved.binding,initial.binding)||details?.variant)throw Error('native-math-variant-submitted-parent-unavailable');
        const rebuilt=await rebuildNativeMathVariant(capture,approved,seed);
        if(transport?.variantSupported?.()&&transport.variant){
            try{
                const step=details?.calculation?.stepInput;
                const candidate=parseNativeMathClaim({schemaVersion:1,identity:prepared.identity,captureId:capture.captureId,attempt:{...saved,formal:null},
                    ...(step?{stepInput:{...step,answerRevision:saved.submitted.answerRevision}}:{})});
                const old=await prepared.cache.readClaim(saved.attemptId);
                if(old&&!same(nativeMathLogicalClaim(old),nativeMathLogicalClaim(candidate)))throw Error('native-math-frozen-claim-conflict');
                await prepared.cache.saveClaim(old??candidate);const claim=(await prepared.cache.readClaim(saved.attemptId))!;
                await transport.claim(claim,signal);cancelled(signal);
                const remote=await transport.variant(capture,saved.attemptId,seed,approved,signal);cancelled(signal);
                if(remote&&!same(remote,rebuilt))throw Error('native-math-variant-response-binding');
                const current=await runtime.repository.read(saved.attemptId),source=current&&await prepared.cache.read(current.binding,current.attemptId);
                if(!current||!same(current.binding,saved.binding)||!same(current.submitted,saved.submitted)||source?.captureId!==capture.captureId)throw Error('native-math-variant-late-binding');
                if(remote)return rebuilt;
            }catch(error){cancelled(signal);if(error instanceof Error&&/binding|integrity|conflict|invalid|unsupported/.test(error.message))throw error;}
        }
        cancelled(signal);return rebuilt;
        });tail=run.catch(()=>{});return run;
    };
    const saveBarrier=async()=>{
        const saved=await runtime.repository.read(initial.attemptId),formal=saved?.formal;
        if(!formal||formal.status!=='linked')return;
        if(saved.parentAttemptId||saved.checkpoint.purpose!=='first'||!saved.submitted||saved.evaluation.status!=='resolved'
            ||formal.evaluationHash!==saved.evaluation.evaluationHash||!formal.coreHash)throw Error('native-math-formal-binding');
        if(!transport?.supported())throw Error('native-math-unsupported');
        await transport.formal({schemaVersion:1,action:'formal',attemptId:saved.attemptId,answerRevision:saved.submitted.answerRevision,
            sourceVersion:saved.binding.contentHash,eventId:formal.eventId,evaluationHash:formal.evaluationHash,occurredAt:saved.submitted.submittedAt,coreHash:formal.coreHash});
    };
    async function evaluate(request:MathStudyRequestV1,signal?:AbortSignal):Promise<MathStudyResultV1>{
        const run=tail.then(async()=>{
            cancelled(signal);if(!capture)throw Error('native-math-source-capture-required');
            const saved=await runtime.repository.read(initial.attemptId),details=await evidence.read(initial.attemptId);
            if(!saved?.submitted||saved.attemptId!==request.attemptId||request.answerRevision!==saved.submitted.answerRevision||request.sourceVersion!==saved.binding.contentHash
                ||!same(saved.binding,initial.binding)||saved.checkpoint.purpose!==runtime.purpose)throw Error('native-math-submission-binding');
            if(saved.formal&&request.mode==='final')throw Error('math-formal-existing-result');
            if(details&&!same(details.binding,saved.binding))throw Error('native-math-evidence-binding');
            const association=await prepared.cache.read(saved.binding,saved.attemptId);
            if(!association||association.captureId!==capture.captureId)throw Error('native-math-source-binding');
            const step=details?.calculation?.stepInput;
            if(request.stepRevision!==undefined&&request.stepRevision!==step?.revision)throw Error('native-math-step-revision-binding');
            const candidate=parseNativeMathClaim({schemaVersion:1,identity:prepared.identity,captureId:capture.captureId,attempt:{...saved,formal:null},
                ...(step?{stepInput:{...step,answerRevision:saved.submitted.answerRevision}}:{}),...(details?.variant?{variant:details.variant}:{})});
            let claim=await prepared.cache.readClaim(saved.attemptId);
            if(claim&&!same(nativeMathLogicalClaim(claim),nativeMathLogicalClaim(candidate)))throw Error('native-math-frozen-claim-conflict');
            const oldDiagnostic=details?.calculation?.diagnostic;
            const authoredStep=prepared.support.schemaVersion===2?prepared.support.step:undefined;
            if(request.mode==='step'&&claim&&oldDiagnostic&&oldDiagnostic.status!=='undetermined'&&step&&authoredStep
                &&oldDiagnostic.answerRevision===saved.submitted.answerRevision&&oldDiagnostic.stepRevision===step.revision
                &&oldDiagnostic.stepId===authoredStep.stepId&&oldDiagnostic.sourceVersion===saved.binding.contentHash){
                cancelled(signal);
                return {schemaVersion:1 as const,attemptId:saved.attemptId,answerRevision:saved.submitted.answerRevision,
                    sourceVersion:saved.binding.contentHash,step:oldDiagnostic};
            }
            if(!transport?.supported())throw Error('native-math-source-capture-required');
            if(!claim){
                // Recover an already admitted claim after a browser receipt loss; do not silently replace frozen input.
                try{const old=await transport.recover(saved.attemptId,undefined,signal);claim=parseNativeMathClaim(old.claim);}
                catch(error){cancelled(signal);if(!(error instanceof Error)||!/attempt-not-found/.test(error.message))throw error;}
            }
            if(claim&&!same(nativeMathLogicalClaim(claim),nativeMathLogicalClaim(candidate)))throw Error('native-math-frozen-claim-conflict');
            await prepared.cache.saveClaim(claim??candidate);claim=(await prepared.cache.readClaim(saved.attemptId))!;
            cancelled(signal);await transport.claim(claim,signal);cancelled(signal);
            if(saved.formal)await saveBarrier();
            const journalKey='native-math-v1:'+await studyHash({schemaVersion:1,claim:nativeMathLogicalClaim(claim),mode:request.mode,...(request.stepRevision!==undefined?{stepRevision:request.stepRevision}:{})});
            // Unknown transport outcomes retain the same request. Only an authenticated durable pending
            // receipt allows the next explicit learner retry to prepare a fresh service attempt.
            const requestId=await journal.request(journalKey,()=>`math:${crypto.randomUUID()}`);
            const nativeRequest={...request,requestId};
            const receipt=await validateNativeMathReceipt(await transport.evaluate(nativeRequest,signal),nativeRequest,claim,capture);
            cancelled(signal);
            const current=await runtime.repository.read(saved.attemptId),currentDetails=await evidence.read(saved.attemptId),currentSource=current&&await prepared.cache.read(current.binding,current.attemptId);
            if(!current||!same(current.binding,saved.binding)||!same(current.submitted,saved.submitted)||currentSource?.captureId!==capture.captureId
                ||!same(currentDetails?.calculation?.stepInput,step)||!same(currentDetails?.variant,details?.variant)||request.mode==='final'&&current.formal)throw Error('native-math-late-result-binding');
            if(request.mode==='step'&&(!receipt.step||receipt.step.status==='undetermined'||receipt.step.source==='none')
                ||request.mode==='final'&&receipt.final?.status==='undetermined')await journal.complete(journalKey,requestId);
            return {schemaVersion:1 as const,attemptId:receipt.attemptId,answerRevision:receipt.answerRevision,sourceVersion:receipt.sourceVersion,
                ...(receipt.final?{final:receipt.final}:{}),...(receipt.step?{step:receipt.step}:{})};
        });
        tail=run.catch(()=>{});return run;
    }
    const attached=await attachPracticeDriver(driver,runtime,{resolveSource,calculation:{support:prepared.support,sourceLabel:prepared.item.practice.sourceLabel,evaluate,persistLocalDiagnostic:true,
        canVariant:Boolean(approved&&transport?.variantSupported?.()),activeVariant:()=>active,...(approved?{getVariant,prepareVariant:restoreVariant}:{})}});
    const calculation=attached.runtime.practice.calculation!,oldPrepare=calculation.prepareVariant;
    if(oldPrepare)calculation.prepareVariant=async descriptor=>{await oldPrepare(descriptor);active=await restoreVariant(descriptor);};
    const descriptor=attached.runtime.practice.snapshot()?.variant;if(descriptor)active=await restoreVariant(descriptor);
    const answer=(values:Record<string,unknown>)=>{
        if(!active)return driver.answer(values);const kind=String(values.calculationAnswerKind??'number');
        if(!['number','none','all','allowed','not-allowed'].includes(kind))throw Error('native-math-variant-answer-kind');
        return JSON.stringify({answerKind:kind,answer:kind==='number'?String(values.value??''):''});
    };
    const originalAfter=attached.runtime.afterWrite;
    return {...attached,answer,fields:(values:Record<string,unknown>)=>active?{value:answer(values),phase:values.result?'feedback':'answer'}:driver.fields(values),
        restore:()=>{
            const values=driver.restore();if(!active)return values;const saved=runtime.session.snapshot()!,raw=saved.checkpoint.pluginFields?.value??saved.submitted?.answer??saved.answer;
            if(!raw)return {...values,value:'',calculationAnswerKind:'number'};
            let input;try{input=JSON.parse(raw);}catch{throw Error('native-math-variant-answer-format');}
            if(!input||typeof input.answer!=='string'||!['number','none','all','allowed','not-allowed'].includes(input.answerKind)
                ||Object.keys(input).sort().join(',')!=='answer,answerKind')throw Error('native-math-variant-answer-format');
            return {...values,value:input.answer,calculationAnswerKind:input.answerKind};
        },runtime:{...attached.runtime,async afterWrite(){await originalAfter();
        const job=tail.then(async()=>{if(capture&&transport?.supported()&&await prepared.cache.readClaim(initial.attemptId))await saveBarrier();});
        tail=job.catch(()=>{});await job;}}};
}
