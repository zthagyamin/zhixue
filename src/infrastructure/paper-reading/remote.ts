import type {PaperReadingScope,PaperReadingRemotePort,PaperReadingReceipt} from '../../application/paper-reading';
import type {PaperReadingWorkspaceV1} from '../../domain/paper-reading';
// @ts-expect-error TS5097: standalone Node contracts.
import {parsePaperReadingWorkspace,paperReadingDiscoveryQuery,parsePaperReadingDiscoveryPage} from '../../domain/paper-reading/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject} from '../../domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalAttemptJson} from '../../domain/learning-attempt/index.ts';
export function createPaperReadingRemote(options:{scope:PaperReadingScope;fetcher?:typeof fetch;isCurrent?:()=>boolean}):PaperReadingRemotePort{
    const scope=structuredClone(options.scope);
    if(!scope.ownerId.startsWith('account:')||!scope.libraryId.startsWith('account:')||scope.ownerId.length<=8||scope.libraryId.length<=8)throw Error('paper-reading-account-binding');
    const current=(signal?:AbortSignal)=>{signal?.throwIfAborted();if(options.isCurrent?.()===false)throw Error('paper-reading-request-cancelled');};
    function workspace(raw:unknown,unitId:string):PaperReadingWorkspaceV1|null{
        if(raw===null)return null;
        const saved=parsePaperReadingWorkspace(raw);
        if(saved.unit.unitId!==unitId||saved.unit.source.ownerId!==scope.ownerId||saved.unit.source.libraryId!==scope.libraryId)throw Error('paper-reading-response-binding');
        return saved;
    }
    async function request(action:string,body:Record<string,unknown>,signal?:AbortSignal){
        current(signal);
        const response=await(options.fetcher??fetch)('/api/account-study',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({...body,action,expectedUserId:scope.ownerId.slice(8),libraryId:scope.libraryId.slice(8)}),signal});
        const text=await response.text();current(signal);if(text.length>2000000)throw Error('paper-reading-response-limit');
        let raw;try{raw=JSON.parse(text);}catch{throw Error(response.status===404?'paper-reading-unsupported':'paper-reading-response-invalid');}
        if(!response.ok)throw Error(typeof raw?.error==='string'&&/^[a-z0-9-]{1,120}$/.test(raw.error)?raw.error:'paper-reading-unavailable');
        return raw;
    }
    async function result(action:string,unitId:string,body:Record<string,unknown>,signal?:AbortSignal){
        const raw=studyObject(await request(action,{unitId,...body},signal),['workspace']);
        return workspace(raw.workspace,unitId);
    }
    return {
        async list(query={},signal){
            const snapshot=structuredClone(query);paperReadingDiscoveryQuery(scope,snapshot);
            return parsePaperReadingDiscoveryPage(await request('list-paper-reading',snapshot,signal),scope,snapshot);
        },
        read:(unitId,signal)=>result('read-paper-reading',unitId,{},signal),
        async mutate(mutation,signal){
            const raw=studyObject(await request('mutate-paper-reading',{mutation},signal),['schemaVersion','operationId','status','durable','workspace']);
            const saved=workspace(raw.workspace,mutation.unitId);
            if(raw.schemaVersion!==1||raw.operationId!==mutation.operationId||!['accepted','duplicate','conflict'].includes(raw.status as string)||typeof raw.durable!=='boolean')throw Error('paper-reading-receipt-invalid');
            if(raw.status!=='conflict'&&(!raw.durable||!saved||!saved.operations.some(op=>canonicalAttemptJson(op)===canonicalAttemptJson(mutation))))throw Error('paper-reading-receipt-unconfirmed');
            return {...raw,workspace:saved} as PaperReadingReceipt;
        },
        async begin(unitId,requestId,signal,prepared){
            const saved=await result('prepare-paper-reading',unitId,{requestId,...(prepared?{preparedTask:prepared}:{})},signal);
            if(!saved?.task)throw Error('paper-reading-task-not-saved');return saved;
        },
        async evaluate(unitId,attemptId,requestId,signal){
            const saved=await result('evaluate-paper-reading',unitId,{attemptId,requestId},signal);
            if(!saved?.attempts.some(a=>a.attemptId===attemptId&&a.submission))throw Error('paper-reading-answer-not-saved');return saved;
        },
    };
}
