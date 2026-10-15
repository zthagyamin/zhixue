import type {PaperReadingScope,PaperReadingStorePort,PaperReadingReceipt} from '../../application/paper-reading';
import type {PaperReadingMutation,PaperReadingWorkspaceV1} from '../../domain/paper-reading';
// @ts-expect-error TS5097: standalone Node contracts.
import {applyPaperReadingMutation,parsePaperReadingMutation,parsePaperReadingWorkspace} from '../../domain/paper-reading/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalAttemptJson} from '../../domain/learning-attempt/index.ts';
export interface PaperReadingKvPort{
    read(key:string):Promise<unknown|null>;
    update(key:string,change:(value:unknown|null)=>unknown):Promise<void>;
}
const namespace='paper-reading:v1:';
const storageWorkspace='paper-reading-workspaces:v1';
function key(scope:PaperReadingScope,unitId:string){
    if(!scope||typeof scope.ownerId!=='string'||!scope.ownerId.trim()||scope.ownerId.length>200
        ||typeof scope.libraryId!=='string'||!scope.libraryId.trim()||scope.libraryId.length>200
        ||typeof unitId!=='string'||!unitId.trim()||unitId.length>200)throw Error('paper-reading-scope');
    return namespace+JSON.stringify([scope.ownerId,scope.libraryId,unitId]);
}
function checked(scope:PaperReadingScope,unitId:string,raw:unknown):PaperReadingWorkspaceV1|null{
    if(raw===null)return null;
    const workspace=parsePaperReadingWorkspace(raw),source=workspace.unit.source;
    if(source.ownerId!==scope.ownerId||source.libraryId!==scope.libraryId||workspace.unit.unitId!==unitId)throw Error('paper-reading-record-scope');
    return workspace;
}
export function createPaperReadingLocalStore(port:PaperReadingKvPort):PaperReadingStorePort{
    async function write(inputScope:PaperReadingScope,raw:PaperReadingMutation,service:boolean):Promise<PaperReadingReceipt>{
        const scope=structuredClone(inputScope),mutation=parsePaperReadingMutation(raw),recordKey=key(scope,mutation.unitId);
        if(mutation.kind==='register'&&(mutation.unit.source.ownerId!==scope.ownerId||mutation.unit.source.libraryId!==scope.libraryId))throw Error('paper-reading-source-scope');
        let receipt:PaperReadingReceipt|undefined;
        await port.update(recordKey,value=>{
            const current=checked(scope,mutation.unitId,value),result=applyPaperReadingMutation(current,mutation,service?'service':'public');
            receipt={schemaVersion:1,operationId:mutation.operationId,status:result.status,durable:result.status!=='conflict',workspace:result.workspace};
            return result.workspace;
        });
        if(!receipt)throw Error('paper-reading-save-unavailable');
        return receipt;
    }
    return {
        supported:async()=>typeof indexedDB!=='undefined',
        read:async(inputScope,unitId)=>{const scope=structuredClone(inputScope);return checked(scope,unitId,await port.read(key(scope,unitId)));},
        mutate:(scope,mutation)=>write(scope,mutation,false),
        writeService:(scope,mutation)=>write(scope,mutation,true),
        async hydrate(inputScope,raw){
            const scope=structuredClone(inputScope),incoming=parsePaperReadingWorkspace(raw),unitId=incoming.unit.unitId;
            checked(scope,unitId,incoming);let saved:PaperReadingWorkspaceV1=incoming;
            await port.update(key(scope,unitId),value=>{
                const current=checked(scope,unitId,value);
                if(!current)return incoming;
                if(canonicalAttemptJson(current.unit)!==canonicalAttemptJson(incoming.unit))throw Error('paper-reading-cloud-conflict');
                const length=Math.min(current.operations.length,incoming.operations.length);
                for(let i=0;i<length;i++)if(canonicalAttemptJson(current.operations[i])!==canonicalAttemptJson(incoming.operations[i]))throw Error('paper-reading-cloud-conflict');
                saved=current.operations.length>incoming.operations.length?current:incoming;
                return saved;
            });
            return saved;
        },
    };
}
/** Uses the existing store in an owned namespace; null/corrupt payloads are never defaulted away. */
export function createPaperReadingIndexedDbPort(open:()=>Promise<IDBDatabase>):PaperReadingKvPort{
    function identity(recordKey:string){
        if(!recordKey.startsWith(namespace))throw Error('paper-reading-record-key');
        const parts=JSON.parse(recordKey.slice(namespace.length));
        if(!Array.isArray(parts)||parts.length!==3||key({ownerId:parts[0],libraryId:parts[1]},parts[2])!==recordKey)throw Error('paper-reading-record-key');
        return storageWorkspace+':'+recordKey;
    }
    function unwrap(row:unknown,recordKey:string):unknown|null{
        if(row===undefined)return null;
        if(!row||typeof row!=='object')throw Error('paper-reading-corrupt-envelope');
        const value=row as Record<string,unknown>;
        if(value.id!==identity(recordKey)||value.workspaceId!==storageWorkspace||value.kind!==recordKey||!value.value)throw Error('paper-reading-corrupt-envelope');
        return value.value;
    }
    async function db(){if(typeof indexedDB==='undefined')throw Error('本机无法可靠保存阅读答案。');return open();}
    return {
        async read(recordKey){
            const id=identity(recordKey),database=await db();
            try{return await new Promise<unknown|null>((resolve,reject)=>{
                const tx=database.transaction('workspace-records','readonly'),request=tx.objectStore('workspace-records').get(id);
                tx.oncomplete=()=>{try{resolve(unwrap(request.result,recordKey));}catch(error){reject(error);}};
                tx.onerror=tx.onabort=()=>reject(tx.error??Error('阅读答案读取失败。'));
            });}finally{database.close();}
        },
        async update(recordKey,change){
            const id=identity(recordKey),database=await db();
            try{await new Promise<void>((resolve,reject)=>{
                const tx=database.transaction('workspace-records','readwrite'),store=tx.objectStore('workspace-records'),request=store.get(id);
                request.onsuccess=()=>{
                    try{const value=change(unwrap(request.result,recordKey));
                        if(value===null)throw Error('paper-reading-empty-write');
                        store.put({id,workspaceId:storageWorkspace,kind:recordKey,value,updatedAt:new Date().toISOString()});
                    }catch(error){tx.abort();reject(error);}
                };
                tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error??Error('阅读答案未能保存。'));
            });}finally{database.close();}
        },
    };
}
