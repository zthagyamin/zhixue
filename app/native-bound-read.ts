import type {StudyEventV3} from './study-event-v3';
import type {LocalStudyEventRecord} from './local-study-events';
// @ts-expect-error TS5097: standalone Node contracts.
import {openStudyDb,RECORD_STORE,STUDY_EVENTS_V3_STORE} from './local-study-db.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseCloudStudyEventV3} from './study-event-v3.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {mergeDownloadedEvent,workspaceEventRange,listWorkspaceStudyEvents} from './local-study-events.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject,studyId,studyCount,studyDigest} from './account-study-content.ts';
const PROTOCOL='zhixue-native-history-v1',KIND='native-v3-read-checkpoint';
type Ref={sequence:number;eventId:string;coreHash:string};
type Checkpoint={protocol:typeof PROTOCOL;workspaceId:string;cursor:number;revision:number;refs:Ref[]};
const empty=(workspaceId:string):Checkpoint=>({protocol:PROTOCOL,workspaceId,cursor:0,revision:0,refs:[]});
function checkpoint(raw:unknown,workspaceId:string):Checkpoint{
  if(raw===undefined)return empty(workspaceId);const value=studyObject(raw,['protocol','workspaceId','cursor','revision','refs']);
  if(value.protocol!==PROTOCOL||value.workspaceId!==workspaceId||!Array.isArray(value.refs))throw new Error('native-checkpoint-binding');studyCount(value.cursor,'cursor');studyCount(value.revision,'revision');
  let previous=0;const ids=new Set<string>();for(const rawRef of value.refs){const ref=studyObject(rawRef,['sequence','eventId','coreHash']);studyCount(ref.sequence,'sequence',1);studyId(ref.eventId,'event');studyDigest(ref.coreHash);if((ref.sequence as number)<=previous||ids.has(ref.eventId as string))throw new Error('native-checkpoint-order');previous=ref.sequence as number;ids.add(ref.eventId as string);}
  if(previous!==value.cursor)throw new Error('native-checkpoint-fence');return value as Checkpoint;
}
function verifyPrefix(base:Checkpoint,records:LocalStudyEventRecord[]){const byId=new Map(records.map(row=>[row.eventId,row]));for(const ref of base.refs){const row=byId.get(ref.eventId);if(row?.event.coreHash!==ref.coreHash||row.workspaceId!==base.workspaceId)throw new Error('native-checkpoint-history-missing');}}
const recordToken=(row:LocalStudyEventRecord)=>JSON.stringify([row.workspaceId,row.eventId,row.occurredAt,row.event]);
async function validateCachedRecord(row:LocalStudyEventRecord,workspaceId:string){
  const event=await parseCloudStudyEventV3(row.event);if(row.workspaceId!==workspaceId||row.eventId!==event.eventId||row.occurredAt!==event.occurredAt)throw new Error('native-checkpoint-record-binding');
}
export async function readNativeCheckpoint(workspaceId:string,verifyHistory=true):Promise<Checkpoint>{
  studyId(workspaceId,'workspace');const db=await openStudyDb();try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction([RECORD_STORE,STUDY_EVENTS_V3_STORE],'readonly'),head=tx.objectStore(RECORD_STORE).get(`${workspaceId}:${KIND}`),rows=tx.objectStore(STUDY_EVENTS_V3_STORE).index('by-workspace-occurred').getAll(workspaceEventRange(workspaceId));
    tx.oncomplete=async()=>{try{const value=checkpoint(head.result?.value,workspaceId);if(verifyHistory){verifyPrefix(value,rows.result);const refs=new Set(value.refs.map(ref=>ref.eventId));for(const row of rows.result as LocalStudyEventRecord[])if(refs.has(row.eventId))await validateCachedRecord(row,workspaceId);}resolve(value);}catch(error){reject(error);}};tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??new Error('native-checkpoint-read-aborted'));
  });}finally{db.close();}
}
type Row={sequence:number;event:StudyEventV3};
type Options={workspaceId:string;fetcher?:typeof fetch;signal?:AbortSignal;isCurrent:()=>boolean;forceFull?:boolean};
function check(options:Options){options.signal?.throwIfAborted();if(!options.isCurrent())throw new Error('study-workspace-changed');}
async function commit(options:Options,base:Checkpoint,through:number,downloaded:Row[],refs:Ref[]):Promise<void>{
  check(options);const relevant=new Set([...base.refs.map(ref=>ref.eventId),...downloaded.map(row=>row.event.eventId)]),tokens=new Map<string,string>();
  for(const row of await listWorkspaceStudyEvents(options.workspaceId))if(relevant.has(row.eventId)){await validateCachedRecord(row,options.workspaceId);tokens.set(row.eventId,recordToken(row));}
  check(options);const db=await openStudyDb();try{await new Promise<void>((resolve,reject)=>{
    const tx=db.transaction([RECORD_STORE,STUDY_EVENTS_V3_STORE],'readwrite'),records=tx.objectStore(STUDY_EVENTS_V3_STORE),heads=tx.objectStore(RECORD_STORE),request=heads.get(`${options.workspaceId}:${KIND}`);
    const fail=(error:unknown)=>{try{tx.abort();}catch{/* Already aborted: keep the original failure. */}reject(error);},abort=()=>fail(new Error('native-read-cancelled'));options.signal?.addEventListener('abort',abort,{once:true});
    request.onsuccess=()=>{try{check(options);const actual=checkpoint(request.result?.value,options.workspaceId);if(actual.revision!==base.revision||actual.cursor!==base.cursor)throw new Error('native-read-stale-checkpoint');
      const old=records.index('by-workspace-occurred').getAll(workspaceEventRange(options.workspaceId));old.onsuccess=()=>{try{
        check(options);if(!options.forceFull)verifyPrefix(base,old.result);const existing=new Map((old.result as LocalStudyEventRecord[]).map(row=>[row.eventId,row])),now=new Date().toISOString();
        for(const id of relevant){const value=existing.get(id);if(value&&tokens.get(id)!==recordToken(value))throw new Error('native-read-cache-changed');}
        for(const {event} of downloaded){const previous=existing.get(event.eventId);if(previous&&previous.event.coreHash!==event.coreHash)throw new Error('native-read-event-conflict');const value=mergeDownloadedEvent(previous,{workspaceId:options.workspaceId,eventId:event.eventId,event,cloud:'acked',companion:'not-required',occurredAt:event.occurredAt,updatedAt:now});records.put(value);}
        const value:Checkpoint={protocol:PROTOCOL,workspaceId:options.workspaceId,cursor:through,revision:base.revision+1,refs};const saved=heads.put({id:`${options.workspaceId}:${KIND}`,workspaceId:options.workspaceId,kind:KIND,value,updatedAt:now});saved.onsuccess=()=>{try{check(options);}catch(error){fail(error);}};
      }catch(error){fail(error);}};
    }catch(error){fail(error);}};
    tx.oncomplete=()=>{options.signal?.removeEventListener('abort',abort);resolve();};tx.onerror=()=>{options.signal?.removeEventListener('abort',abort);reject(tx.error??new Error('native-read-transaction-failed'));};tx.onabort=()=>{options.signal?.removeEventListener('abort',abort);reject(tx.error??new Error('native-read-transaction-aborted'));};
  });}finally{db.close();}
}
/** No compatibility fallback. Validate every page, then atomically publish the
 * full history and its checkpoint. Old clients keep their unchanged endpoint. */
export async function readBoundStudyHistory(options:Options):Promise<{supported:true;cursor:number;downloaded:number;projections:[]}>{
  check(options);if(!options.workspaceId.startsWith('account:'))throw new Error('native-read-owner-required');const userId=options.workspaceId.slice(8),fetcher=options.fetcher??fetch,base=await readNativeCheckpoint(options.workspaceId,!options.forceFull);
  let after=options.forceFull?0:base.cursor,through:number|undefined;const downloaded:Row[]=[],ids=new Set<string>(options.forceFull?[]:base.refs.map(ref=>ref.eventId));
  for(;;){check(options);const params=new URLSearchParams({expectedUserId:userId,after:String(after),limit:'20'});if(through!==undefined)params.set('through',String(through));
    const response=await fetcher(`/api/sync/study-events-v3?${params}`,{credentials:'same-origin',cache:'no-store',signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000)});check(options);
    if(!response.ok)throw new Error(`native-history-read-${response.status}`);const body=studyObject(await response.json(),['protocol','userId','through','nextCursor','hasMore','events']);
    if(body.protocol!==PROTOCOL||body.userId!==userId||!Array.isArray(body.events)||body.events.length>20)throw new Error('native-read-protocol-binding');studyCount(body.through,'through');studyCount(body.nextCursor,'next-cursor');
    if((body.through as number)<base.cursor||through!==undefined&&body.through!==through)throw new Error('native-read-fence');through=body.through as number;
    let cursor=after;for(const raw of body.events){const row=studyObject(raw,['sequence','event']);studyCount(row.sequence,'sequence',1);if((row.sequence as number)<=cursor||(row.sequence as number)>through)throw new Error('native-read-order');const event=await parseCloudStudyEventV3(row.event);if(ids.has(event.eventId))throw new Error('native-read-duplicate');ids.add(event.eventId);cursor=row.sequence as number;downloaded.push({sequence:cursor,event});}
    if(body.nextCursor!==cursor||body.hasMore!==(cursor<through)||cursor===after&&cursor<through)throw new Error('native-read-missing-page');after=cursor;if(!body.hasMore)break;
  }
  const refs=options.forceFull?[]:[...base.refs];refs.push(...downloaded.map(({sequence,event})=>({sequence,eventId:event.eventId,coreHash:event.coreHash})));
  if(options.forceFull)for(let i=0;i<base.refs.length;i++){const old=base.refs[i],value=refs[i];if(!value||value.sequence!==old.sequence||value.eventId!==old.eventId||value.coreHash!==old.coreHash)throw new Error('native-read-prefix-changed');}
  check(options);if(downloaded.length||base.revision===0)await commit(options,base,through!,downloaded,refs);else{const current=await readNativeCheckpoint(options.workspaceId);check(options);if(current.revision!==base.revision)throw new Error('native-read-stale-checkpoint');}
  return{supported:true,cursor:through!,downloaded:downloaded.length,projections:[]};
}
