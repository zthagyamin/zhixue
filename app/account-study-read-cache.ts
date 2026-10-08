import type {AccountReadModel} from './account-study-read-model';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {validateAccountReadModel,checkAccountReadAdvance} from './account-study-read-model.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {studyCount,studyId,studyObject,studyHash} from './account-study-content.ts';

export type AccountReadScope={userId:string;libraryId:string};
export type AccountCacheToken={userEpoch:number;generation:number};
type Head={userId:string;epoch:number;libraryId:string|null};
type Row=AccountReadScope&{schemaVersion:1;generation:number;model:AccountReadModel;hash:string};
type ReadResult={scope:AccountReadScope;token:AccountCacheToken;model:AccountReadModel|null};
function checkScope(scope:AccountReadScope):void{studyObject(scope,['userId','libraryId']);studyId(scope.userId,'user');studyId(scope.libraryId,'library');}
function open():Promise<IDBDatabase>{
  if(typeof indexedDB==='undefined')return Promise.reject(new Error('account-cache-unavailable'));
  return new Promise((resolve,reject)=>{const request=indexedDB.open('zhixue-account-read-cache-v1',1);
    request.onupgradeneeded=()=>{const db=request.result;db.createObjectStore('heads',{keyPath:'userId'});db.createObjectStore('checkpoints',{keyPath:['userId','libraryId']}).createIndex('user','userId');};
    request.onerror=()=>reject(request.error??new Error('account-cache-unavailable'));
    request.onblocked=()=>reject(new Error('account-cache-blocked'));
    request.onsuccess=()=>{request.result.onversionchange=()=>request.result.close();resolve(request.result);};});
}
type Control<T>={heads:IDBObjectStore;rows:IDBObjectStore;read:<R>(request:IDBRequest<R>,done:(value:R)=>void)=>void;done:(value:T)=>void};
async function transaction<T>(mode:IDBTransactionMode,run:(control:Control<T>)=>void,signal?:AbortSignal):Promise<T>{
  signal?.throwIfAborted();const database=await open();
  try{return await new Promise<T>((resolve,reject)=>{const tx=database.transaction(['heads','checkpoints'],mode);let result:T,finished=false,failure:unknown;
    const abort=(error:unknown)=>{failure??=error;try{tx.abort();}catch{/* A completed transaction is already durable. */}};
    const cancel=()=>abort(signal?.reason??new DOMException('Cancelled','AbortError'));
    const cleanup=()=>signal?.removeEventListener('abort',cancel);
    tx.oncomplete=()=>{cleanup();if(finished)resolve(result);else reject(new Error('account-cache-incomplete'));};
    tx.onerror=()=>{failure??=tx.error;};tx.onabort=()=>{cleanup();reject(failure??tx.error??new Error('account-cache-aborted'));};
    signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted){cancel();return;}
    try{run({heads:tx.objectStore('heads'),rows:tx.objectStore('checkpoints'),done:value=>{result=value;finished=true;},read:(request,handler)=>{request.onsuccess=()=>{try{handler(request.result);}catch(error){abort(error);}};}});}catch(error){abort(error);}
  });}finally{database.close();}
}
function head(raw:Head|undefined,userId:string):Head{
  if(!raw)return{userId,epoch:0,libraryId:null};studyObject(raw,['userId','epoch','libraryId']);studyCount(raw.epoch,'cache-epoch');
  if(raw.userId!==userId)throw new Error('account-cache-owner');if(raw.libraryId!==null)studyId(raw.libraryId,'library');return raw;
}
async function validated(row:Row|undefined,scope:AccountReadScope):Promise<AccountReadModel|null>{
  if(!row)return null;studyObject(row,['schemaVersion','userId','libraryId','generation','model','hash']);studyCount(row.generation,'cache-generation',1);
  if(row.schemaVersion!==1||row.userId!==scope.userId||row.libraryId!==scope.libraryId||await studyHash({scope,model:row.model})!==row.hash)throw new Error('account-cache-integrity');
  return validateAccountReadModel(row.model,scope.libraryId);
}
/** New database only. Clearing checkpoints never deletes attempts or receipt queues. */
export function createAccountReadCache(){
  return {
    async epoch(userId:string):Promise<number>{studyId(userId,'user');return transaction<number>('readonly',({heads,read,done})=>read<Head|undefined>(heads.get(userId),raw=>done(head(raw,userId).epoch)));},
    async read(scope:AccountReadScope):Promise<ReadResult>{
      checkScope(scope);const {owner,row}=await transaction<{owner:Head;row:Row|undefined}>('readonly',({heads,rows,read,done})=>read<Head|undefined>(heads.get(scope.userId),raw=>read<Row|undefined>(rows.get([scope.userId,scope.libraryId]),row=>done({owner:head(raw,scope.userId),row}))));
      return {scope:structuredClone(scope),token:{userEpoch:owner.epoch,generation:row?.generation??0},model:await validated(row,scope)};
    },
    async latest(userId:string):Promise<ReadResult|null>{
      studyId(userId,'user');const owner=await transaction<Head>('readonly',({heads,read,done})=>read<Head|undefined>(heads.get(userId),raw=>done(head(raw,userId))));
      if(!owner.libraryId)return null;const value=await this.read({userId,libraryId:owner.libraryId});return value.token.userEpoch===owner.epoch&&value.model?value:null;
    },
    async commit(scope:AccountReadScope,raw:unknown,token:AccountCacheToken,options:{signal?:AbortSignal}={}):Promise<ReadResult>{
      checkScope(scope);studyCount(token.userEpoch,'cache-epoch');studyCount(token.generation,'cache-generation');options.signal?.throwIfAborted();
      const model=await validateAccountReadModel(raw,scope.libraryId),hash=await studyHash({scope,model});options.signal?.throwIfAborted();
      const before=await this.read(scope);if(before.token.userEpoch!==token.userEpoch||before.token.generation!==token.generation)throw new Error('account-cache-stale');
      if(before.model)checkAccountReadAdvance(before.model,model);
      const generation=token.generation+1;studyCount(generation,'cache-generation',1);
      await transaction<void>('readwrite',({heads,rows,read,done})=>read<Head|undefined>(heads.get(scope.userId),raw=>{
        const owner=head(raw,scope.userId);read<Row|undefined>(rows.get([scope.userId,scope.libraryId]),current=>{
          if(owner.epoch!==token.userEpoch||(current?.generation??0)!==token.generation)throw new Error('account-cache-stale');
          rows.put({...scope,schemaVersion:1,generation,model,hash} satisfies Row);heads.put({...owner,libraryId:scope.libraryId});done(undefined);
        });
      }),options.signal);
      return {scope:structuredClone(scope),token:{userEpoch:token.userEpoch,generation},model:structuredClone(model)};
    },
    async clearUser(userId:string):Promise<void>{
      studyId(userId,'user');await transaction<void>('readwrite',({heads,rows,read,done})=>read<Head|undefined>(heads.get(userId),raw=>{
        const owner=head(raw,userId),epoch=owner.epoch+1;studyCount(epoch,'cache-epoch');heads.put({userId,epoch,libraryId:null});
        const cursor=rows.index('user').openCursor(userId);cursor.onsuccess=()=>{const entry=cursor.result;if(entry){entry.delete();entry.continue();}else done(undefined);};
      }));
    },
  };
}
export type AccountReadCache=ReturnType<typeof createAccountReadCache>;
