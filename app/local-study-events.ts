import type {DeliveryState,DeliveryTarget,StudyEventDelivery,LocalStudyEventRecord,StudyEventPutOutcome,StudyEventDiagnostics} from '../src/domain/sync';
export type {DeliveryState,DeliveryTarget,StudyEventDelivery,LocalStudyEventRecord,StudyEventPutOutcome,StudyEventDiagnostics} from '../src/domain/sync';
// @ts-expect-error TS5097: Node strip-types requires an explicit runtime TypeScript extension.
import { openStudyDb, STUDY_EVENTS_V3_STORE } from "./local-study-db.ts";

export function isStudyStorageFailure(error:unknown):boolean{
  if(!(error instanceof Error)||/conflict|integrity|binding|^invalid-|冲突/i.test(error.message))return false;
  return ['QuotaExceededError','UnknownError','AbortError','InvalidStateError','VersionError','NotFoundError','SecurityError'].includes(error.name)
    || /quota|storage-(?:unavailable|blocked|aborted|error)|本地事件.*失败|本地事件.*取消|本地学习数据库不可用/i.test(error.message);
}

const DELIVERY_RANK: Record<DeliveryState, number> = {
  "not-required": 0,
  pending: 1,
  acked: 2,
  conflict: 3,
};

export function localStudyEventKey(workspaceId: string, eventId: string): [string, string] {
  return [workspaceId, eventId];
}

export function transitionDelivery(
  delivery: StudyEventDelivery,
  target: DeliveryTarget,
  status: DeliveryState,
): StudyEventDelivery {
  return { ...delivery, [target]: status };
}

function mergeDeliveryState(left: DeliveryState, right: DeliveryState): DeliveryState {
  return DELIVERY_RANK[right] > DELIVERY_RANK[left] ? right : left;
}

/**
 * Pure insert/merge decision for one immutable event record. Same core hash
 * merges only delivery receipts; a different hash marks the applicable targets
 * as conflicts while preserving the originally stored event.
 */
export function mergeRecordOnPut(
  existing: LocalStudyEventRecord | undefined,
  incoming: LocalStudyEventRecord,
): { record: LocalStudyEventRecord; outcome: StudyEventPutOutcome } {
  if (existing === undefined) return { record: incoming, outcome: "inserted" };
  if (existing.event.coreHash !== incoming.event.coreHash) {
    return {
      record: {
        ...existing,
        cloud: existing.cloud === "not-required" ? "not-required" : "conflict",
        companion: existing.companion === "not-required" ? "not-required" : "conflict",
        updatedAt: new Date().toISOString(),
      },
      outcome: "conflict",
    };
  }
  return {
    record: {
      ...existing,
      cloud: mergeDeliveryState(existing.cloud, incoming.cloud),
      companion: mergeDeliveryState(existing.companion, incoming.companion),
      updatedAt: new Date().toISOString(),
    },
    outcome: "merged",
  };
}

/**
 * A cloud-downloaded event is cloud-acked and does not force Companion
 * delivery unless a local record already requires it. If the local record
 * carries a different immutable core hash for the same event id, the conflict
 * is preserved: the download cannot silently replace conflicting local
 * evidence or clear the conflict state.
 */
export function mergeDownloadedEvent(
  existing: LocalStudyEventRecord | undefined,
  downloaded: LocalStudyEventRecord,
): LocalStudyEventRecord {
  if (existing === undefined) return downloaded;
  if (existing.event.coreHash !== downloaded.event.coreHash) {
    return {
      ...existing,
      cloud: "conflict",
      companion: existing.companion === "not-required" ? "not-required" : "conflict",
      updatedAt: new Date().toISOString(),
    };
  }
  return {
    ...existing,
    cloud: "acked",
    companion: existing.companion === "not-required" ? "not-required" : existing.companion,
    updatedAt: new Date().toISOString(),
  };
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openStudyDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STUDY_EVENTS_V3_STORE, mode);
      const request = operation(transaction.objectStore(STUDY_EVENTS_V3_STORE));
      transaction.oncomplete = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("本地事件读写失败。"));
      transaction.onerror = () => reject(transaction.error ?? new Error("本地事件事务失败。"));
      transaction.onabort = () => reject(transaction.error ?? new Error("本地事件事务已取消。"));
    });
  } finally {
    database.close();
  }
}

export async function putLocalStudyEvent(record: LocalStudyEventRecord): Promise<StudyEventPutOutcome> {
  const database = await openStudyDb();
  try {
    return await new Promise<StudyEventPutOutcome>((resolve, reject) => {
      const transaction = database.transaction(STUDY_EVENTS_V3_STORE, "readwrite");
      const store = transaction.objectStore(STUDY_EVENTS_V3_STORE);
      let outcome:StudyEventPutOutcome|undefined;
      const existingRequest = store.get([record.workspaceId, record.eventId]);
      existingRequest.onsuccess = () => {
        try{
          const merged = mergeRecordOnPut(existingRequest.result, record);
          store.put(merged.record);outcome=merged.outcome;
        }catch(error){reject(error);transaction.abort();}
      };
      transaction.oncomplete=()=>{if(outcome)resolve(outcome);else reject(new Error('本地事件事务未完成写入。'));};
      existingRequest.onerror = () => reject(existingRequest.error ?? new Error("无法读取本地事件。"));
      transaction.onerror = () => reject(transaction.error ?? new Error("无法保存本地事件。"));
      transaction.onabort = () => reject(transaction.error ?? new Error("本地事件写入已取消。"));
    });
  } finally {
    database.close();
  }
}

export function getLocalStudyEvent(workspaceId: string, eventId: string): Promise<LocalStudyEventRecord | undefined> {
  return withStore("readonly", (store) => store.get([workspaceId, eventId]));
}

export function listPendingStudyEvents(workspaceId: string, target: DeliveryTarget): Promise<LocalStudyEventRecord[]> {
  const indexName = target === "cloud" ? "by-workspace-cloud" : "by-workspace-companion";
  return withStore("readonly", (store) => store.index(indexName).getAll(IDBKeyRange.only([workspaceId, "pending"])));
}

export async function listLocalItemEvents(
  workspaceId: string,
  itemKind: string,
  itemKey: string,
): Promise<LocalStudyEventRecord[]> {
  const database = await openStudyDb();
  try {
    return await new Promise<LocalStudyEventRecord[]>((resolve, reject) => {
      const transaction = database.transaction(STUDY_EVENTS_V3_STORE, "readonly");
      const request = transaction.objectStore(STUDY_EVENTS_V3_STORE).getAll();
      request.onsuccess = () => {
        const records = (request.result as LocalStudyEventRecord[])
          .filter((record) => record.workspaceId === workspaceId && record.event.item.kind === itemKind && record.event.item.key === itemKey);
        resolve(records);
      };
      request.onerror = () => reject(request.error ?? new Error("无法读取本地事件。"));
      transaction.onerror = () => reject(transaction.error ?? new Error("本地事件读取失败。"));
    });
  } finally {
    database.close();
  }
}

export async function updateStudyEventDelivery(
  workspaceId: string,
  eventId: string,
  target: DeliveryTarget,
  status: DeliveryState,
): Promise<void> {
  const database = await openStudyDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STUDY_EVENTS_V3_STORE, "readwrite");
      const store = transaction.objectStore(STUDY_EVENTS_V3_STORE);
      const request = store.get([workspaceId, eventId]);
      request.onsuccess = () => {
        const existing = request.result as LocalStudyEventRecord | undefined;
        if (existing === undefined) return;
        store.put({
          ...existing,
          ...transitionDelivery({ cloud: existing.cloud, companion: existing.companion }, target, status),
          updatedAt: new Date().toISOString(),
        });
      };
      request.onerror = () => reject(request.error ?? new Error("无法读取本地事件。"));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("无法更新本地事件回执。"));
      transaction.onabort = () => reject(transaction.error ?? new Error("本地事件回执更新已取消。"));
    });
  } finally {
    database.close();
  }
}

export async function mergeDownloadedStudyEvent(downloaded: LocalStudyEventRecord): Promise<void> {
  const database = await openStudyDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STUDY_EVENTS_V3_STORE, "readwrite");
      const store = transaction.objectStore(STUDY_EVENTS_V3_STORE);
      const request = store.get([downloaded.workspaceId, downloaded.eventId]);
      request.onsuccess = () => {
        const merged = mergeDownloadedEvent(request.result, downloaded);
        store.put(merged);
      };
      request.onerror = () => reject(request.error ?? new Error("无法读取本地事件。"));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("无法合并下载事件。"));
      transaction.onabort = () => reject(transaction.error ?? new Error("下载事件合并已取消。"));
    });
  } finally {
    database.close();
  }
}

// 学习效果仪表盘用：按 workspace 列出全部本地 v3 事件记录（复用
// by-workspace-occurred 索引，与诊断统计同一条查询路径）。
export function workspaceEventRange(workspaceId: string): IDBKeyRange {
  return IDBKeyRange.bound([workspaceId, ''], [workspaceId, '\uffff']);
}

export async function listWorkspaceStudyEvents(workspaceId: string): Promise<LocalStudyEventRecord[]> {
  const database = await openStudyDb();
  try {
    return await new Promise<LocalStudyEventRecord[]>((resolve, reject) => {
      const transaction = database.transaction(STUDY_EVENTS_V3_STORE, "readonly");
      const store = transaction.objectStore(STUDY_EVENTS_V3_STORE);
      const index = store.index("by-workspace-occurred");
      const request = index.getAll(workspaceEventRange(workspaceId));
      request.onsuccess = () => resolve(request.result as LocalStudyEventRecord[]);
      request.onerror = () => reject(request.error ?? new Error("无法读取本地学习事件。"));
      transaction.onerror = () => reject(transaction.error ?? new Error("本地学习事件读取失败。"));
    });
  } finally {
    database.close();
  }
}

export async function getLocalStudyEventDiagnostics(workspaceId: string): Promise<StudyEventDiagnostics> {
  const database = await openStudyDb();
  try {
    return await new Promise<StudyEventDiagnostics>((resolve, reject) => {
      const transaction = database.transaction(STUDY_EVENTS_V3_STORE, "readonly");
      const store = transaction.objectStore(STUDY_EVENTS_V3_STORE);
      const index = store.index("by-workspace-occurred");
      const request = index.getAll(workspaceEventRange(workspaceId));
      request.onsuccess = () => {
        const records = request.result as LocalStudyEventRecord[];
        resolve({
          total: records.length,
          pendingCloud: records.filter((record) => record.cloud === "pending").length,
          pendingCompanion: records.filter((record) => record.companion === "pending").length,
          conflicts: records.filter((record) => record.cloud === "conflict" || record.companion === "conflict").length,
          ...(records.length === 0 ? {} : { latestEventAt: records.at(-1)!.occurredAt }),
        });
      };
      request.onerror = () => reject(request.error ?? new Error("无法读取本地事件统计。"));
      transaction.onerror = () => reject(transaction.error ?? new Error("本地事件统计读取失败。"));
    });
  } finally {
    database.close();
  }
}
