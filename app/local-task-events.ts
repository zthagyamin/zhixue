import type {TaskEventV1} from './task-plan-types';
import type {CompanionPlanClient} from './companion-plan-client';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {openStudyDb,TASK_EVENTS_V1_STORE} from './local-study-db.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {validateTaskEvent} from './task-event-v1.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {compareEvidenceText} from './vocabulary-learning.ts';

type Record={workspaceId:string;eventId:string;event:TaskEventV1;occurredAt:string;delivered:boolean};
async function transaction<T>(mode:IDBTransactionMode,run:(store:IDBObjectStore,done:(value:T)=>void)=>void):Promise<T> {
  if (typeof indexedDB==='undefined') throw new Error('本地任务数据库不可用。');
  const database=await openStudyDb();
  try {
    return await new Promise<T>((resolve,reject)=>{
      const tx=database.transaction(TASK_EVENTS_V1_STORE,mode);let result:T;
      tx.oncomplete=()=>resolve(result);
      tx.onerror=()=>reject(tx.error??new Error('任务事件写入失败。'));
      tx.onabort=()=>reject(tx.error??new Error('任务事件写入已取消。'));
      try {run(tx.objectStore(TASK_EVENTS_V1_STORE),value=>{result=value;});}
      catch(error) {tx.abort();reject(error);}
    });
  } finally {database.close();}
}
function workspace(value:string):void {if (typeof value!=='string' || !value.trim()) throw new Error('invalid-task-workspace');}
export async function putTaskEvent(workspaceId:string,value:TaskEventV1):Promise<void> {
  workspace(workspaceId);const event=await validateTaskEvent(value);
  let conflict=false;
  await transaction<void>('readwrite',(store,done)=>{
    const request=store.get([workspaceId,event.eventId]);
    request.onsuccess=()=>{
      const old=request.result as Record|undefined;
      if (old && old.event.coreHash!==event.coreHash) {conflict=true;done();return;}
      store.put({workspaceId,eventId:event.eventId,event,occurredAt:event.occurredAt,delivered:old?.delivered??false} satisfies Record);
      done();
    };
  });
  if (conflict) throw new Error('task-event-conflict');
}
async function list(workspaceId:string,pending:boolean):Promise<TaskEventV1[]> {
  workspace(workspaceId);
  const rows=await transaction<Record[]>('readonly',(store,done)=>{
    const request=store.index('workspaceId').getAll(IDBKeyRange.only(workspaceId));
    request.onsuccess=()=>done(request.result);
  });
  const events=await Promise.all(rows.filter(row=>!pending || !row.delivered).map(row=>validateTaskEvent(row.event)));
  return events.sort((a,b)=>compareEvidenceText(a.occurredAt,b.occurredAt)||compareEvidenceText(a.eventId,b.eventId));
}
export function listTaskEvents(workspaceId:string):Promise<TaskEventV1[]> {return list(workspaceId,false);}
export function listPendingTaskEvents(workspaceId:string):Promise<TaskEventV1[]> {return list(workspaceId,true);}
export async function exportTaskEventRecords(workspaceId:string):Promise<Record[]>{
  workspace(workspaceId);const rows=await transaction<Record[]>('readonly',(store,done)=>{const r=store.index('workspaceId').getAll(IDBKeyRange.only(workspaceId));r.onsuccess=()=>done(r.result);});
  const result:Record[]=[];for(const row of rows){const event=await validateTaskEvent(row.event);
    if(row.workspaceId!==workspaceId||row.eventId!==event.eventId||row.occurredAt!==event.occurredAt||typeof row.delivered!=='boolean'||Object.keys(row).some(key=>!['workspaceId','eventId','event','occurredAt','delivered'].includes(key)))throw new Error('task-recovery-record-integrity');
    result.push({workspaceId,eventId:event.eventId,event,occurredAt:event.occurredAt,delivered:row.delivered});
  }return result.sort((a,b)=>compareEvidenceText(a.eventId,b.eventId));
}
export async function markTaskEventDelivered(workspaceId:string,eventId:string):Promise<void> {
  workspace(workspaceId);let missing=false;
  await transaction<void>('readwrite',(store,done)=>{
    const request=store.get([workspaceId,eventId]);
    request.onsuccess=()=>{
      if (!request.result) {missing=true;done();return;}
      store.put({...request.result,delivered:true});done();
    };
  });
  if (missing) throw new Error('unknown-task-event');
}

/** All-or-error completeness signal; already persisted evidence survives retries. */
export async function syncTaskEvents(workspaceId:string,client:Pick<CompanionPlanClient,'appendTaskEvent'|'getTaskEvents'>):Promise<TaskEventV1[]> {
  for (const event of await listPendingTaskEvents(workspaceId)) {
    const receipt=await client.appendTaskEvent(event);
    if (receipt.eventId!==event.eventId || receipt.durable!==true || !['accepted','duplicate'].includes(receipt.status)) throw new Error('invalid-task-event-receipt');
    await markTaskEventDelivered(workspaceId,event.eventId);
  }
  let after:string|undefined,snapshot:string|undefined;
  const cursors=new Set<string>();
  do {
    const page=await client.getTaskEvents(after);
    if (snapshot!==undefined && page.snapshotHash!==snapshot) throw new Error('task-history-changed');
    snapshot=page.snapshotHash;
    for (const event of page.events) {
      await putTaskEvent(workspaceId,event);
      await markTaskEventDelivered(workspaceId,event.eventId);
    }
    if (page.nextCursor!==null && cursors.has(page.nextCursor)) throw new Error('task-history-cursor-cycle');
    after=page.nextCursor??undefined;
    if (after) cursors.add(after);
  } while (after!==undefined);
  return listTaskEvents(workspaceId);
}
