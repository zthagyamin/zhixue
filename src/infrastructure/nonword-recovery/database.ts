export const NONWORD_RECOVERY_DATABASES=[
  {kind:'attempts',name:'zhixue-learning-attempts-v1',stores:['attempts','outbox','references']},
  {kind:'course-evidence',name:'zhixue-course-evidence-v1',stores:['records','outbox']},
  {kind:'practice-evidence',name:'zhixue-practice-evidence-v1',stores:['records','outbox']},
  {kind:'native-course',name:'zhixue-native-course-sources-v1',stores:['captures','identities','attempts']},
  {kind:'native-math',name:'zhixue-native-math-sources-v1',stores:['captures','identities','attempts','claims']},
  {kind:'math-mappings',name:'zhixue-approved-math-mappings-v1',stores:['records']},
  {kind:'native-math-mappings',name:'zhixue-native-math-mappings-v1',stores:['records']},
  {kind:'course-requests',name:'zhixue-course-requests-v1',stores:['requests']},
] as const;
export type RecoveryDatabaseKind=typeof NONWORD_RECOVERY_DATABASES[number]['kind'];
export type RecoveryRow=Record<string,unknown>&{key:string[]};
export type RecoveryDatabase={kind:RecoveryDatabaseKind;stores:Record<string,RecoveryRow[]>};

/** Missing databases are observed by an aborted creation, never silently initialized by export. */
export async function existingDatabase(name:string):Promise<IDBDatabase|null>{
  if(typeof indexedDB==='undefined')throw Error('nonword-recovery-storage-unavailable');
  return new Promise((resolve,reject)=>{
    let missing=false,settled=false;
    const request=indexedDB.open(name);
    const timer=setTimeout(()=>{settled=true;reject(Error('nonword-recovery-storage-timeout'));},10000);
    request.onupgradeneeded=event=>{if(event.oldVersion===0){missing=true;request.transaction?.abort();}};
    request.onerror=()=>{clearTimeout(timer);if(settled)return;settled=true;if(missing)resolve(null);else reject(request.error);};
    request.onblocked=()=>{clearTimeout(timer);settled=true;reject(Error('nonword-recovery-storage-blocked'));};
    request.onsuccess=()=>{
      clearTimeout(timer);const db=request.result;if(settled){db.close();return;}settled=true;
      if(db.version!==1){db.close();reject(Error('nonword-recovery-storage-version'));return;}
      db.onversionchange=()=>db.close();resolve(db);
    };
  });
}
export async function captureRecoveryDatabase(descriptor:typeof NONWORD_RECOVERY_DATABASES[number],owners:readonly string[]):Promise<RecoveryDatabase>{
  const db=await existingDatabase(descriptor.name);
  if(!db)return {kind:descriptor.kind,stores:Object.fromEntries(descriptor.stores.map(name=>[name,[]]))};
  try{
    if(descriptor.stores.some(name=>!db.objectStoreNames.contains(name)))throw Error('nonword-recovery-storage-schema');
    return await new Promise((resolve,reject)=>{
      const tx=db.transaction([...descriptor.stores],'readonly'),stores:Record<string,RecoveryRow[]>={};let failure:unknown;
      for(const name of descriptor.stores){
        if(tx.objectStore(name).keyPath!=='key'||tx.objectStore(name).autoIncrement){tx.abort();reject(Error('nonword-recovery-storage-schema'));return;}
        stores[name]=[];
        for(const owner of owners){
          const range=IDBKeyRange.bound([owner],[owner,[]]);
          const request=tx.objectStore(name).getAll(range,50001);
          request.onsuccess=()=>{
            try{
              const rows=request.result as RecoveryRow[];
              if(rows.length>50000)throw Error('nonword-recovery-record-limit');
              stores[name].push(...rows);
            }catch(error){failure=error;tx.abort();}
          };
        }
      }
      tx.oncomplete=()=>resolve({kind:descriptor.kind,stores});
      tx.onabort=()=>reject(failure??tx.error??Error('nonword-recovery-read-aborted'));
      tx.onerror=()=>reject(tx.error);
    });
  }finally{db.close();}
}
