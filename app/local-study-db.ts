// @ts-expect-error TS5097: standalone Node regression tests.
import {parseBackupTrialMaterials} from './trial-material-backup-model.ts';
const DATABASE_NAME = "zhixue-local-study-v1";
const DATABASE_VERSION = 3;
const RECORD_STORE = "workspace-records";
const STUDY_EVENTS_V3_STORE = "study-events-v3";
const TASK_EVENTS_V1_STORE = 'task-events-v1';

export type WorkspaceRecordKind = `note-trial-materials:${string}` | `recall-attempt:${string}` | `subject-organization:${string}` | `paper-draft:${string}` | `paper-document:${string}` | "progress" | "pending-activities" | "companion-session" | `companion-session:${string}` | "cloud-outbox" | "cloud-sync-metadata" | "plugin-overrides" | "plan-constraints" | "practice-cache" | "module-catalog" | "vocab-pacing" | "vocab-pacing-by-subject" | "task-plan-drafts" | "task-planning-cache" | "task-plan-backups" | "account-study-preference" | "account-study-device" | "account-plan-ai-requests" | "account-question-ai-requests" | "long-term-plan";

type WorkspaceRecord<T> = {
  id: string;
  workspaceId: string;
  kind: WorkspaceRecordKind;
  value: T;
  updatedAt: string;
};

function recordId(workspaceId: string, kind: WorkspaceRecordKind) {
  return `${workspaceId}:${kind}`;
}

export function openStudyDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onblocked = () => {blocked = true;reject(new Error('请先保存并关闭其他标签页中的知学，再重试打开本地学习数据库。'));};
    request.onupgradeneeded = () => {
      const database = request.result;
      // Additive upgrades only: existing stores are never deleted or rewritten.
      if (!database.objectStoreNames.contains(RECORD_STORE)) {
        const store = database.createObjectStore(RECORD_STORE, { keyPath: "id" });
        store.createIndex("workspaceId", "workspaceId", { unique: false });
      }
      if (!database.objectStoreNames.contains(STUDY_EVENTS_V3_STORE)) {
        const store = database.createObjectStore(STUDY_EVENTS_V3_STORE, { keyPath: ["workspaceId", "eventId"] });
        store.createIndex("by-workspace-occurred", ["workspaceId", "occurredAt"]);
        store.createIndex("by-workspace-cloud", ["workspaceId", "cloud"]);
        store.createIndex("by-workspace-companion", ["workspaceId", "companion"]);
      }
      if (!database.objectStoreNames.contains(TASK_EVENTS_V1_STORE)) {
        const store=database.createObjectStore(TASK_EVENTS_V1_STORE,{keyPath:['workspaceId','eventId']});
        store.createIndex('workspaceId','workspaceId');
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if(blocked){database.close();return;}
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error ?? new Error("无法打开本地学习数据库。"));
  });
}

export { STUDY_EVENTS_V3_STORE,TASK_EVENTS_V1_STORE,RECORD_STORE };

export async function loadWorkspaceRecord<T>(
  workspaceId: string,
  kind: WorkspaceRecordKind,
  fallback: T,
): Promise<T> {
  if (typeof indexedDB === "undefined") return fallback;
  const database = await openStudyDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = database.transaction(RECORD_STORE, "readonly").objectStore(RECORD_STORE).get(recordId(workspaceId, kind));
      request.onsuccess = () => resolve((request.result as WorkspaceRecord<T> | undefined)?.value ?? fallback);
      request.onerror = () => reject(request.error ?? new Error("无法读取本地学习空间。"));
    });
  } finally {
    database.close();
  }
}

export async function saveWorkspaceRecord<T>(
  workspaceId: string,
  kind: WorkspaceRecordKind,
  value: T,
): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const database = await openStudyDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(RECORD_STORE, "readwrite");
      transaction.objectStore(RECORD_STORE).put({
        id: recordId(workspaceId, kind),
        workspaceId,
        kind,
        value,
        updatedAt: new Date().toISOString(),
      } satisfies WorkspaceRecord<T>);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("无法保存本地学习空间。"));
      transaction.onabort = () => reject(transaction.error ?? new Error("本地学习空间写入已取消。"));
    });
  } finally {
    database.close();
  }
}

export async function migrateLegacyLocalStorage<T>(
  workspaceId: string,
  legacyKey: string,
  kind: WorkspaceRecordKind,
  fallback: T,
): Promise<T> {
  const existing = await loadWorkspaceRecord<T | null>(workspaceId, kind, null);
  if (existing !== null) return existing;
  if (typeof localStorage === "undefined") return fallback;

  const migrationOwnerKey = `zhixue-migration-owner:${legacyKey}`;
  const migrationOwner = localStorage.getItem(migrationOwnerKey);
  if (migrationOwner && migrationOwner !== workspaceId) return fallback;

  try {
    const raw = localStorage.getItem(legacyKey);
    if (!raw) return fallback;
    const value = JSON.parse(raw) as T;
    await saveWorkspaceRecord(workspaceId, kind, value);
    localStorage.setItem(migrationOwnerKey, workspaceId);
    return value;
  } catch {
    return fallback;
  }
}

/** Atomic read/modify/write, including across tabs sharing this database. */
export async function updateWorkspaceRecord<T>(workspaceId:string,kind:WorkspaceRecordKind,fallback:T,update:(current:T)=>T):Promise<void> {
  if (typeof indexedDB==='undefined') throw new Error('本地学习数据库不可用，尚未保存草稿。');
  const database=await openStudyDb();
  try {
    await new Promise<void>((resolve,reject)=>{
      const transaction=database.transaction(RECORD_STORE,'readwrite');
      const store=transaction.objectStore(RECORD_STORE);
      const request=store.get(recordId(workspaceId,kind));
      request.onsuccess=()=>{
        try {
          const value=update((request.result as WorkspaceRecord<T>|undefined)?.value??fallback);
          store.put({id:recordId(workspaceId,kind),workspaceId,kind,value,updatedAt:new Date().toISOString()} satisfies WorkspaceRecord<T>);
        } catch(error) {transaction.abort();reject(error);}
      };
      request.onerror=()=>reject(request.error??new Error('无法读取本地学习空间。'));
      transaction.oncomplete=()=>resolve();
      transaction.onerror=()=>reject(transaction.error??new Error('无法保存本地学习空间。'));
      transaction.onabort=()=>reject(transaction.error??new Error('本地学习空间写入已取消。'));
    });
  } finally {database.close();}
}
/** Delete only reconstructible caches, never drafts, rules, identity or outboxes. */
export async function clearAccountWorkspaceRecords(workspaceId:string):Promise<void>{
  if(!workspaceId.startsWith('account:')||typeof indexedDB==='undefined')throw new Error('invalid-account-workspace');
  const database=await openStudyDb();try{await new Promise<void>((resolve,reject)=>{
    const tx=database.transaction(RECORD_STORE,'readwrite'),store=tx.objectStore(RECORD_STORE);
    // Retired subject navigation may exist only in module-catalog locally.
    for(const kind of ['practice-cache','task-planning-cache'] as const)store.delete(recordId(workspaceId,kind));
    tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error??new Error('无法清理本地账号缓存。'));tx.onabort=()=>reject(tx.error??new Error('本地账号缓存清理已取消。'));
  });}finally{database.close();}
}

export function workspaceIdForUser(userId: string | null) {
  return userId ? `account:${userId}` : "guest:local";
}

/** Explicit recovery allowlist: pairing credentials and AI request keys (which
 * may contain raw input in older clients) must never enter a learning export. */
export async function exportRecoveryWorkspaceRecords(workspaceId:string):Promise<WorkspaceRecord<unknown>[]>{
  if(!workspaceId.startsWith('account:')||workspaceId.length<=8)throw new Error('invalid-recovery-owner');
  const allowed:WorkspaceRecordKind[]=['progress','pending-activities','cloud-outbox','cloud-sync-metadata','plugin-overrides','plan-constraints','module-catalog','vocab-pacing','vocab-pacing-by-subject','task-plan-drafts','task-plan-backups','account-study-preference','account-study-device','long-term-plan'];
  const db=await openStudyDb();try{return await new Promise((resolve,reject)=>{const tx=db.transaction(RECORD_STORE,'readonly'),request=tx.objectStore(RECORD_STORE).index('workspaceId').getAll(workspaceId);
    tx.oncomplete=()=>{try{const rows=(request.result as WorkspaceRecord<unknown>[]).filter(row=>allowed.includes(row.kind)||row.kind.startsWith('recall-attempt:')||row.kind.startsWith('paper-draft:')||row.kind.startsWith('paper-document:')||row.kind.startsWith('subject-organization:')||row.kind.startsWith('note-trial-materials:'));
      if(rows.some(row=>row.workspaceId!==workspaceId||row.id!==recordId(workspaceId,row.kind)))throw new Error('recovery-workspace-record-integrity');for(const row of rows)if(row.kind.startsWith('note-trial-materials:')){const library=JSON.parse(row.kind.slice('note-trial-materials:'.length));if(typeof library!=='string'||!library.trim())throw new Error('invalid-trial-library');row.value=parseBackupTrialMaterials(row.value);}
      resolve(rows.sort((a,b)=>a.kind.localeCompare(b.kind)));
    }catch(error){reject(error);}};tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??new Error('recovery-read-aborted'));
  });}finally{db.close();}
}
export async function listAccountProgressLibraries(workspaceId:string):Promise<string[]>{
  if(!workspaceId.startsWith('account:')||workspaceId.length<=8)throw new Error('invalid-recovery-owner');
  const base='account-progress:',prefix=base+JSON.stringify([workspaceId]).slice(0,-1)+',',db=await openStudyDb();
  try{return await new Promise((resolve,reject)=>{const tx=db.transaction(RECORD_STORE,'readonly'),request=tx.objectStore(RECORD_STORE).getAll(IDBKeyRange.bound(prefix,prefix+'\uffff'));
    tx.oncomplete=()=>{try{const ids=new Set<string>();for(const row of request.result as WorkspaceRecord<unknown>[]){if(row.kind!=='progress')continue;
      const identity=JSON.parse(row.workspaceId.slice(base.length));if(!Array.isArray(identity)||identity.length!==2||identity[0]!==workspaceId||typeof identity[1]!=='string'||row.id!==recordId(row.workspaceId,'progress'))throw new Error('recovery-progress-scope');ids.add(identity[1]);}
      resolve([...ids].sort());}catch(error){reject(error);}};tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error??new Error('recovery-read-aborted'));
  });}finally{db.close();}
}
