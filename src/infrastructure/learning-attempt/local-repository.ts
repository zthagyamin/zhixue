import type { AttemptMutation, AttemptReceipt, LearningAttempt } from '../../domain/learning-attempt';
import type { AttemptCloudPort, AttemptScope, LocalAttemptOptions } from '../../application/learning-attempt';
// @ts-expect-error TS5097: standalone Node contracts.
import { applyAttemptMutation, parseAttemptMutation, attemptId, canonicalAttemptJson } from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { attemptFingerprint, evaluationFingerprint } from './fingerprint.ts';
type Row = {
    key: string[];
    scope: string[];
    attempt: LearningAttempt;
    cloudRevision: number;
    status: 'device-only' | 'cloud-acked' | 'cloud-conflict';
};
type Outbox = {
    key: string[];
    scope: string[];
    mutation: AttemptMutation;
    fingerprint: string;
};
function open(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined')
        return Promise.reject(new Error('learning-attempt-local-unavailable'));
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('zhixue-learning-attempts-v1', 1);
        request.onupgradeneeded = () => {
            for (const name of ['attempts', 'outbox', 'references']) {
                const store = request.result.createObjectStore(name, { keyPath: 'key' });
                store.createIndex('scope', 'scope');
            }
        };
        request.onblocked = () => reject(new Error('learning-attempt-local-blocked'));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
}
function request<T>(value: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); }); }
function completion(tx: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? new Error('attempt-local-write-aborted')); tx.onerror = () => reject(tx.error); }); }
export function createLocalAttemptRepository(scope: AttemptScope, options: LocalAttemptOptions = {}) {
    attemptId(scope.userId);
    attemptId(scope.libraryId);
    const owner = [scope.userId, scope.libraryId], key = (id: string) => [...owner, attemptId(id)];
    const outboxKey = (id: string, operation: string) => [...key(id), attemptId(operation)];
    async function readRow(id: string): Promise<Row | null> {
        const db = await open();
        try {
            return (await request(db.transaction('attempts').objectStore('attempts').get(key(id)))) ?? null;
        }
        finally {
            db.close();
        }
    }
    async function pending(): Promise<Outbox[]> {
        const db = await open();
        try {
            return await request(db.transaction('outbox').objectStore('outbox').index('scope').getAll(owner));
        }
        finally {
            db.close();
        }
    }
    async function conflict(id: string): Promise<void> {
        const db = await open();
        try {
            const tx = db.transaction('attempts', 'readwrite'), done = completion(tx), get = tx.objectStore('attempts').get(key(id));
            get.onsuccess = () => {
                const local = get.result as Row;
                if (local)
                    tx.objectStore('attempts').put({ ...local, status: 'cloud-conflict' });
            };
            await done;
        }
        finally {
            db.close();
        }
    }
    async function mutate(raw: AttemptMutation): Promise<AttemptReceipt> {
        const mutation = parseAttemptMutation(raw), fingerprint = await attemptFingerprint(mutation);
        if (mutation.binding.ownerId !== scope.userId || mutation.binding.libraryId !== scope.libraryId)
            throw new Error('attempt-scope-mismatch');
        if (mutation.kind === 'evaluate' && mutation.evaluation.status === 'resolved' && mutation.evaluation.evaluationHash !== await evaluationFingerprint(mutation.evaluation))
            throw new Error('attempt-evaluation-hash-conflict');
        if (mutation.kind === 'checkpoint' && mutation.parentAttemptId) {
            const parent = (await readRow(mutation.parentAttemptId))?.attempt, b = mutation.binding;
            if (!parent?.submitted || parent.binding.itemKey !== b.itemKey || parent.binding.contentHash !== b.contentHash || parent.binding.groupId !== b.groupId || parent.binding.roundId !== b.roundId)
                throw new Error('attempt-parent-binding');
        }
        let authoritativeRecord: {
            attemptId: string;
            roundId: string;
        } | null = null;
        if (mutation.kind === 'link-formal') {
            const current = await readRow(mutation.attemptId), event = await options.verifyFormalEvent?.(mutation.eventId), b = mutation.binding, formal = current?.attempt.formal;
            if (!event || !formal || event.eventId !== mutation.eventId || event.coreHash !== mutation.coreHash || event.itemKey !== b.itemKey || event.contentHash !== b.contentHash || (event.snapshotId !== undefined && event.snapshotId !== b.snapshotId) || event.reviewedAt !== formal.occurredAt || event.rating !== formal.rating)
                throw new Error('attempt-local-formal-not-durable');
            authoritativeRecord = event.authoritativeRecord ?? null;
        }
        const db = await open();
        try {
            return await new Promise<AttemptReceipt>((resolve, reject) => {
                const tx = db.transaction(['attempts', 'outbox'], 'readwrite'), store = tx.objectStore('attempts');
                let result: AttemptReceipt;
                const get = store.get(key(mutation.attemptId));
                get.onsuccess = () => {
                    try {
                        const row = get.result as Row | undefined;
                        result = applyAttemptMutation(row?.attempt ?? null, mutation, fingerprint);
                        if (result.status === 'accepted' && mutation.kind === 'link-formal')
                            result.attempt!.formal!.authoritativeRecord = authoritativeRecord;
                        if (result.status === 'accepted') {
                            // Local edits cannot reconcile an already observed server conflict.
                            // Only the existing verified acknowledgment/hydration path may clear it.
                            const save = () => {
                                store.put({ key: key(mutation.attemptId), scope: owner, attempt: result.attempt, cloudRevision: row?.cloudRevision ?? 0, status: row?.status === 'cloud-conflict' ? 'cloud-conflict' : 'device-only' });
                                tx.objectStore('outbox').put({ key: outboxKey(mutation.attemptId, mutation.operationId), scope: owner, mutation, fingerprint });
                            };
                            if (mutation.kind === 'claim-formal') {
                                const claims = store.index('scope').getAll(owner);
                                claims.onsuccess = () => {
                                    const b = mutation.binding, clash = (claims.result as Row[]).some(other => {
                                        const a = other.attempt, bound = a.binding;
                                        return a.attemptId !== mutation.attemptId && a.formal && (a.formal.eventId === mutation.eventId || (bound.groupId === b.groupId && bound.roundId === b.roundId && bound.itemKey === b.itemKey && bound.contentHash === b.contentHash));
                                    });
                                    if (clash) {
                                        tx.abort();
                                        reject(new Error('attempt-formal-event-conflict'));
                                    }
                                    else
                                        save();
                                };
                            }
                            else
                                save();
                        }
                    }
                    catch (error) {
                        tx.abort();
                        reject(error);
                    }
                };
                tx.oncomplete = () => resolve({ ...result, durable: result.status !== 'conflict' });
                tx.onabort = () => reject(tx.error ?? new Error('attempt-local-write-aborted'));
                tx.onerror = () => reject(tx.error);
            });
        }
        finally {
            db.close();
        }
    }
    async function ack(operationId: string, receipt: AttemptReceipt): Promise<void> {
        if (!receipt.durable || receipt.status === 'conflict' || receipt.operationId !== operationId || !receipt.attempt)
            throw new Error('attempt-cloud-receipt-invalid');
        const db = await open();
        try {
            const tx = db.transaction(['attempts', 'outbox'], 'readwrite'), done = completion(tx);
            const outbox = tx.objectStore('outbox'), get = outbox.get(outboxKey(receipt.attempt.attemptId, operationId));
            get.onsuccess = () => {
                try {
                    const queued = get.result as Outbox | undefined;
                    if (!queued)
                        return;
                    const remote = receipt.attempt!, b = remote.binding;
                    if (b.ownerId !== scope.userId || b.libraryId !== scope.libraryId || remote.attemptId !== queued.mutation.attemptId || canonicalAttemptJson(b) !== canonicalAttemptJson(queued.mutation.binding) || !remote.operations.some(op => op.operationId === operationId && op.fingerprint === queued.fingerprint))
                        throw new Error('attempt-cloud-receipt-binding');
                    outbox.delete(outboxKey(remote.attemptId, operationId));
                    const current = tx.objectStore('attempts').get(key(remote.attemptId));
                    current.onsuccess = () => {
                        const local = current.result as Row;
                        if (!local)
                            return;
                        local.cloudRevision = remote.revision;
                        const remaining = outbox.index('scope').getAll(owner);
                        remaining.onsuccess = () => {
                            if (!(remaining.result as Outbox[]).some(row => row.mutation.attemptId === remote.attemptId)) {
                                local.attempt = remote;
                                local.status = 'cloud-acked';
                            }
                            tx.objectStore('attempts').put(local);
                        };
                    };
                }
                catch {
                    tx.abort();
                }
            };
            await done;
        }
        finally {
            db.close();
        }
    }
    return {
        read: async (id: string) => (await readRow(id))?.attempt ?? null,
        status: async (id: string) => (await readRow(id))?.status ?? null,
        async list(): Promise<LearningAttempt[]> {
            const db = await open();
            try {
                const rows: Row[] = await request(db.transaction('attempts').objectStore('attempts').index('scope').getAll(owner));
                return rows.map(row => row.attempt);
            }
            finally {
                db.close();
            }
        },
        mutate, pending, ack,
        async refresh(cloud: AttemptCloudPort): Promise<{
            restored: number;
            preserved: number;
        }> {
            const remotes = await cloud.list();
            let restored = 0, preserved = 0;
            for (const remote of remotes) {
                if (await this.hydrate(remote))
                    restored++;
                else
                    preserved++;
            }
            return { restored, preserved };
        },
        async hydrate(remote: LearningAttempt): Promise<boolean> {
            if (remote.schemaVersion !== 1 || remote.binding.ownerId !== scope.userId || remote.binding.libraryId !== scope.libraryId)
                throw new Error('attempt-scope-mismatch');
            const db = await open();
            try {
                return await new Promise<boolean>((resolve, reject) => {
                    const tx = db.transaction(['attempts', 'outbox'], 'readwrite'), get = tx.objectStore('attempts').get(key(remote.attemptId));
                    let accepted = false;
                    get.onsuccess = () => {
                        const local = get.result as Row | undefined;
                        if (local && canonicalAttemptJson(local.attempt.binding) !== canonicalAttemptJson(remote.binding)) {
                            tx.abort();
                            reject(new Error('attempt-binding-conflict'));
                            return;
                        }
                        const queue = tx.objectStore('outbox').index('scope').getAll(owner);
                        queue.onsuccess = () => {
                            if ((queue.result as Outbox[]).some(row => row.mutation.attemptId === remote.attemptId))
                                return;
                            if (local && local.attempt.revision > remote.revision)
                                return;
                            tx.objectStore('attempts').put({ key: key(remote.attemptId), scope: owner, attempt: remote, cloudRevision: remote.revision, status: 'cloud-acked' });
                            accepted = true;
                        };
                    };
                    tx.oncomplete = () => resolve(accepted);
                    tx.onabort = () => reject(tx.error ?? new Error('attempt-local-write-aborted'));
                    tx.onerror = () => reject(tx.error);
                });
            }
            finally {
                db.close();
            }
        },
        async rememberReference(id: string, item: {
            itemKey: string;
            contentHash: string;
        }): Promise<void> {
            const current = await readRow(id);
            if (!current || current.attempt.binding.itemKey !== item.itemKey || current.attempt.binding.contentHash !== item.contentHash)
                throw new Error('attempt-reference-conflict');
            const db = await open();
            try {
                const tx = db.transaction('references', 'readwrite'), done = completion(tx), store = tx.objectStore('references'), get = store.get(key(id));
                get.onsuccess = () => {
                    if (get.result && JSON.stringify(get.result.item) !== JSON.stringify(item)) {
                        tx.abort();
                        return;
                    }
                    store.put({ key: key(id), scope: owner, item });
                };
                await done;
            }
            finally {
                db.close();
            }
        },
        async reference(id: string): Promise<unknown | null> {
            const db = await open();
            try {
                const row = await request(db.transaction('references').objectStore('references').get(key(id)));
                return row?.item ?? null;
            }
            finally {
                db.close();
            }
        },
        async sync(cloud: AttemptCloudPort): Promise<{
            acked: number;
            pending: number;
            conflict: boolean;
            complete?: boolean;
            unsupported?: boolean;
        }> {
            let acked = 0, hasConflict = false;
            const attempted = new Set<string>(), blocked = new Map<string, boolean>();
            const operationKey = (row: Outbox) => JSON.stringify([row.mutation.attemptId, row.mutation.operationId]);
            const result = async (unsupported = false) => {
                const count = (await pending()).length;
                return { acked, pending: count, conflict: hasConflict, complete: count === 0, ...(unsupported ? { unsupported: true } : {}) };
            };
            // Each pass includes newly queued work; failed groups are retried only by
            // a later sync call. A child's revision zero depends on its parent's submit.
            for (;;) {
                const groups = new Map<string, Outbox[]>();
                for (const row of await pending()) {
                    if (attempted.has(operationKey(row)) || blocked.has(row.mutation.attemptId))
                        continue;
                    const rows = groups.get(row.mutation.attemptId) ?? [];
                    rows.push(row);
                    groups.set(row.mutation.attemptId, rows);
                }
                if (!groups.size)
                    return result();
                const parents = new Map<string, string | null>();
                for (const [id, rows] of groups) {
                    rows.sort((a, b) => a.mutation.expectedRevision - b.mutation.expectedRevision);
                    parents.set(id, (await readRow(id))?.attempt.parentAttemptId ?? null);
                }
                const ordered: string[] = [], visiting = new Set<string>(), visited = new Set<string>(), invalid = new Set<string>();
                const visit = (id: string): boolean => {
                    if (visited.has(id))
                        return !invalid.has(id);
                    if (visiting.has(id)) {
                        invalid.add(id);
                        return false;
                    }
                    visiting.add(id);
                    const parent = parents.get(id);
                    if (parent && groups.has(parent) && !visit(parent))
                        invalid.add(id);
                    visiting.delete(id);
                    visited.add(id);
                    ordered.push(id);
                    return !invalid.has(id);
                };
                for (const id of groups.keys())
                    visit(id);
                for (const id of ordered) {
                    const parentId = parents.get(id), parent = parentId ? await readRow(parentId) : null;
                    if (invalid.has(id) || (parentId && (blocked.has(parentId) || parent?.status === 'cloud-conflict'))) {
                        const isConflict = invalid.has(id) || Boolean(parentId && (blocked.get(parentId) || parent?.status === 'cloud-conflict'));
                        blocked.set(id, isConflict);
                        if (isConflict) {
                            hasConflict = true;
                            await conflict(id);
                        }
                        continue;
                    }
                    for (const row of groups.get(id)!) {
                        attempted.add(operationKey(row));
                        let receipt: AttemptReceipt;
                        try {
                            receipt = await cloud.mutate(row.mutation);
                        }
                        catch (error) {
                            if (error instanceof Error && error.message === 'learning-attempts-unsupported')
                                return result(true);
                            const semanticConflict = error instanceof Error && (error as Error & {
                                status?: number;
                            }).status === 409 && error.message !== 'attempt-formal-not-durable';
                            blocked.set(id, semanticConflict);
                            if (semanticConflict) {
                                hasConflict = true;
                                await conflict(id);
                            }
                            break;
                        }
                        if (receipt.status === 'conflict') {
                            blocked.set(id, true);
                            hasConflict = true;
                            await conflict(id);
                            break;
                        }
                        try {
                            await ack(row.mutation.operationId, receipt);
                        }
                        catch (error) {
                            if (!(error instanceof Error) || !error.message.startsWith('attempt-cloud-receipt'))
                                throw error;
                            blocked.set(id, true);
                            hasConflict = true;
                            await conflict(id);
                            break;
                        }
                        acked++;
                    }
                }
            }
        },
    };
}
