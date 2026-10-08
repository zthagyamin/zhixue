// @ts-expect-error TS5097: standalone Node source contracts.
export {readJournalForDelivery,persistStudySubmission,recoverStudySubmissions} from '../src/application/sync/index.ts';
import type {SummaryCloudAck,SubmissionRow,StudyRecordEnvelope} from '../src/domain/sync';
export type {NativeAttemptBindingV1,SubmissionRoute,StudySubmissionV1,SummaryCloudAck,SubmissionRow,CorePersistenceState} from '../src/domain/sync';
// @ts-expect-error TS5097: standalone Node source contracts.
export {parseNativeAttemptBinding,parseStudySubmission,submissionAssociationHash} from '../src/domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {assertSubmissionWorkspace as scope,studyObject,studyId,studyCount,checkAssistanceReceipt,parseStudySubmission,submissionAssociationHash} from '../src/domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {canonicalizeJson,canonicalLocalJson,hashLocalJson} from '../src/domain/evidence/index.ts';
type WriteRow=Omit<SubmissionRow,'stateHash'>;
function open():Promise<IDBDatabase>{
  if(typeof indexedDB==='undefined')return Promise.reject(new Error('submission-storage-unavailable'));
  return new Promise((resolve,reject)=>{const r=indexedDB.open('zhixue-submission-journal-v1',1);
    r.onupgradeneeded=()=>r.result.createObjectStore('submissions',{keyPath:['workspaceId','eventId']}).createIndex('workspace','workspaceId');
    r.onerror=()=>reject(r.error??new Error('submission-storage-unavailable'));r.onblocked=()=>reject(new Error('submission-storage-blocked'));
    r.onsuccess=()=>{r.result.onversionchange=()=>r.result.close();resolve(r.result);};});
}
type Control<T>={store:IDBObjectStore;read:<R>(request:IDBRequest<R>,handler:(value:R)=>void)=>void;done:(value:T)=>void};
async function transaction<T>(mode:IDBTransactionMode,run:(control:Control<T>)=>void):Promise<T>{
  const db=await open();try{return await new Promise<T>((resolve,reject)=>{const tx=db.transaction('submissions',mode);let value:T,finished=false,failure:unknown;
    const abort=(error:unknown)=>{failure=error;tx.abort();};
    tx.oncomplete=()=>finished?resolve(value):reject(new Error('submission-transaction-incomplete'));
    tx.onerror=()=>{failure??=tx.error;};tx.onabort=()=>reject(failure??tx.error??new Error('submission-transaction-aborted'));
    try{run({store:tx.objectStore('submissions'),done:result=>{value=result;finished=true;},read:(request,handler)=>{request.onsuccess=()=>{try{handler(request.result);}catch(error){abort(error);}};}});}catch(error){abort(error);}
  });}finally{db.close();}
}
async function sign(row:WriteRow):Promise<SubmissionRow>{return{...row,stateHash:await hashLocalJson(row)};}
function checkAck(row:Pick<SubmissionRow,'payload'|'associationHash'>,raw:unknown):SummaryCloudAck{
  const ack=studyObject(raw,['summaryId','summaryHash','associationHash','sequence']);studyCount(ack.sequence,'assistance-ack-sequence',1);
  if(row.payload.route.kind!=='account'||!row.payload.summary||!row.associationHash||ack.summaryId!==row.payload.summary.summaryId||ack.summaryHash!==row.payload.summary.summaryHash||ack.associationHash!==row.associationHash)throw new Error('assistance-ack-binding');
  return structuredClone(ack) as SummaryCloudAck;
}
async function validateRow(raw:SubmissionRow,workspaceId:string,eventId?:string):Promise<SubmissionRow>{
  studyObject(raw,['workspaceId','eventId','payload','payloadHash','associationHash','revision','coreStored','cloudAck','writeback','stateHash']);
  const frozen=structuredClone(raw),{stateHash,...body}=frozen;
  if(body.workspaceId!==workspaceId||eventId!==undefined&&body.eventId!==eventId||await hashLocalJson(body)!==stateHash)throw new Error('submission-row-integrity');
  const payload=await parseStudySubmission(body.payload);studyCount(body.revision,'submission-revision',1);
  if(payload.workspaceId!==workspaceId||payload.eventId!==body.eventId||typeof body.coreStored!=='boolean'||await hashLocalJson(payload)!==body.payloadHash||await submissionAssociationHash(payload)!==body.associationHash)throw new Error('submission-row-integrity');
  if(body.cloudAck)checkAck(body,body.cloudAck);
  if(body.writeback){studyObject(body.writeback,['revision','receipt']);studyCount(body.writeback.revision,'assistance-receipt-revision',1);
    if(!payload.summary||!body.associationHash)throw new Error('assistance-receipt-binding');checkAssistanceReceipt({summary:payload.summary,associationHash:body.associationHash},body.writeback.receipt);}
  return frozen;
}
/** Independent DB; no delete operation. Export and sign-out preserve queued evidence. */
export function createSubmissionJournal(){
  const get=async(workspaceId:string,eventId:string):Promise<SubmissionRow|null>=>{scope(workspaceId);studyId(eventId,'event');
    const raw=await transaction<SubmissionRow|undefined>('readonly',({store,read,done})=>read(store.get([workspaceId,eventId]),done));return raw?validateRow(raw,workspaceId,eventId):null;};
  async function update(workspaceId:string,eventId:string,change:(row:SubmissionRow)=>WriteRow):Promise<void>{
    for(let attempt=0;attempt<8;attempt++){
      const before=await get(workspaceId,eventId);if(!before)throw new Error('unknown-submission');
      const next=await sign({...change(before),revision:before.revision+1});
      const changed=await transaction<boolean>('readwrite',({store,read,done})=>read<SubmissionRow|undefined>(store.get([workspaceId,eventId]),current=>{
        if(current?.stateHash!==before.stateHash){done(false);return;}store.put(next);done(true);
      }));if(changed)return;
    }throw new Error('submission-update-raced');
  }
  return{
    get,
    /** Per-item preparation only; full history/cursor validation still uses list. */
    async relatedAccountRecords(workspaceId:string,libraryId:string,itemKey:string):Promise<StudyRecordEnvelope[]>{
      scope(workspaceId);studyId(libraryId,'library');studyId(itemKey,'item');
      const rows=await transaction<SubmissionRow[]>('readonly',({store,read,done})=>read(store.index('workspace').getAll(workspaceId),done)),records:StudyRecordEnvelope[]=[];
      for(const raw of rows)if(raw.payload?.route?.kind==='account'&&raw.payload.route.record.libraryId===libraryId&&raw.payload.core?.event?.eventType==='practice-attempt'&&raw.payload.core.event.item.key===itemKey){
        const row=await validateRow(raw,workspaceId);if(row.payload.route.kind==='account')records.push(row.payload.route.record);
      }return records;
    },
    async list(workspaceId:string):Promise<SubmissionRow[]>{scope(workspaceId);const rows=await transaction<SubmissionRow[]>('readonly',({store,read,done})=>read(store.index('workspace').getAll(workspaceId),done));
      const result:SubmissionRow[]=[];for(const row of rows)result.push(await validateRow(row,workspaceId));return result.sort((a,b)=>a.payload.core.occurredAt.localeCompare(b.payload.core.occurredAt)||a.eventId.localeCompare(b.eventId));},
    async put(raw:unknown):Promise<'accepted'|'duplicate'>{
      const payload=await parseStudySubmission(raw),payloadHash=await hashLocalJson(payload),associationHash=await submissionAssociationHash(payload);
      const row=await sign({workspaceId:payload.workspaceId,eventId:payload.eventId,payload,payloadHash,associationHash,revision:1,coreStored:false,cloudAck:null,writeback:null});
      const result=await transaction<'accepted'|'duplicate'>('readwrite',({store,read,done})=>read<SubmissionRow|undefined>(store.get([payload.workspaceId,payload.eventId]),current=>{
        if(current){if(current.payloadHash!==payloadHash||canonicalLocalJson(current.payload)!==canonicalLocalJson(payload))throw new Error('submission-conflict');done('duplicate');return;}
        store.add(row);done('accepted');
      }));if(result==='duplicate')await get(payload.workspaceId,payload.eventId);return result;
    },
    markCoreStored:(workspaceId:string,eventId:string)=>update(workspaceId,eventId,row=>{const {stateHash,...body}=row;void stateHash;return{...body,coreStored:true};}),
    ackSummary:(workspaceId:string,eventId:string,raw:unknown)=>{const frozen=structuredClone(raw);return update(workspaceId,eventId,row=>{
      const ack=checkAck(row,frozen);if(row.cloudAck&&row.cloudAck.sequence!==ack.sequence)throw new Error('assistance-ack-conflict');
      const {stateHash,...body}=row;void stateHash;return{...body,cloudAck:ack};
    });},
    applyReceipt:(workspaceId:string,eventId:string,revision:number,raw:unknown)=>{studyCount(revision,'receipt-revision',1);const frozen=structuredClone(raw);return update(workspaceId,eventId,row=>{
      if(!row.payload.summary||!row.associationHash)throw new Error('assistance-receipt-binding');
      const receipt=checkAssistanceReceipt({summary:row.payload.summary,associationHash:row.associationHash},frozen),old=row.writeback;
      const {stateHash,...body}=row;void stateHash;
      if(old&&revision<old.revision)return body;
      if(old&&revision===old.revision&&canonicalizeJson(receipt)!==canonicalizeJson(old.receipt))throw new Error('assistance-receipt-conflict');
      if(old?.receipt.status==='applied'&&(receipt.status!=='applied'||canonicalizeJson(receipt.proof)!==canonicalizeJson(old.receipt.proof)))throw new Error('assistance-receipt-regression');
      return{...body,writeback:{revision,receipt}};
    });},
  };
}
export type SubmissionJournal=ReturnType<typeof createSubmissionJournal>;
