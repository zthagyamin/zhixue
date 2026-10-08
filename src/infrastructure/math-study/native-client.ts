import type {NativeMathTransport,NativeMathIdentity,NativeMathClaim,NativeMathFormal} from '../../domain/math-study';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseNativeMathIdentity,parseNativeMathCapture,parseNativeMathClaim,nativeMathClaimHash,parseNativeMathRequest,parseNativeMathReceipt,parseNativeMathFormal} from '../../domain/math-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject,studyId,studyDigest,studyHash} from '../../domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalAttemptJson} from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {validateNativeMathMappingRecord,validateNativeMathVariant,rebuildNativeMathVariant} from '../../domain/math-study/index.ts';

type Response={ok:boolean;status:number;json:()=>Promise<unknown>};
type Options={baseUrl:string;sessionToken:string;capabilities?:readonly string[];fetcher?:(url:string,init?:RequestInit)=>Promise<Response>;timeoutMs?:number};
const same=(a:unknown,b:unknown)=>canonicalAttemptJson(a)===canonicalAttemptJson(b);
/** Authenticated loopback transport. Hash verification does not certify local persistence. */
export function createNativeMathClient(options:Options):NativeMathTransport{
    const supported=()=>Boolean(options.capabilities?.includes('native-math-v1')),fetcher=options.fetcher??fetch;
    async function post(path:string,body:unknown,signal?:AbortSignal,timeout=15000):Promise<unknown>{
        if(!supported())throw Error('native-math-unsupported');
        const endpoint=new URL(options.baseUrl);
        if(endpoint.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)||endpoint.username||endpoint.password
            ||endpoint.search||endpoint.hash||endpoint.pathname!=='/'||!/^\d{4,5}$/.test(endpoint.port)||Number(endpoint.port)<1024||Number(endpoint.port)>65535)
            throw Error('native-math-endpoint-invalid');
        const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,stop=()=>{};
        const cancelled=new Promise<never>((_,reject)=>{
            stop=()=>{controller.abort();reject(Error('native-math-cancelled'));};signal?.addEventListener('abort',stop,{once:true});
            timer=setTimeout(()=>{controller.abort();reject(Error('native-math-receipt-unavailable'));},options.timeoutMs??timeout);
            if(signal?.aborted)stop();
        });
        try{return await Promise.race([cancelled,Promise.resolve().then(async()=>{
            if(controller.signal.aborted)throw Error('native-math-cancelled');
            const response=await fetcher(endpoint.origin+path,{method:'POST',headers:{'Content-Type':'application/json','X-Study-Loop-Session':options.sessionToken},
                body:JSON.stringify(body),signal:controller.signal,redirect:'error',credentials:'omit'});
            const result=await response.json();if(controller.signal.aborted)throw Error('native-math-cancelled');
            if(!response.ok){const code=(result as {error?:unknown})?.error;throw Error(typeof code==='string'&&/^native-math-[a-z-]+$/.test(code)?code:'native-math-receipt-unavailable');}
            return result;
        })]);}finally{if(timer!==undefined)clearTimeout(timer);signal?.removeEventListener('abort',stop);}
    }
    async function source(action:'capture'|'read',raw:NativeMathIdentity,captureId?:string,signal?:AbortSignal){
        const identity=parseNativeMathIdentity(raw);if(captureId!==undefined)studyDigest(captureId);
        const r=studyObject(await post('/v1/math/source/'+action,{schemaVersion:1,identity,...(captureId?{captureId}:{})},signal),['schemaVersion','durable','capture']);
        if(r.schemaVersion!==1||r.durable!==true)throw Error('native-math-source-receipt');
        const capture=await parseNativeMathCapture(r.capture);
        if(!same(capture.identity,identity)||captureId&&capture.captureId!==captureId)throw Error('native-math-source-receipt-binding');
        if(signal?.aborted)throw Error('native-math-cancelled');return capture;
    }
    const variantSupported=()=>supported()&&Boolean(options.capabilities?.includes('native-math-variants-v1'));
    return {supported,variantSupported,
        async mapping(raw,signal){
            if(!variantSupported())throw Error('native-math-variants-unsupported');const capture=await parseNativeMathCapture(raw);
            const result=await post('/v1/math/mapping/read',{schemaVersion:1,identity:capture.identity,captureId:capture.captureId},signal);
            if((result as {status?:unknown})?.status==='unavailable'){
                const r=studyObject(result,['schemaVersion','durable','status','reason']);
                if(r.schemaVersion!==1||r.durable!==true||r.reason!=='missing-approved-mapping')throw Error('native-math-mapping-response-binding');return null;
            }
            const r=studyObject(result,['schemaVersion','durable','status','record']);
            if(r.schemaVersion!==1||r.durable!==true||r.status!=='available')throw Error('native-math-mapping-response-binding');
            const record=await validateNativeMathMappingRecord(r.record,capture);if(signal?.aborted)throw Error('native-math-cancelled');return record;
        },
        async variant(raw,attemptId,seed,approved,signal){
            if(!variantSupported())throw Error('native-math-variants-unsupported');studyId(attemptId);const capture=await parseNativeMathCapture(raw);
            // Rebuild first to reject unsafe seed or source before sending authenticated material.
            await rebuildNativeMathVariant(capture,approved,seed);
            const result=await post('/v1/math/variant',{schemaVersion:1,identity:capture.identity,captureId:capture.captureId,attemptId,seed},signal);
            const variant=await validateNativeMathVariant(result,capture,approved,seed);if(signal?.aborted)throw Error('native-math-cancelled');return variant;
        },capture:(identity,signal)=>source('capture',identity,undefined,signal),read:(identity,captureId,signal)=>source('read',identity,captureId,signal),
        async claim(raw:NativeMathClaim,signal){
            const claim=parseNativeMathClaim(raw),r=studyObject(await post('/v1/math/claim',claim,signal),['schemaVersion','durable','attemptId','answerRevision','captureId','claimHash']);
            if(r.schemaVersion!==1||r.durable!==true||r.attemptId!==claim.attempt.attemptId||r.answerRevision!==claim.attempt.submitted!.answerRevision
                ||r.captureId!==claim.captureId||r.claimHash!==await nativeMathClaimHash(claim))throw Error('native-math-claim-receipt-binding');
            if(signal?.aborted)throw Error('native-math-cancelled');return r as Awaited<ReturnType<NativeMathTransport['claim']>>;
        },
        async evaluate(raw,signal){
            const request=parseNativeMathRequest(raw),r=await parseNativeMathReceipt(await post('/v1/math/evaluate',request,signal,60000));
            if(r.requestId!==request.requestId||r.attemptId!==request.attemptId||r.answerRevision!==request.answerRevision||r.sourceVersion!==request.sourceVersion
                ||request.mode==='step'&&r.final!==undefined||request.mode==='final'&&!r.final)throw Error('native-math-result-binding');
            if(signal?.aborted)throw Error('native-math-cancelled');return r;
        },
        async recover(attemptId,requestId,signal){
            studyId(attemptId);if(requestId!==undefined)studyId(requestId);
            const r=studyObject(await post('/v1/math/read',{schemaVersion:1,attemptId,...(requestId?{requestId}:{})},signal),['schemaVersion','durable','claim','results','formalBarrier']);
            const claim=parseNativeMathClaim(r.claim);
            if(r.schemaVersion!==1||r.durable!==true||claim.attempt.attemptId!==attemptId||!Array.isArray(r.results)||r.results.length>1000)throw Error('native-math-read-binding');
            const results=await Promise.all(r.results.map(parseNativeMathReceipt));
            if(results.some(row=>row.attemptId!==attemptId||row.answerRevision!==claim.attempt.submitted!.answerRevision||row.sourceVersion!==claim.identity.contentHash||requestId&&row.requestId!==requestId))throw Error('native-math-read-binding');
            const formalBarrier=r.formalBarrier===null?null:parseNativeMathFormal(r.formalBarrier);
            if(formalBarrier&&(formalBarrier.attemptId!==attemptId||formalBarrier.answerRevision!==claim.attempt.submitted!.answerRevision||formalBarrier.sourceVersion!==claim.identity.contentHash))throw Error('native-math-formal-binding');
            if(signal?.aborted)throw Error('native-math-cancelled');return {schemaVersion:1,durable:true,claim,results,formalBarrier};
        },
        async formal(raw:NativeMathFormal,signal){
            const request=parseNativeMathFormal(raw),r=studyObject(await post('/v1/math/claim',request,signal),['schemaVersion','durable','status','attemptId','eventId','claimHash']);
            if(r.schemaVersion!==1||r.durable!==true||r.status!=='barrier-saved'||r.attemptId!==request.attemptId||r.eventId!==request.eventId
                ||r.claimHash!==await studyHash(request))throw Error('native-math-formal-receipt-binding');
            if(signal?.aborted)throw Error('native-math-cancelled');return r as Awaited<ReturnType<NativeMathTransport['formal']>>;
        }};
}
