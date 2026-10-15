// @ts-expect-error TS5097: standalone Node contracts.
import {recoveryRanges, recoveryScope, identifyRecoveryRow, PAPER_READING_RECOVERY_MAX_RECORDS, PAPER_READING_RECOVERY_MAX_BYTES} from '../../application/paper-reading-recovery/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalAttemptJson} from '../../domain/learning-attempt/index.ts';
import type {PaperReadingRecoveryScope, PaperReadingRecoveryRow, PaperReadingRecoveryPort} from '../../application/paper-reading-recovery';

/** Scoped range reads and all-or-nothing restore over the existing single object store. */
export function createPaperReadingRecoveryIndexedDbPort(options: {
    scope: PaperReadingRecoveryScope;
    open: () => Promise<IDBDatabase>;
    isCurrent?: () => boolean;
    range?: (lower: string, upper: string) => IDBKeyRange;
}): PaperReadingRecoveryPort {
    const scope = recoveryScope(options.scope), selectors = recoveryRanges(scope);
    const current = () => {if (options.isCurrent?.() === false) throw Error('reading-recovery-inactive-scope');};
    const open = async () => {current(); if (typeof indexedDB === 'undefined') throw Error('本机数据库不可用，未完成备份或恢复。'); return options.open();};
    const row = (raw: unknown): PaperReadingRecoveryRow => {
        const value = raw as PaperReadingRecoveryRow; identifyRecoveryRow(scope, value);
        return {id: value.id, workspaceId: value.workspaceId, kind: value.kind, value: value.value};
    };
    const equal = (left: unknown, right: PaperReadingRecoveryRow) => {
        if (!left || typeof left !== 'object') return false;
        if (Object.keys(left).some(key => !['id', 'workspaceId', 'kind', 'value', 'updatedAt'].includes(key))) return false;
        const value = left as PaperReadingRecoveryRow;
        const plain = (entry: unknown): boolean => {
            if (entry === null || entry === undefined || typeof entry === 'string' || typeof entry === 'boolean') return true;
            if (typeof entry === 'number') return Number.isFinite(entry);
            if (Array.isArray(entry)) return entry.every(item => item !== undefined && plain(item));
            if (typeof entry === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(entry))) return Object.values(entry).every(plain);
            return false;
        };
        if (!plain(value.value)) return false;
        // Old material objects contain optional undefined fields; the portable format is JSON.
        const body = JSON.parse(JSON.stringify({id: value.id, workspaceId: value.workspaceId, kind: value.kind, value: value.value}));
        return canonicalAttemptJson(body) === canonicalAttemptJson(right);
    };
    const abort = (tx: IDBTransaction, reject: (cause: unknown) => void, cause: unknown) => {
        reject(cause); try {tx.abort();} catch { /* Preserve the first failure if the transaction already stopped. */ }
    };
    return {
        async snapshot() {
            const database = await open();
            try {return await new Promise<PaperReadingRecoveryRow[]>((resolve, reject) => {
                const tx = database.transaction('workspace-records', 'readonly'), store = tx.objectStore('workspace-records');
                const rows: PaperReadingRecoveryRow[] = []; let bytes = 0;
                const collect = (value: unknown) => {
                    current(); const received = row(value); rows.push(received);
                    bytes += new TextEncoder().encode(JSON.stringify(received)).byteLength;
                    if (rows.length > PAPER_READING_RECOVERY_MAX_RECORDS || bytes > PAPER_READING_RECOVERY_MAX_BYTES) throw Error('reading-recovery-limit');
                };
                for (const selector of selectors) {
                    if (selector.exact) {
                        const request = store.get(selector.exact);
                        request.onsuccess = () => {try {if (request.result !== undefined) collect(request.result);} catch (cause) {abort(tx, reject, cause);}};
                    } else {
                        const prefix = selector.prefix!, range = options.range ? options.range(prefix, prefix + '\uffff') : IDBKeyRange.bound(prefix, prefix + '\uffff');
                        const request = store.openCursor(range);
                        request.onsuccess = () => {
                            try {const cursor = request.result; if (cursor) {collect(cursor.value); cursor.continue();}}
                            catch (cause) {abort(tx, reject, cause);}
                        };
                    }
                }
                tx.oncomplete = () => {try {current(); resolve(rows.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));} catch (cause) {reject(cause);}};
                tx.onabort = tx.onerror = () => reject(tx.error ?? Error('reading-recovery-snapshot-failed'));
            });} finally {database.close();}
        },
        async inspect(rows) {
            for (const value of rows) identifyRecoveryRow(scope, value);
            const database = await open();
            try {return await new Promise((resolve, reject) => {
                const tx = database.transaction('workspace-records', 'readonly'), store = tx.objectStore('workspace-records');
                const result = {added: 0, duplicates: 0, conflicts: [] as string[]};
                for (const value of rows) {
                    const request = store.get(value.id);
                    request.onsuccess = () => {
                        if (request.result === undefined) result.added++;
                        else if (equal(request.result, value)) result.duplicates++;
                        else result.conflicts.push(value.id);
                    };
                }
                tx.oncomplete = () => {try {current(); resolve(result);} catch (cause) {reject(cause);}};
                tx.onabort = tx.onerror = () => reject(tx.error ?? Error('reading-recovery-preview-failed'));
            });} finally {database.close();}
        },
        async commit(rows) {
            current(); for (const value of rows) identifyRecoveryRow(scope, value);
            if (new Set(rows.map(value => value.id)).size !== rows.length) throw Error('reading-recovery-duplicate-record');
            const database = await open();
            try {return await new Promise((resolve, reject) => {
                const tx = database.transaction('workspace-records', 'readwrite'), store = tx.objectStore('workspace-records');
                const missing: PaperReadingRecoveryRow[] = []; let remaining = rows.length, duplicates = 0;
                const write = () => {
                    try {current(); for (const value of missing) store.put(value);} catch (cause) {abort(tx, reject, cause);}
                };
                for (const value of rows) {
                    const request = store.get(value.id);
                    request.onsuccess = () => {
                        try {
                            current();
                            if (request.result === undefined) missing.push(value);
                            else if (equal(request.result, value)) duplicates++;
                            else throw Error('reading-recovery-conflict:' + value.id);
                            if (--remaining === 0) write();
                        } catch (cause) {abort(tx, reject, cause);}
                    };
                }
                tx.oncomplete = () => resolve({added: missing.length, duplicates, durable: true});
                tx.onabort = tx.onerror = () => reject(tx.error ?? Error('reading-recovery-restore-aborted'));
            });} finally {database.close();}
        },
    };
}
