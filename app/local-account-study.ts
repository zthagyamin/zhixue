import type {StudyDeliveryReceipt} from '../src/domain/sync';
export type {StudyDeliveryReceipt} from '../src/domain/sync';
import type {StudyBundle} from './account-study-content';
import type {StudyRecordEnvelope} from './account-study-record';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {validateStudyBundle,studyObject,studyId,studyDigest,studyCount,studyText,studyHash} from './account-study-content.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {parseStudyRecord,compareStudyRecord,checkStudyRecordBinding} from './account-study-record.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {canonicalizeJson} from './study-event-v3.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {compareEvidenceText} from './vocabulary-learning.ts';
type SavedReceipt={payload:StudyDeliveryReceipt;hash:string};
type WritebackState='pending'|'received'|'blocked'|'applied';
export type LocalStudyRecord={record:StudyRecordEnvelope;cloud:'pending'|'acked';writeback:WritebackState;
  receipts:{cloud:SavedReceipt|null;companion:SavedReceipt|null}};
type RecordRow=LocalStudyRecord&{workspaceId:string;libraryId:string;eventId:string};
type SnapshotRow={workspaceId:string;libraryId:string;snapshotId:string;revision:number;snapshotHash:string;bundle:StudyBundle};
type Head={workspaceId:string;libraryId:string;snapshotId:string;revision:number;snapshotHash:string};
type Control<T>={store:(name:string)=>IDBObjectStore;read:<R>(request:IDBRequest<R>,handler:(value:R)=>void)=>void;done:(value:T)=>void};
const SNAPSHOTS='account-study-snapshots-v1',HEADS='account-study-heads-v1',RECORDS='account-study-records-v1';

// Keep the old version-3 database untouched: cached v1.10 tabs still open it
// with an explicit version and would fail after an in-place version bump.
function openAccountStudyDb():Promise<IDBDatabase> {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open('zhixue-account-study-v1',1);
    request.onupgradeneeded=()=>{
      const db=request.result;
      const snapshots=db.createObjectStore(SNAPSHOTS,{keyPath:['workspaceId','libraryId','snapshotId']});
      snapshots.createIndex('scope',['workspaceId','libraryId']);
      snapshots.createIndex('revision',['workspaceId','libraryId','revision'],{unique:true});
      db.createObjectStore(HEADS,{keyPath:['workspaceId','libraryId']});
      db.createObjectStore(RECORDS,{keyPath:['workspaceId','libraryId','eventId']}).createIndex('scope',['workspaceId','libraryId']);
    };
    request.onerror=()=>reject(request.error??new Error('study-storage-unavailable'));
    request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};
  });
}

function workspace(value:string):void {
  if (typeof value!=='string'||!value.startsWith('account:')||value.length<=8) throw new Error('invalid-study-account');
  studyId(value.slice(8),'account');
}
function sameValue(left:unknown,right:unknown):boolean {
  if (Object.is(left,right)) return true;
  if (!left||!right||typeof left!=='object'||typeof right!=='object'||Array.isArray(left)!==Array.isArray(right)) return false;
  const a=left as Record<string,unknown>,b=right as Record<string,unknown>,keys=Object.keys(a);
  return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&sameValue(a[key],b[key]));
}
function checkStoredSnapshot(row:SnapshotRow,workspaceId:string,bundle:StudyBundle):void {
  if(row.snapshotHash!==bundle.snapshot.snapshotHash) throw new Error('study-snapshot-conflict');
  if(row.workspaceId!==workspaceId||row.libraryId!==bundle.snapshot.libraryId||row.snapshotId!==bundle.snapshot.snapshotId
    ||row.revision!==bundle.snapshot.revision||!sameValue(row.bundle,bundle)) throw new Error('local-snapshot-integrity');
}
function snapshotRow(workspaceId:string,bundle:StudyBundle):SnapshotRow {
  const s=bundle.snapshot;return {workspaceId,libraryId:s.libraryId,snapshotId:s.snapshotId,revision:s.revision,snapshotHash:s.snapshotHash,bundle};
}
async function transaction<T>(names:string[],mode:IDBTransactionMode,run:(control:Control<T>)=>void):Promise<T> {
  if (typeof indexedDB==='undefined') throw new Error('study-storage-unavailable');
  const database=await openAccountStudyDb();
  try {
    return await new Promise<T>((resolve,reject)=>{
      const tx=database.transaction(names,mode);let result:T,finished=false,failure:unknown;
      const abort=(error:unknown)=>{failure=error;tx.abort();};
      tx.oncomplete=()=>finished?resolve(result):reject(new Error('incomplete-study-transaction'));
      tx.onerror=()=>{failure??=tx.error??new Error('study-storage-error');};
      tx.onabort=()=>reject(failure??tx.error??new Error('study-storage-aborted'));
      try {run({store:name=>tx.objectStore(name),done:value=>{result=value;finished=true;},
        read:(request,handler)=>{request.onsuccess=()=>{try{handler(request.result);}catch(error){abort(error);}};}});}
      catch(error){abort(error);}
    });
  } finally {database.close();}
}
export async function putLocalStudySnapshot(workspaceId:string,raw:unknown,expectedRevision:number):Promise<'accepted'|'duplicate'|'stale'> {
  workspace(workspaceId);studyCount(expectedRevision,'expected-revision');
  const bundle=await validateStudyBundle(raw),snapshot=bundle.snapshot;
  return transaction([SNAPSHOTS,HEADS],'readwrite',({store,read,done})=>{
    read<SnapshotRow|undefined>(store(SNAPSHOTS).get([workspaceId,snapshot.libraryId,snapshot.snapshotId]),existing=>{
      if (existing) checkStoredSnapshot(existing,workspaceId,bundle);
      read<Head|undefined>(store(HEADS).get([workspaceId,snapshot.libraryId]),head=>{
        const revision=head?.revision??0;
        if(existing&&(head?.snapshotId===snapshot.snapshotId||snapshot.revision<=revision)){done('duplicate');return;}
        if (revision!==expectedRevision||snapshot.revision<=revision) {done('stale');return;}
        if(!existing) store(SNAPSHOTS).add(snapshotRow(workspaceId,bundle));
        store(HEADS).put({workspaceId,libraryId:snapshot.libraryId,snapshotId:snapshot.snapshotId,
          revision:snapshot.revision,snapshotHash:snapshot.snapshotHash} satisfies Head);
        done('accepted');
      });
    });
  });
}
/** Backfill historical dependencies without changing the active snapshot. */
export async function cacheLocalStudySnapshot(workspaceId:string,raw:unknown):Promise<'accepted'|'duplicate'> {
  workspace(workspaceId);const bundle=await validateStudyBundle(raw),snapshot=bundle.snapshot;
  return transaction([SNAPSHOTS],'readwrite',({store,read,done})=>{
    read<SnapshotRow|undefined>(store(SNAPSHOTS).get([workspaceId,snapshot.libraryId,snapshot.snapshotId]),existing=>{
      if(existing){checkStoredSnapshot(existing,workspaceId,bundle);done('duplicate');return;}
      store(SNAPSHOTS).add(snapshotRow(workspaceId,bundle));done('accepted');
    });
  });
}
export async function getLocalStudySnapshot(workspaceId:string,libraryId:string,snapshotId?:string):Promise<StudyBundle|null> {
  workspace(workspaceId);studyId(libraryId,'library');if(snapshotId!==undefined) studyId(snapshotId,'snapshot');
  const row=await transaction<SnapshotRow|null>([SNAPSHOTS,HEADS],'readonly',({store,read,done})=>{
    if (snapshotId!==undefined) {read<SnapshotRow|undefined>(store(SNAPSHOTS).get([workspaceId,libraryId,snapshotId]),value=>done(value??null));return;}
    read<Head|undefined>(store(HEADS).get([workspaceId,libraryId]),head=>{
      if (!head) {done(null);return;}
      read<SnapshotRow|undefined>(store(SNAPSHOTS).get([workspaceId,libraryId,head.snapshotId]),value=>{
        if (!value||value.snapshotHash!==head.snapshotHash||value.revision!==head.revision) throw new Error('local-snapshot-integrity');
        done(value);
      });
    });
  });
  if (!row) return null;
  const bundle=await validateStudyBundle(row.bundle);
  if (bundle.snapshot.libraryId!==libraryId||bundle.snapshot.snapshotId!==row.snapshotId
    ||bundle.snapshot.snapshotHash!==row.snapshotHash||bundle.snapshot.revision!==row.revision) throw new Error('local-snapshot-integrity');
  return bundle;
}
export async function putLocalStudyRecord(workspaceId:string,raw:unknown):Promise<'accepted'|'duplicate'> {
  workspace(workspaceId);const record=await parseStudyRecord(raw);
  const bundle=await getLocalStudySnapshot(workspaceId,record.libraryId,record.snapshotId);
  if (!bundle) throw new Error('unknown-study-snapshot');
  if (record.provenanceMode!=='task') {
    const item=bundle.items.find(value=>value.itemKey===record.event.item.key);
    if (!item) throw new Error('study-record-item-membership');
    // Missing parents remain durable pending evidence, never a completion ACK.
    checkStudyRecordBinding(record,item);
  }
  return transaction([SNAPSHOTS,RECORDS],'readwrite',({store,read,done})=>{
    read<SnapshotRow|undefined>(store(SNAPSHOTS).get([workspaceId,record.libraryId,record.snapshotId]),snapshot=>{
      if (!snapshot||snapshot.snapshotHash!==bundle.snapshot.snapshotHash) throw new Error('unknown-study-snapshot');
      read<RecordRow|undefined>(store(RECORDS).get([workspaceId,record.libraryId,record.event.eventId]),existing=>{
        if (existing) {
          if (compareStudyRecord(existing.record,record)!=='duplicate'
            ||canonicalizeJson(existing.record)!==canonicalizeJson(record)) throw new Error('study-record-conflict');
          done('duplicate');return;
        }
        store(RECORDS).add({workspaceId,libraryId:record.libraryId,eventId:record.event.eventId,record,
          cloud:'pending',writeback:'pending',receipts:{cloud:null,companion:null}} satisfies RecordRow);
        done('accepted');
      });
    });
  });
}
function parseReceipt(raw:unknown):StudyDeliveryReceipt {
  const value=studyObject(raw,['schemaVersion','libraryId','eventId','envelopeHash','target','status','revision'],['reason']);
  if(value.schemaVersion!==1) throw new Error('unsupported-receipt-version');
  studyId(value.libraryId,'library');studyId(value.eventId,'event');studyDigest(value.envelopeHash);studyCount(value.revision,'receipt-revision',1);
  if(value.target!=='cloud'&&value.target!=='companion') throw new Error('invalid-receipt-target');
  if (typeof value.status!=='string'||(value.target==='cloud'?value.status!=='acked':!['received','blocked','applied'].includes(value.status))) {
    throw new Error('invalid-receipt-status');
  }
  if(Object.hasOwn(value,'reason')) studyText(value.reason,'receipt-reason',1000,true);
  return structuredClone(value) as StudyDeliveryReceipt;
}
function mergeReceipt(row:RecordRow,receipt:StudyDeliveryReceipt,hash:string):{row:RecordRow;changed:boolean}{
  if(row.record.envelopeHash!==receipt.envelopeHash)throw new Error('study-receipt-binding');
  const old=row.receipts[receipt.target];
  if(old&&old.payload.revision>=receipt.revision){if(old.payload.revision===receipt.revision&&old.hash!==hash)throw new Error('study-receipt-conflict');return{row,changed:false};}
  if(receipt.target==='companion'&&old?.payload.status==='applied'&&receipt.status!=='applied')throw new Error('study-receipt-regression');
  const next=structuredClone(row);next.receipts[receipt.target]={payload:receipt,hash};if(receipt.target==='cloud')next.cloud='acked';else next.writeback=receipt.status as WritebackState;return{row:next,changed:true};
}

/** Materialize a fully downloaded immutable history in one batch. Validation
 * precedes the transaction, whose compare-and-swap preserves concurrent local
 * submissions and newer receipts. No network cursor is fabricated here. */
export async function materializeStudyHistory(workspaceId:string,libraryId:string,bundlesRaw:StudyBundle[],recordsRaw:Array<{sequence:number;record:StudyRecordEnvelope}>,writebacksRaw:unknown[],isCurrent:()=>boolean=()=>true):Promise<StudyDeliveryReceipt[]>{
  workspace(workspaceId);studyId(libraryId,'library');const owner=()=>{if(!isCurrent())throw new Error('study-workspace-changed');};owner();
  const bundles=new Map<string,StudyBundle>();
  for(const raw of bundlesRaw){const bundle=await validateStudyBundle(raw),prior=bundles.get(bundle.snapshot.snapshotId);if(bundle.snapshot.libraryId!==libraryId||prior&&!sameValue(prior,bundle))throw new Error('study-snapshot-conflict');bundles.set(bundle.snapshot.snapshotId,bundle);}
  const records=new Map<string,StudyRecordEnvelope>(),receipts:StudyDeliveryReceipt[]=[];let sequence=0;
  for(const value of recordsRaw){studyCount(value.sequence,'sequence',1);if(value.sequence<=sequence)throw new Error('study-history-order');sequence=value.sequence;
    const record=await parseStudyRecord(value.record),bundle=bundles.get(record.snapshotId);if(record.libraryId!==libraryId||!bundle)throw new Error('study-record-history-binding');if(records.has(record.event.eventId))throw new Error('study-record-conflict');
    if(record.provenanceMode!=='task'){const item=bundle.items.find(item=>item.itemKey===record.event.item.key);if(!item)throw new Error('study-record-item-membership');checkStudyRecordBinding(record,item);}
    records.set(record.event.eventId,record);receipts.push({schemaVersion:1,libraryId,eventId:record.event.eventId,envelopeHash:record.envelopeHash,target:'cloud',status:'acked',revision:value.sequence});
  }
  for(const raw of writebacksRaw){const delivery=(raw as {delivery?:unknown})?.delivery;if(delivery){const receipt=parseReceipt(delivery);if(receipt.libraryId!==libraryId)throw new Error('study-receipt-binding');receipts.push(receipt);}}
  const savedReceipts=await Promise.all(receipts.map(async payload=>({payload,hash:await studyHash(payload)}))),ids=new Set([...records.keys(),...receipts.map(receipt=>receipt.eventId)]);owner();if(!ids.size)return receipts;
  const scope=[workspaceId,libraryId];
  for(let attempt=0;attempt<4;attempt++){
    owner();
    const before=await transaction<{rows:RecordRow[];snapshots:SnapshotRow[]}>([SNAPSHOTS,RECORDS],'readonly',({store,read,done})=>{
      read<SnapshotRow[]>(store(SNAPSHOTS).index('scope').getAll(scope),snapshots=>read<RecordRow[]>(store(RECORDS).index('scope').getAll(scope),rows=>done({snapshots,rows})));
    });
    const snapshots=new Map(before.snapshots.map(row=>[row.snapshotId,row])),previous=new Map(before.rows.filter(row=>ids.has(row.eventId)).map(row=>[row.eventId,row])),next=new Map<string,RecordRow>(),changed=new Set<string>();
    for(const bundle of bundles.values()){const snapshot=snapshots.get(bundle.snapshot.snapshotId);if(!snapshot)throw new Error('unknown-study-snapshot');checkStoredSnapshot(snapshot,workspaceId,bundle);}
    for(const row of previous.values()){await validateStoredRecord(row,workspaceId,libraryId);next.set(row.eventId,row);}
    for(const [eventId,record]of records){const old=previous.get(eventId);if(old){if(compareStudyRecord(old.record,record)!=='duplicate'||!sameValue(old.record,record))throw new Error('study-record-conflict');}
      else{next.set(eventId,{workspaceId,libraryId,eventId,record,cloud:'pending',writeback:'pending',receipts:{cloud:null,companion:null}});changed.add(eventId);}}
    for(const {payload,hash}of savedReceipts){const old=next.get(payload.eventId);if(!old)throw new Error('unknown-study-record');const merged=mergeReceipt(old,payload,hash);next.set(payload.eventId,merged.row);if(merged.changed)changed.add(payload.eventId);}
    owner();if(!changed.size)return receipts;
    try{await transaction<void>([SNAPSHOTS,RECORDS],'readwrite',({store,read,done})=>{
      read<SnapshotRow[]>(store(SNAPSHOTS).index('scope').getAll(scope),latest=>{
        owner();const currentSnapshots=new Map(latest.map(row=>[row.snapshotId,row]));for(const bundle of bundles.values()){const current=currentSnapshots.get(bundle.snapshot.snapshotId);if(!current)throw new Error('unknown-study-snapshot');checkStoredSnapshot(current,workspaceId,bundle);}
        read<RecordRow[]>(store(RECORDS).index('scope').getAll(scope),rows=>{owner();const current=new Map(rows.map(row=>[row.eventId,row]));for(const id of ids)if(!sameValue(current.get(id),previous.get(id)))throw new Error('study-history-race');for(const id of changed)store(RECORDS).put(next.get(id));done();});
      });
    });owner();return receipts;}catch(error){if(!(error instanceof Error)||error.message!=='study-history-race')throw error;}
  }
  throw new Error('study-history-retry-required');
}
export async function applyLocalStudyReceipt(workspaceId:string,raw:unknown):Promise<void> {
  workspace(workspaceId);const receipt=parseReceipt(raw),hash=await studyHash(receipt);
  for(let attempt=0;attempt<4;attempt++) {
    const before=await transaction<RecordRow|undefined>([RECORDS],'readonly',({store,read,done})=>{
      read<RecordRow|undefined>(store(RECORDS).get([workspaceId,receipt.libraryId,receipt.eventId]),done);
    });
    if(!before) throw new Error('unknown-study-record');
    await validateStoredRecord(before,workspaceId,receipt.libraryId);
    try {
      await transaction<void>([RECORDS],'readwrite',({store,read,done})=>{
        read<RecordRow|undefined>(store(RECORDS).get([workspaceId,receipt.libraryId,receipt.eventId]),row=>{
          if(!row||!sameValue(row,before)) throw new Error('study-receipt-race');
          const merged=mergeReceipt(row,receipt,hash);if(merged.changed)store(RECORDS).put(merged.row);done();
        });
      });return;
    } catch(error) {if(!(error instanceof Error)||error.message!=='study-receipt-race') throw error;}
  }
  throw new Error('study-receipt-retry-required');
}
async function validateStoredRecord(row:RecordRow,workspaceId:string,libraryId:string):Promise<LocalStudyRecord> {
  studyObject(row,['workspaceId','libraryId','eventId','record','cloud','writeback','receipts']);
  const record=await parseStudyRecord(row.record);
  if(row.workspaceId!==workspaceId||row.libraryId!==libraryId||record.libraryId!==libraryId||record.event.eventId!==row.eventId) {
    throw new Error('local-record-integrity');
  }
  studyObject(row.receipts,['cloud','companion']);
  for(const target of ['cloud','companion'] as const) {
    const saved=row.receipts[target],state=target==='cloud'?row.cloud:row.writeback;
    if(!saved){if(saved!==null||state!=='pending') throw new Error('local-receipt-integrity');continue;}
    studyObject(saved,['payload','hash']);studyDigest(saved.hash);
    const receipt=parseReceipt(saved.payload);
    if(receipt.target!==target||receipt.libraryId!==libraryId||receipt.eventId!==record.event.eventId
      ||receipt.envelopeHash!==record.envelopeHash||receipt.status!==state||await studyHash(receipt)!==saved.hash) throw new Error('local-receipt-integrity');
  }
  return {record,cloud:row.cloud,writeback:row.writeback,receipts:row.receipts};
}
export async function getLocalStudyRecord(workspaceId:string,libraryId:string,eventId:string):Promise<LocalStudyRecord|null>{
  workspace(workspaceId);studyId(libraryId,'library');studyId(eventId,'event');
  const row=await transaction<RecordRow|undefined>([RECORDS],'readonly',({store,read,done})=>read<RecordRow|undefined>(store(RECORDS).get([workspaceId,libraryId,eventId]),done));
  return row?validateStoredRecord(row,workspaceId,libraryId):null;
}
export async function listLocalStudyRecords(workspaceId:string,libraryId:string):Promise<LocalStudyRecord[]> {
  workspace(workspaceId);studyId(libraryId,'library');
  const rows=await transaction<RecordRow[]>([RECORDS],'readonly',({store,read,done})=>{
    read<RecordRow[]>(store(RECORDS).index('scope').getAll(IDBKeyRange.only([workspaceId,libraryId])),done);
  });
  const result:LocalStudyRecord[]=[];
  for(const row of rows) result.push(await validateStoredRecord(row,workspaceId,libraryId));
  return result.sort((a,b)=>compareEvidenceText(a.record.event.occurredAt,b.record.event.occurredAt)
    ||compareEvidenceText(a.record.event.eventId,b.record.event.eventId));
}
/** Causal lookup only, not a complete-history checkpoint. Keep the existing DB
 * version; filter the account/library range before expensive record validation. */
export async function listLocalStudyItemRecords(workspaceId:string,libraryId:string,itemKey:string):Promise<LocalStudyRecord[]>{
  workspace(workspaceId);studyId(libraryId,'library');studyId(itemKey,'item');
  const rows=await transaction<RecordRow[]>([RECORDS],'readonly',({store,read,done})=>read<RecordRow[]>(store(RECORDS).index('scope').getAll(IDBKeyRange.only([workspaceId,libraryId])),done));
  const result:LocalStudyRecord[]=[];
  for(const row of rows)if(row.record?.provenanceMode!=='task'&&row.record?.event?.eventType==='practice-attempt'&&row.record.event.item.key===itemKey)result.push(await validateStoredRecord(row,workspaceId,libraryId));
  return result;
}
export async function exportLocalAccountStudy(workspaceId:string,libraryId:string):Promise<{schemaVersion:1;workspaceId:string;libraryId:string;snapshots:StudyBundle[];records:LocalStudyRecord[]}>{workspace(workspaceId);studyId(libraryId,'library');const snapshots=await transaction<SnapshotRow[]>([SNAPSHOTS],'readonly',({store,read,done})=>read<SnapshotRow[]>(store(SNAPSHOTS).index('scope').getAll(IDBKeyRange.only([workspaceId,libraryId])),done)),bundles:StudyBundle[]=[];for(const row of snapshots){const bundle=await validateStudyBundle(row.bundle);checkStoredSnapshot(row,workspaceId,bundle);bundles.push(bundle);}return{schemaVersion:1,workspaceId,libraryId,snapshots:bundles.sort((left,right)=>left.snapshot.revision-right.snapshot.revision),records:await listLocalStudyRecords(workspaceId,libraryId)};}
export async function clearLocalAccountStudy(workspaceId:string,libraryId:string):Promise<void>{
  workspace(workspaceId);studyId(libraryId,'library');
  if((await listLocalStudyRecords(workspaceId,libraryId)).some(row=>row.cloud==='pending'))throw new Error('account-pending-records-must-export-and-sync');
  await transaction<void>([HEADS,RECORDS],'readwrite',({store,read,done})=>{
    // Recheck inside the same write transaction: another page can append after
    // the initial validation, but not between this check and its deletions.
    read<RecordRow[]>(store(RECORDS).index('scope').getAll(IDBKeyRange.only([workspaceId,libraryId])),rows=>{
      if(rows.some(row=>row.cloud!=='acked'))throw new Error('account-pending-records-must-export-and-sync');
      // Cloud receipt is not a writeback receipt. Keep every local record and
      // immutable snapshot: an independent journal can still need either for
      // offline recovery, even when there are no records in this transaction.
      store(HEADS).delete([workspaceId,libraryId]);done(undefined);
    });
  });
}
/** Include historical libraries, not only the current view heads. Primary-key
 * bounds stay within the already confirmed owner without upgrading the DB. */
export async function exportAllLocalAccountStudy(workspaceId:string):Promise<Awaited<ReturnType<typeof exportLocalAccountStudy>>[]>{
  workspace(workspaceId);const range=IDBKeyRange.bound([workspaceId],[workspaceId,[]]);
  const raw=await transaction<{snapshots:SnapshotRow[];records:RecordRow[]}>([SNAPSHOTS,RECORDS],'readonly',({store,read,done})=>{
    let snapshots:SnapshotRow[]|undefined,records:RecordRow[]|undefined;
    const finish=()=>{if(snapshots&&records)done({snapshots,records});};
    read<SnapshotRow[]>(store(SNAPSHOTS).getAll(range),value=>{snapshots=value;finish();});read<RecordRow[]>(store(RECORDS).getAll(range),value=>{records=value;finish();});
  });
  const result=new Map<string,Awaited<ReturnType<typeof exportLocalAccountStudy>>>();
  const library=(id:string)=>{studyId(id,'library');let value=result.get(id);if(!value){value={schemaVersion:1,workspaceId,libraryId:id,snapshots:[],records:[]};result.set(id,value);}return value;};
  for(const row of raw.snapshots){const bundle=await validateStudyBundle(row.bundle);checkStoredSnapshot(row,workspaceId,bundle);library(row.libraryId).snapshots.push(bundle);}
  for(const row of raw.records)library(row.libraryId).records.push(await validateStoredRecord(row,workspaceId,row.libraryId));
  for(const value of result.values()){value.snapshots.sort((a,b)=>a.snapshot.revision-b.snapshot.revision);value.records.sort((a,b)=>compareEvidenceText(a.record.event.eventId,b.record.event.eventId));}
  return [...result.values()].sort((a,b)=>compareEvidenceText(a.libraryId,b.libraryId));
}
export async function findLocalAccountStudyRecord(workspaceId:string,eventId:string):Promise<LocalStudyRecord|null>{
  workspace(workspaceId);studyId(eventId,'event');
  const rows=await transaction<RecordRow[]>([RECORDS],'readonly',({store,read,done})=>read(store(RECORDS).getAll(IDBKeyRange.bound([workspaceId],[workspaceId,[]])),done));
  const matches=rows.filter(row=>row.eventId===eventId);if(matches.length>1)throw new Error('account-event-library-conflict');
  return matches.length?validateStoredRecord(matches[0],workspaceId,matches[0].libraryId):null;
}
/** Ownership classification needs verified envelopes, not repeated full bundles. */
export async function listAllLocalAccountStudyRecords(workspaceId:string):Promise<LocalStudyRecord[]>{
  workspace(workspaceId);const rows=await transaction<RecordRow[]>([RECORDS],'readonly',({store,read,done})=>read(store(RECORDS).getAll(IDBKeyRange.bound([workspaceId],[workspaceId,[]])),done));
  const result:LocalStudyRecord[]=[];for(const row of rows)result.push(await validateStoredRecord(row,workspaceId,row.libraryId));return result;
}
