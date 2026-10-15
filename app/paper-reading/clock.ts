// @ts-expect-error TS5097: standalone Node contracts.
import {openStudyDb} from '../local-study-db.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {paperReadingClockKey, readPaperReadingClockCheckpoint, paperReadingGroupsKey, readPaperReadingGroupsCheckpoint, validatePaperReadingGroupsUpdate} from '../../src/application/paper-reading-clock/index.ts';
import type {PaperReadingClockCheckpoint, PaperReadingClockScope, PaperReadingClockStorePort, PaperReadingGroupsCheckpoint, PaperReadingGroupsStorePort} from '../../src/application/paper-reading-clock';

/** Thin adapter over the existing IDB store; no DB migration or answer mutation. */
export function createPaperReadingClockStore(options: {openDb?: () => Promise<IDBDatabase>} = {}): PaperReadingClockStorePort & PaperReadingGroupsStorePort {
    const open = options.openDb ?? openStudyDb;
    const transact = async (scope: PaperReadingClockScope, write?: {checkpoint: PaperReadingClockCheckpoint; expected: number}) => {
        const id = paperReadingClockKey(scope);
        if (typeof indexedDB === 'undefined' && !options.openDb) throw Error('本机数据库不可用，阅读计时尚未保存。');
        const database = await open();
        try {
            return await new Promise<PaperReadingClockCheckpoint | null>((resolve, reject) => {
                const tx = database.transaction('workspace-records', write ? 'readwrite' : 'readonly');
                const store = tx.objectStore('workspace-records'), request = store.get(id);
                let result: PaperReadingClockCheckpoint | null = null;
                request.onsuccess = () => {
                    try {
                        const row = request.result;
                        if (row) {
                            if (row.id !== id || row.workspaceId !== scope.ownerId || row.kind !== 'paper-reading-clock:v1') throw Error('corrupt-reading-clock-row');
                            result = readPaperReadingClockCheckpoint(row.value, scope);
                        }
                        if (!write) return;
                        const checkpoint = readPaperReadingClockCheckpoint(write.checkpoint, scope);
                        if (result?.operationId === checkpoint.operationId) {
                            if (JSON.stringify(result) !== JSON.stringify(checkpoint)) throw Error('reading-clock-operation-conflict');
                            return;
                        }
                        if ((result?.revision ?? 0) !== write.expected || checkpoint.revision !== write.expected + 1
                            || checkpoint.elapsedMs < (result?.elapsedMs ?? 0)) throw Error('reading-clock-conflict');
                        result = checkpoint;
                        store.put({id, workspaceId: scope.ownerId, kind: 'paper-reading-clock:v1', value: checkpoint});
                    } catch (cause) {
                        reject(cause);
                        try {tx.abort();} catch { /* The failing writer may already have aborted. */ }
                    }
                };
                tx.oncomplete = () => resolve(result);
                tx.onerror = () => reject(tx.error ?? Error('阅读计时保存失败。'));
                tx.onabort = () => reject(tx.error ?? Error('阅读计时保存已取消。'));
            });
        } finally {database.close();}
    };
    const transactGroups = async (scope: PaperReadingClockScope, write?: {value: PaperReadingGroupsCheckpoint; expected: number}) => {
        const id = paperReadingGroupsKey(scope);
        if (typeof indexedDB === 'undefined' && !options.openDb) throw Error('本机数据库不可用，阅读组尚未保存。');
        const database = await open();
        try {
            return await new Promise<PaperReadingGroupsCheckpoint | null>((resolve, reject) => {
                const tx = database.transaction('workspace-records', write ? 'readwrite' : 'readonly');
                const store = tx.objectStore('workspace-records'), legacyRequest = store.get(paperReadingClockKey(scope)), request = store.get(id);
                let result: PaperReadingGroupsCheckpoint | null = null;
                request.onsuccess = () => {
                    try {
                        const row = request.result;
                        if (row) {
                            if (row.id !== id || row.workspaceId !== scope.ownerId || row.kind !== 'paper-reading-groups:v1') throw Error('corrupt-reading-groups-row');
                            result = readPaperReadingGroupsCheckpoint(row.value, scope);
                        }
                        if (!write) return;
                        const value = readPaperReadingGroupsCheckpoint(write.value, scope);
                        if (result?.operationId === value.operationId) {
                            if (JSON.stringify(result) !== JSON.stringify(value)) throw Error('reading-groups-operation-conflict');
                            return;
                        }
                        if(!result){
                            const legacyRow=legacyRequest.result;
                            let legacyElapsedMs=0;
                            if(legacyRow){
                                if(legacyRow.id!==paperReadingClockKey(scope)||legacyRow.workspaceId!==scope.ownerId||legacyRow.kind!=='paper-reading-clock:v1')throw Error('reading-groups-legacy-conflict');
                                legacyElapsedMs=readPaperReadingClockCheckpoint(legacyRow.value,scope).elapsedMs;
                            }
                            if(value.legacyElapsedMs!==legacyElapsedMs)throw Error('reading-groups-legacy-conflict');
                        }
                        validatePaperReadingGroupsUpdate(result, value, write.expected);
                        result = value;
                        store.put({id, workspaceId: scope.ownerId, kind: 'paper-reading-groups:v1', value});
                    } catch (cause) {
                        reject(cause);
                        try {tx.abort();} catch { /* The failing writer may already have aborted. */ }
                    }
                };
                tx.oncomplete = () => resolve(result);
                tx.onerror = () => reject(tx.error ?? Error('阅读组保存失败。'));
                tx.onabort = () => reject(tx.error ?? Error('阅读组保存已取消。'));
            });
        } finally {database.close();}
    };
    return {
        read: scope => transact(scope),
        async save(scope, checkpoint, expectedRevision) {
            const result = await transact(scope, {checkpoint, expected: expectedRevision});
            if (!result) throw Error('reading-clock-receipt-missing');
            return result;
        },
        readGroups: scope => transactGroups(scope),
        async saveGroups(scope, value, expectedRevision) {
            const result = await transactGroups(scope, {value, expected: expectedRevision});
            if (!result) throw Error('reading-groups-receipt-missing');
            return result;
        },
    };
}
