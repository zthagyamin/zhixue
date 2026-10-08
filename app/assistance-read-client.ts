import type {StudyRecordEnvelope} from './account-study-record';
import type {AssistanceReadCache,AssistanceReadScope,AssistanceReadView,AssistanceSummaryReadRow,AssistanceReceiptReadRow} from './assistance-read-cache';
import type {SubmissionJournal} from './study-submission-journal';
// @ts-expect-error TS5097: standalone Node contracts.
import {createAssistanceReadCache,validateAssistanceReadView} from './assistance-read-cache.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {readAccountPages} from './account-study-paging.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {sharedAccountRead} from './account-study-read.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseStudyRecord} from './account-study-record.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject,studyId,studyCount,studyIso} from './account-study-content.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {validateAccountAssistance} from './assistance-record.ts';

type Loaded={supported:boolean;view:AssistanceReadView|null};
type Options=AssistanceReadScope&{fetcher?:typeof fetch;cache?:AssistanceReadCache};
/** Caller must first confirm identity and provide the original validated parent
 * envelopes. No personal cache access happens for anonymous/unknown identity. */
export function createAssistanceReadClient(options:Options){
  const {workspaceId,libraryId}=options;if(!workspaceId.startsWith('account:'))throw new Error('assistance-account-required');
  const userId=workspaceId.slice(8);studyId(userId,'user');studyId(libraryId,'library');
  const scope={workspaceId,libraryId},cache=options.cache??createAssistanceReadCache(),fetcher=options.fetcher??fetch;
  const get=async(action:string,params:Record<string,string|number>,signal:AbortSignal)=>{
    signal.throwIfAborted();const query=new URLSearchParams({action,...(action==='bootstrap'?{}:{libraryId}),...Object.fromEntries(Object.entries(params).map(([key,value])=>[key,String(value)])),expectedUserId:userId});
    const response=await fetcher(`/api/account-study?${query}`,{credentials:'same-origin',cache:'no-store',signal}),raw=await response.json();signal.throwIfAborted();
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('invalid-assistance-response');const value=raw as Record<string,unknown>;
    if(!response.ok)throw new Error(typeof value.error==='string'?value.error:'assistance-read-failed');return value;
  };
  return{cached:async()=> (await cache.read(scope)).view,
    async load(rawParents:StudyRecordEnvelope[],request:{signal?:AbortSignal}={}):Promise<Loaded>{
      request.signal?.throwIfAborted();const parents=structuredClone(rawParents);
      // Protocol marker separates this flight from the core reader pool. The
      // known parent set also separates readers with different dependency fences.
      const key=JSON.stringify([userId,libraryId,'assistance-v1',parents.map(record=>record.envelopeHash).sort()]);
      return sharedAccountRead(fetcher,key,async signal=>{
        const saved=await cache.read(scope);signal.throwIfAborted();const boot=await get('bootstrap',{},signal);
        if(boot.apiVersion!==1||boot.enabled!==true||(boot.profile as {libraryId?:unknown})?.libraryId!==libraryId)throw new Error('assistance-bootstrap-binding');
        if(boot.capabilities!==undefined&&(!Array.isArray(boot.capabilities)||boot.capabilities.some(value=>typeof value!=='string')))throw new Error('invalid-assistance-capabilities');
        if(!Array.isArray(boot.capabilities)||!boot.capabilities.includes('assistance-summary-v1'))return{supported:false,view:saved.view};
        const fences=studyObject(boot.assistanceFences,['summaries','receipts']);studyCount(fences.summaries,'summary-fence');studyCount(fences.receipts,'receipt-fence');
        const old=saved.view;if(old&&(old.summaryThrough>(fences.summaries as number)||old.receiptThrough>(fences.receipts as number)))throw new Error('assistance-read-regression');
        const byEvent=new Map<string,StudyRecordEnvelope>();
        for(const raw of [...(old?.summaries.map(row=>row.parent)??[]),...parents]){const parent=await parseStudyRecord(raw);if(parent.libraryId!==libraryId)throw new Error('assistance-parent-library');const prior=byEvent.get(parent.event.eventId);if(prior&&prior.envelopeHash!==parent.envelopeHash)throw new Error('assistance-parent-conflict');byEvent.set(parent.event.eventId,parent);}
        const read=async<T extends {sequence:number}>(action:string,collection:string,after:number,through:number,parse:(raw:unknown)=>Promise<T>|T)=>{
          if(after===through)return{rows:[] as T[],through};
          return readAccountPages(page=>get(action,{after:page.after,through:page.through!,limit:20},signal),{collection,after,through,signal,parse});
        };
        const [summaries,receipts]=await Promise.all([
          read<AssistanceSummaryReadRow>('assistance','summaries',old?.summaryThrough??0,fences.summaries as number,async raw=>{
            const row=studyObject(raw,['sequence','record','receivedAt']);studyCount(row.sequence,'summary-sequence',1);studyIso(row.receivedAt);
            const record=row.record as {summary?:{attemptEventId?:string}},parent=byEvent.get(record?.summary?.attemptEventId??'');if(!parent)throw new Error('assistance-read-parent-missing');
            return{sequence:row.sequence as number,record:await validateAccountAssistance(row.record,parent),parent,receivedAt:row.receivedAt as string};
          }),
          read<AssistanceReceiptReadRow>('assistance-receipts','receipts',old?.receiptThrough??0,fences.receipts as number,raw=>{
            const row=studyObject(raw,['sequence','receipt','writerGrantId','receivedAt']);studyCount(row.sequence,'receipt-sequence',1);studyId(row.writerGrantId,'writer');studyIso(row.receivedAt);return structuredClone(row) as AssistanceReceiptReadRow;
          }),
        ]);
        signal.throwIfAborted();if(old&&!summaries.rows.length&&!receipts.rows.length)return{supported:true,view:old};
        const view=await validateAssistanceReadView({schemaVersion:1,...scope,summaryThrough:summaries.through,receiptThrough:receipts.through,summaries:[...old?.summaries??[],...summaries.rows],receipts:[...old?.receipts??[],...receipts.rows]},scope);
        signal.throwIfAborted();await cache.commit(scope,view,saved.generation,signal);return{supported:true,view};
      },request.signal);
    },
  };
}
/** Auxiliary read evidence can reconcile its own journal receipts, never the
 * original V3 delivery flag, FSRS state, task completion or formal mastery. */
export async function reconcileAssistanceJournal(raw:AssistanceReadView,journal:SubmissionJournal):Promise<{reconciled:number;failed:number}>{
  const view=await validateAssistanceReadView(raw,{workspaceId:raw.workspaceId,libraryId:raw.libraryId}),latest=new Map(view.receipts.map(row=>[row.receipt.summaryId,row]));let reconciled=0,failed=0;
  for(const row of view.summaries)try{const record=row.record,eventId=record.summary.attemptEventId,saved=await journal.get(view.workspaceId,eventId);if(!saved)continue;
    await journal.ackSummary(view.workspaceId,eventId,{summaryId:record.summary.summaryId,summaryHash:record.summary.summaryHash,associationHash:record.associationHash,sequence:row.sequence});
    const receipt=latest.get(record.summary.summaryId);if(receipt)await journal.applyReceipt(view.workspaceId,eventId,receipt.sequence,receipt.receipt);reconciled++;
  }catch{failed++;}return{reconciled,failed};
}
