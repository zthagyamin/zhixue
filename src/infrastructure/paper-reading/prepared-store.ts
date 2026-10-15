import type {PaperReadingScope,PreparedPaperTaskStorePort} from '../../application/paper-reading';
import type {PaperReadingUnitV1} from '../../domain/paper-reading';
// @ts-expect-error TS5097: standalone Node contracts.
import {paperReadingUnit} from '../../domain/paper-reading/index.ts';

const namespace='paper-reading-prepared:v1';
function identity(scope:PaperReadingScope,raw:PaperReadingUnitV1){
    const unit=paperReadingUnit(raw),source=unit.source;
    if(!scope||scope.ownerId!==source.ownerId||scope.libraryId!==source.libraryId)throw Error('paper-prepared-scope');
    const kind=JSON.stringify([scope.ownerId,scope.libraryId,unit.unitId,source.materialFingerprint,source.sourceVersion,
        source.sectionId,source.paragraphs.map(p=>p.id),unit.goal]);
    return {id:namespace+':'+kind,kind};
}
/** Dedicated immutable recipe history with a transactional active pointer in the existing database. */
export function createPreparedPaperTaskIndexedDbStore(open:()=>Promise<IDBDatabase>):PreparedPaperTaskStorePort{
    function unwrap(row:unknown,id:string,kind:string):unknown|null{
        if(row===undefined)return null;
        if(!row||typeof row!=='object'||Array.isArray(row))throw Error('paper-prepared-corrupt-envelope');
        const value=row as Record<string,unknown>;
        if(value.id!==id||value.workspaceId!==namespace||value.kind!==kind||!value.value)throw Error('paper-prepared-corrupt-envelope');
        return value.value;
    }
    async function database(){
        if(typeof indexedDB==='undefined')throw Error('本机无法可靠保存预备题。');
        return open();
    }
    return {
        async read(scope,unit){
            const {id,kind}=identity(scope,unit),db=await database();
            try{return await new Promise<unknown|null>((resolve,reject)=>{
                const tx=db.transaction('workspace-records','readonly'),get=tx.objectStore('workspace-records').get(id);
                tx.oncomplete=()=>{try{resolve(unwrap(get.result,id,kind));}catch(error){reject(error);}};
                tx.onabort=tx.onerror=()=>reject(tx.error??Error('paper-prepared-read-failed'));
            });}finally{db.close();}
        },
        async update(scope,unit,change){
            const {id,kind}=identity(scope,unit),db=await database();
            try{await new Promise<void>((resolve,reject)=>{
                const tx=db.transaction('workspace-records','readwrite'),store=tx.objectStore('workspace-records'),get=store.get(id);
                get.onsuccess=()=>{
                    try{const value=change(unwrap(get.result,id,kind));
                        store.put({id,workspaceId:namespace,kind,value,updatedAt:new Date().toISOString()});
                    }catch(error){tx.abort();reject(error);}
                };
                tx.oncomplete=()=>resolve();tx.onabort=tx.onerror=()=>reject(tx.error??Error('paper-prepared-save-failed'));
            });}finally{db.close();}
        },
    };
}
