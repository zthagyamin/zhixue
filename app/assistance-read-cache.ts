import type {AccountAssistanceV1,AssistanceReceiptV1} from './assistance-record';
import type {StudyRecordEnvelope} from './account-study-record';
// @ts-expect-error TS5097: standalone Node contracts.
import {validateAccountAssistance,checkAssistanceReceipt} from './assistance-record.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseStudyRecord} from './account-study-record.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject,studyId,studyIso,studyCount,studyHash} from './account-study-content.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalizeJson} from './study-event-v3.ts';

export type AssistanceReadScope={workspaceId:string;libraryId:string};
export type AssistanceSummaryReadRow={sequence:number;record:AccountAssistanceV1;parent:StudyRecordEnvelope;receivedAt:string};
export type AssistanceReceiptReadRow={sequence:number;receipt:AssistanceReceiptV1;writerGrantId:string;receivedAt:string};
export type AssistanceReadView=AssistanceReadScope&{schemaVersion:1;summaryThrough:number;receiptThrough:number;summaries:AssistanceSummaryReadRow[];receipts:AssistanceReceiptReadRow[]};
type Stored=AssistanceReadScope&{generation:number;view:AssistanceReadView;hash:string};
function owner(workspaceId:string){if(!workspaceId.startsWith('account:'))throw new Error('invalid-assistance-cache-owner');studyId(workspaceId.slice(8),'owner');}
function scope(value:AssistanceReadScope){studyObject(value,['workspaceId','libraryId']);owner(value.workspaceId);studyId(value.libraryId,'library');}
function sequence(value:unknown,last:number,through:number){studyCount(value,'assistance-sequence',1);if((value as number)<=last||(value as number)>through)throw new Error('assistance-cache-sequence');return value as number;}
export async function validateAssistanceReadView(raw:unknown,expected:AssistanceReadScope):Promise<AssistanceReadView>{
  scope(expected);const value=structuredClone(studyObject(raw,['schemaVersion','workspaceId','libraryId','summaryThrough','receiptThrough','summaries','receipts']));
  if(value.schemaVersion!==1||value.workspaceId!==expected.workspaceId||value.libraryId!==expected.libraryId)throw new Error('assistance-cache-binding');
  studyCount(value.summaryThrough,'summary-fence');studyCount(value.receiptThrough,'receipt-fence');
  if(!Array.isArray(value.summaries)||!Array.isArray(value.receipts))throw new Error('invalid-assistance-cache-rows');
  const summaries:AssistanceSummaryReadRow[]=[],receipts:AssistanceReceiptReadRow[]=[],bySummary=new Map<string,AccountAssistanceV1>(),eventIds=new Set<string>();let last=0;
  for(const raw of value.summaries){const row=studyObject(raw,['sequence','record','parent','receivedAt']);last=sequence(row.sequence,last,value.summaryThrough as number);studyIso(row.receivedAt);
    const parent=await parseStudyRecord(row.parent),record=await validateAccountAssistance(row.record,parent),id=record.summary.summaryId;
    if(record.libraryId!==expected.libraryId||bySummary.has(id)||eventIds.has(record.summary.attemptEventId))throw new Error('assistance-cache-summary-binding');
    bySummary.set(id,record);eventIds.add(record.summary.attemptEventId);summaries.push({sequence:last,record,parent,receivedAt:row.receivedAt as string});
  }
  if(last!==value.summaryThrough)throw new Error('assistance-cache-incomplete');last=0;
  const receiptIds=new Set<string>(),latest=new Map<string,AssistanceReceiptV1>();
  for(const raw of value.receipts){const row=studyObject(raw,['sequence','receipt','writerGrantId','receivedAt']);last=sequence(row.sequence,last,value.receiptThrough as number);studyIso(row.receivedAt);studyId(row.writerGrantId,'writer');
    const identity=studyObject(row.receipt,['schemaVersion','receiptId','summaryId','summaryHash','associationHash','status'],['reason','proof']),parent=bySummary.get(identity.summaryId as string);
    if(!parent)throw new Error('assistance-cache-receipt-parent-missing');const receipt=checkAssistanceReceipt(parent,row.receipt),prior=latest.get(receipt.summaryId);
    if(receiptIds.has(receipt.receiptId))throw new Error('assistance-cache-receipt-conflict');receiptIds.add(receipt.receiptId);
    if(prior?.status==='applied'&&(receipt.status!=='applied'||canonicalizeJson(prior.proof)!==canonicalizeJson(receipt.proof)))throw new Error('assistance-cache-receipt-regression');
    latest.set(receipt.summaryId,receipt);receipts.push({sequence:last,receipt,writerGrantId:row.writerGrantId as string,receivedAt:row.receivedAt as string});
  }
  if(last!==value.receiptThrough)throw new Error('assistance-cache-incomplete');return{schemaVersion:1,...expected,summaryThrough:value.summaryThrough as number,receiptThrough:value.receiptThrough as number,summaries,receipts};
}
function advance(before:AssistanceReadView,next:AssistanceReadView){
  if(next.summaryThrough<before.summaryThrough||next.receiptThrough<before.receiptThrough)throw new Error('assistance-cache-regression');
  for(const key of ['summaries','receipts'] as const)if(canonicalizeJson(next[key].slice(0,before[key].length))!==canonicalizeJson(before[key]))throw new Error('assistance-cache-history-conflict');
}
function open():Promise<IDBDatabase>{
  if(typeof indexedDB==='undefined')return Promise.reject(new Error('assistance-cache-unavailable'));
  return new Promise((resolve,reject)=>{const r=indexedDB.open('zhixue-assistance-read-v1',1);
    r.onupgradeneeded=()=>r.result.createObjectStore('views',{keyPath:['workspaceId','libraryId']}).createIndex('workspace','workspaceId');
    r.onerror=()=>reject(r.error??new Error('assistance-cache-unavailable'));r.onblocked=()=>reject(new Error('assistance-cache-blocked'));
    r.onsuccess=()=>{r.result.onversionchange=()=>r.result.close();resolve(r.result);};});
}
type Control<T>={store:IDBObjectStore;read:<V>(r:IDBRequest<V>,next:(v:V)=>void)=>void;done:(v:T)=>void};
async function transaction<T>(mode:IDBTransactionMode,run:(c:Control<T>)=>void,signal?:AbortSignal):Promise<T>{
  signal?.throwIfAborted();const db=await open();try{return await new Promise<T>((resolve,reject)=>{const tx=db.transaction('views',mode);let output:T,finished=false,failure:unknown;
    const abort=(error:unknown)=>{failure??=error;try{tx.abort();}catch{/* Already committed; no partial write remains. */}};
    const cancel=()=>abort(signal?.reason??new DOMException('Cancelled','AbortError')),cleanup=()=>signal?.removeEventListener('abort',cancel);
    tx.oncomplete=()=>{cleanup();if(finished)resolve(output);else reject(new Error('assistance-cache-transaction-incomplete'));};tx.onerror=()=>{failure??=tx.error;};tx.onabort=()=>{cleanup();reject(failure??tx.error??new Error('assistance-cache-aborted'));};
    signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted){cancel();return;}
    try{run({store:tx.objectStore('views'),read:(r,next)=>{r.onsuccess=()=>{try{next(r.result);}catch(error){abort(error);}};},done:v=>{output=v;finished=true;}});}catch(error){abort(error);}
  });}finally{db.close();}
}
async function parsed(row:Stored,expected:AssistanceReadScope):Promise<Stored>{
  studyObject(row,['workspaceId','libraryId','generation','view','hash']);studyCount(row.generation,'cache-generation',1);
  const {hash,...body}=row;if(row.workspaceId!==expected.workspaceId||row.libraryId!==expected.libraryId||await studyHash(body)!==hash)throw new Error('assistance-cache-integrity');
  return{...structuredClone(row),view:await validateAssistanceReadView(row.view,expected)};
}
/** Complete auxiliary evidence only; no deletion API and no old DB upgrade. */
export function createAssistanceReadCache(){
  const read=async(expected:AssistanceReadScope)=>{scope(expected);const row=await transaction<Stored|undefined>('readonly',({store,read,done})=>read(store.get([expected.workspaceId,expected.libraryId]),done));
    const checked=row?await parsed(row,expected):null;return{generation:checked?.generation??0,view:checked?.view??null,hash:checked?.hash??null};};
  return{read,
    async commit(expected:AssistanceReadScope,raw:unknown,generation:number,signal?:AbortSignal):Promise<void>{
      scope(expected);studyCount(generation,'cache-generation');signal?.throwIfAborted();const view=await validateAssistanceReadView(raw,expected),before=await read(expected);
      if(before.generation!==generation)throw new Error('assistance-cache-stale');if(before.view)advance(before.view,view);
      const body={...expected,generation:generation+1,view},row={...body,hash:await studyHash(body)};studyCount(row.generation,'cache-generation',1);signal?.throwIfAborted();
      await transaction<void>('readwrite',({store,read,done})=>read<Stored|undefined>(store.get([expected.workspaceId,expected.libraryId]),current=>{
        if((current?.generation??0)!==generation||(current?.hash??null)!==before.hash)throw new Error('assistance-cache-stale');store.put(row);done(undefined);
      }),signal);
    },
    async exportOwner(workspaceId:string):Promise<AssistanceReadView[]>{
      owner(workspaceId);const rows=await transaction<Stored[]>('readonly',({store,read,done})=>read(store.index('workspace').getAll(workspaceId),done)),views:AssistanceReadView[]=[];
      for(const row of rows)views.push((await parsed(row,{workspaceId,libraryId:row.libraryId})).view);return views.sort((a,b)=>a.libraryId.localeCompare(b.libraryId));
    },
  };
}
export type AssistanceReadCache=ReturnType<typeof createAssistanceReadCache>;
