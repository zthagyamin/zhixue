import type {PracticeEvidenceMutationV1, PracticeEvidenceV1, PracticeEvidenceReceipt} from '../../domain/practice-evidence';
import type {PracticeEvidenceCloudPort, PracticeEvidencePage} from '../../application/practice-evidence';
// @ts-expect-error TS5097: standalone Node contracts.
import {attemptId} from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parsePracticeEvidence,parsePracticeEvidenceMutation,practiceEvidenceFingerprint,evidenceEqual,validatePracticeEvidenceTree} from '../../domain/practice-evidence/index.ts';

function object(raw:unknown,keys:string[]):Record<string,unknown> {
    validatePracticeEvidenceTree(raw);
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==keys.length||keys.some(key=>!Object.hasOwn(raw,key)))throw Error('practice-evidence-receipt-fields');
    return raw as Record<string,unknown>;
}
export function createAccountPracticeEvidenceClient(options:{ownerId:string;libraryId:string;fetcher?:typeof fetch}):PracticeEvidenceCloudPort & {
    read(attemptId:string):Promise<PracticeEvidenceV1|null>;
    listPage(page?:{cursor?:string;limit?:number}):Promise<PracticeEvidencePage>;
} {
    attemptId(options.ownerId);attemptId(options.libraryId);
    const record=(raw:unknown)=>{
        const r=parsePracticeEvidence(raw);
        if(r.binding.ownerId!==options.ownerId||r.binding.libraryId!==options.libraryId)throw Error('practice-evidence-scope-binding');
        return r;
    };
    const send=async(action:string,body:Record<string,unknown>):Promise<unknown>=>{
        const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
        const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('practice-evidence-timeout'));},8000);});
        try {
            return await Promise.race([timeout,(async()=>{
                const response=await (options.fetcher??fetch)('/api/account-study',{method:'POST',credentials:'same-origin',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({action,...body,expectedUserId:options.ownerId,libraryId:options.libraryId})});
                const result=await response.json() as Record<string,unknown>;
                if(!response.ok) {
                    const code=String(result?.error??'practice-evidence-request-failed');
                    throw Object.assign(Error(code),{status:response.status});
                }
                return result;
            })()]);
        } finally {clearTimeout(timer);}
    };
    const listPage=async(page:{cursor?:string;limit?:number}={}):Promise<PracticeEvidencePage>=>{
        if(page.cursor!==undefined)attemptId(page.cursor);
        const limit=page.limit??200;
        if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw Error('practice-evidence-page-limit');
        const value=object(await send('practice-evidence-list',{...page,limit}),['records','nextCursor','complete']);
        if(!Array.isArray(value.records)||value.records.length>limit||typeof value.complete!=='boolean')throw Error('practice-evidence-page');
        const records=value.records.map(record);
        let cursor=page.cursor??'';
        for(const r of records) {if(r.attemptId<=cursor)throw Error('practice-evidence-page-order');cursor=r.attemptId;}
        if(value.complete?value.nextCursor!==null:!records.length||value.nextCursor!==cursor)throw Error('practice-evidence-page');
        return {records,complete:value.complete,nextCursor:value.nextCursor as string|null};
    };
    return {
        async read(id:string) {
            attemptId(id);const result=object(await send('practice-evidence-read',{attemptId:id}),['record']);
            if(result.record===null)return null;
            const r=record(result.record);if(r.attemptId!==id)throw Error('practice-evidence-record-binding');return r;
        },
        listPage,
        async list() {
            const page=await listPage();
            if(!page.complete)throw Object.assign(Error('practice-evidence-list-truncated'),{page});
            return page.records;
        },
        async mutate(raw:PracticeEvidenceMutationV1) {
            const m=parsePracticeEvidenceMutation(raw);
            if(m.binding.ownerId!==options.ownerId||m.binding.libraryId!==options.libraryId)throw Error('practice-evidence-scope-binding');
            let rawReceipt:unknown;
            try {rawReceipt=await send('practice-evidence-mutate',{mutation:m});}
            catch(error) {
                const code=error instanceof Error?error.message:'';
                if(['unsupported-action','practice-evidence-unsupported'].includes(code))return {status:'unsupported' as const};
                if(['practice-evidence-unsupported-version','practice-evidence-incompatible'].includes(code))return {status:'incompatible' as const};
                throw error;
            }
            const r=object(rawReceipt,['status','durable','operationId','revision','record']);
            if(!['accepted','duplicate','conflict'].includes(String(r.status))||typeof r.durable!=='boolean'||r.operationId!==m.operationId||!Number.isSafeInteger(r.revision)||(r.revision as number)<0)throw Error('practice-evidence-receipt');
            const saved=r.record===null?null:record(r.record);
            if((saved?.revision??0)!==r.revision||saved&&(saved.attemptId!==m.attemptId||!evidenceEqual(saved.binding,m.binding)))throw Error('practice-evidence-receipt-binding');
            if(r.status==='conflict') {if(r.durable)throw Error('practice-evidence-receipt-durable');}
            else {
                const op=saved?.operations.find(o=>o.operationId===m.operationId);
                if(!r.durable||!op||op.fingerprint!==await practiceEvidenceFingerprint(m)||op.revision!==m.expectedRevision+1)throw Error('practice-evidence-receipt-operation');
            }
            return {status:r.status,durable:r.durable,operationId:m.operationId,revision:r.revision,record:saved} as PracticeEvidenceReceipt;
        },
    };
}
