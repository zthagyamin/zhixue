import type { CourseEvidence, CourseEvidenceMutation, CourseEvidenceReceipt } from '../../domain/course-study';
import type { CourseEvidenceCloudPort, CourseEvidenceLocalOptions, CourseEvidenceLocalPort, CourseEvidenceScope } from '../../application/course-study';
// @ts-expect-error TS5097: standalone Node contracts.
import { parseCourseEvidenceMutation, applyCourseEvidenceMutation } from '../../domain/course-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { attemptId, canonicalAttemptJson } from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { courseEvidenceFingerprint } from './fingerprint.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { assertCourseScope, courseIdentity, validateCourseAggregate, validateCourseOriginal, validateCourseDiagnosis, validateCourseReceipt } from './validation.ts';

type Row = { key: string[]; scope: string[]; evidence: CourseEvidence; cloudRevision: number; status: 'device-only' | 'cloud-acked' | 'cloud-conflict' };
type Outbox = { key: string[]; scope: string[]; mutation: CourseEvidenceMutation; fingerprint: string };
function open(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') return Promise.reject(Error('course-evidence-local-unavailable'));
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('zhixue-course-evidence-v1', 1);
        request.onupgradeneeded = () => {
            for (const name of ['records', 'outbox']) {
                const store = request.result.createObjectStore(name, { keyPath: 'key' }); store.createIndex('scope', 'scope');
            }
        };
        request.onblocked = () => reject(Error('course-evidence-local-blocked'));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    });
}
function request<T>(value: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
}
function completion(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? Error('course-evidence-local-write-aborted')); tx.onerror = () => reject(tx.error); });
}
export function createLocalCourseEvidenceRepository(scope: CourseEvidenceScope, options: CourseEvidenceLocalOptions): CourseEvidenceLocalPort {
    attemptId(scope.userId); attemptId(scope.libraryId);
    const owner = [scope.userId, scope.libraryId], key = (id: string) => [...owner, attemptId(id)];
    const outboxKey = (id: string, operation: string) => [...key(id), attemptId(operation)];
    const original = { readAttempt: (_scope: CourseEvidenceScope, id: string) => options.readAttempt(id),
        readItem: (_scope: CourseEvidenceScope, binding: CourseEvidence['binding']) => options.readItem(binding),
        ...(options.readNativeCapture ? { readNativeCapture: (_scope: CourseEvidenceScope, binding: CourseEvidence['binding'], id: string) =>
            options.readNativeCapture!(binding, id) } : {}) };
    async function readRow(id: string): Promise<Row | null> {
        const db = await open();
        try { return (await request(db.transaction('records').objectStore('records').get(key(id)))) ?? null; }
        finally { db.close(); }
    }
    async function pending(): Promise<Outbox[]> {
        const db = await open();
        try { return await request(db.transaction('outbox').objectStore('outbox').index('scope').getAll(owner)); }
        finally { db.close(); }
    }
    const readEvidence = async (id: string) => (await readRow(id))?.evidence ?? null;
    async function trusted(raw: unknown): Promise<CourseEvidence> {
        const evidence = await validateCourseAggregate(scope, raw);
        if (options.cloud && evidence.binding.snapshotId === 'local') throw Error('course-native-account-evidence-forbidden');
        const context = await validateCourseOriginal(scope, evidence, original, readEvidence);
        await validateCourseDiagnosis(evidence, context);
        return evidence;
    }
    async function conflict(id: string): Promise<void> {
        const db = await open();
        try {
            const tx = db.transaction('records', 'readwrite'), done = completion(tx), store = tx.objectStore('records'), get = store.get(key(id));
            get.onsuccess = () => { if (get.result) store.put({ ...get.result, status: 'cloud-conflict' }); };
            await done;
        } finally { db.close(); }
    }
    async function mutate(raw: CourseEvidenceMutation): Promise<CourseEvidenceReceipt> {
        const mutation = parseCourseEvidenceMutation(raw); assertCourseScope(scope, mutation);
        if (options.cloud && mutation.binding.snapshotId === 'local') throw Error('course-native-account-evidence-forbidden');
        if (options.cloud && mutation.kind === 'diagnose' && mutation.diagnostic.source === 'model' && mutation.diagnostic.status !== 'undetermined')
            throw Error('course-model-server-evidence-required');
        const existing = await readEvidence(mutation.attemptId), identity = mutation.kind === 'bind' ? mutation : existing;
        if (!identity) throw Error('course-evidence-not-bound');
        const context = await validateCourseOriginal(scope, identity, original, readEvidence);
        if (mutation.kind === 'diagnose') await validateCourseDiagnosis(mutation, context);
        const fingerprint = await courseEvidenceFingerprint(mutation), db = await open();
        try {
            return await new Promise<CourseEvidenceReceipt>((resolve, reject) => {
                const tx = db.transaction(['records', 'outbox'], 'readwrite'), store = tx.objectStore('records'), get = store.get(key(mutation.attemptId));
                let result: CourseEvidenceReceipt;
                get.onsuccess = () => {
                    try {
                        const row = get.result as Row | undefined;
                        if (row && courseIdentity(row.evidence) !== courseIdentity(identity)) throw Error('course-evidence-identity-conflict');
                        result = applyCourseEvidenceMutation(row?.evidence ?? null, mutation, fingerprint);
                        if (result.status === 'accepted') {
                            store.put({ key: key(mutation.attemptId), scope: owner, evidence: result.evidence, cloudRevision: row?.cloudRevision ?? 0,
                                status: row?.status === 'cloud-conflict' ? 'cloud-conflict' : 'device-only' });
                            if (options.cloud) tx.objectStore('outbox').put({ key: outboxKey(mutation.attemptId, mutation.operationId), scope: owner, mutation, fingerprint });
                        }
                    } catch (error) { tx.abort(); reject(error); }
                };
                tx.oncomplete = () => {
                    const recorded = result.evidence?.operations.some(op => op.operationId === mutation.operationId && op.fingerprint === fingerprint);
                    resolve({ ...result, status: result.status === 'duplicate' && !recorded ? 'conflict' : result.status,
                        durable: result.status !== 'conflict' && Boolean(recorded) });
                };
                tx.onabort = () => reject(tx.error ?? Error('course-evidence-local-write-aborted'));
                tx.onerror = () => reject(tx.error);
            });
        } finally { db.close(); }
    }
    async function ack(queued: Outbox, receipt: CourseEvidenceReceipt): Promise<void> {
        const checked = await validateCourseReceipt(scope, receipt, queued.mutation);
        if (checked.status === 'conflict' || !checked.evidence) throw Error('course-cloud-receipt-invalid');
        const remote = await trusted(checked.evidence), db = await open();
        try {
            const tx = db.transaction(['records', 'outbox'], 'readwrite'), done = completion(tx), store = tx.objectStore('records'), outbox = tx.objectStore('outbox');
            const get = outbox.get(outboxKey(queued.mutation.attemptId, queued.mutation.operationId));
            get.onsuccess = () => {
                const currentQueue = get.result as Outbox | undefined;
                if (!currentQueue || currentQueue.fingerprint !== queued.fingerprint || canonicalAttemptJson(currentQueue.mutation) !== canonicalAttemptJson(queued.mutation)) return;
                const current = store.get(key(remote.attemptId));
                current.onsuccess = () => {
                    const local = current.result as Row | undefined;
                    if (!local || courseIdentity(local.evidence) !== courseIdentity(remote)) { tx.abort(); return; }
                    outbox.delete(currentQueue.key);
                    const remaining = outbox.index('scope').getAll(owner);
                    remaining.onsuccess = () => {
                        const any = (remaining.result as Outbox[]).some(row => row.mutation.attemptId === remote.attemptId);
                        store.put({ ...local, cloudRevision: Math.max(local.cloudRevision, remote.revision), evidence: any ? local.evidence : remote,
                            status: any ? local.status : 'cloud-acked' });
                    };
                };
            };
            await done;
        } finally { db.close(); }
    }
    async function rebase(queued: Outbox, remote: CourseEvidence | null): Promise<Outbox | null> {
        if (!remote || remote.operations.some(op => op.operationId === queued.mutation.operationId) || queued.mutation.updatedAt < remote.updatedAt) return null;
        remote = await trusted(remote);
        const local = await readEvidence(queued.mutation.attemptId), mutation = queued.mutation;
        if (!local || courseIdentity(local) !== courseIdentity(remote)) return null;
        if (mutation.kind === 'bind') {
            if (courseIdentity(mutation) !== courseIdentity(remote)) return null;
        } else if (remote.answerRevision !== null && remote.answerRevision !== mutation.answerRevision
            || remote.diagnostic && remote.diagnostic.status !== 'undetermined' && (remote.diagnosticHash !== mutation.diagnosticHash
                || remote.attemptEvaluationHash !== mutation.attemptEvaluationHash)) return null;
        const nextMutation = { ...mutation, expectedRevision: remote.revision }, fingerprint = await courseEvidenceFingerprint(nextMutation);
        const next = { ...queued, mutation: nextMutation, fingerprint }, db = await open();
        let applied = false;
        try {
            const tx = db.transaction(['records', 'outbox'], 'readwrite'), done = completion(tx), outbox = tx.objectStore('outbox'), get = outbox.get(queued.key);
            get.onsuccess = () => {
                const current = get.result as Outbox | undefined;
                if (!current || current.fingerprint !== queued.fingerprint || canonicalAttemptJson(current.mutation) !== canonicalAttemptJson(queued.mutation)) return;
                const record = tx.objectStore('records').get(key(mutation.attemptId));
                record.onsuccess = () => {
                    const row = record.result as Row | undefined;
                    if (!row || courseIdentity(row.evidence) !== courseIdentity(remote!)) return;
                    outbox.put(next);
                    const evidence = structuredClone(row.evidence), operation = evidence.operations.find(op => op.operationId === mutation.operationId);
                    if (operation) operation.fingerprint = fingerprint;
                    tx.objectStore('records').put({ ...row, evidence }); applied = true;
                };
            };
            await done;
        } finally { db.close(); }
        return applied ? next : null;
    }
    async function hydrate(raw: CourseEvidence): Promise<void> {
        if (!options.cloud) throw Error('course-native-cloud-hydration-forbidden');
        const remote = await trusted(raw), db = await open();
        try {
            const tx = db.transaction(['records', 'outbox'], 'readwrite'), done = completion(tx), store = tx.objectStore('records'), get = store.get(key(remote.attemptId));
            get.onsuccess = () => {
                const row = get.result as Row | undefined;
                if (row && courseIdentity(row.evidence) !== courseIdentity(remote)) { tx.abort(); return; }
                const queue = tx.objectStore('outbox').index('scope').getAll(owner);
                queue.onsuccess = () => {
                    if ((queue.result as Outbox[]).some(op => op.mutation.attemptId === remote.attemptId) || row?.status === 'cloud-conflict'
                        || row && row.evidence.revision > remote.revision) return;
                    if (row && row.evidence.revision === remote.revision && canonicalAttemptJson(row.evidence) !== canonicalAttemptJson(remote)) { tx.abort(); return; }
                    store.put({ key: key(remote.attemptId), scope: owner, evidence: remote, cloudRevision: remote.revision, status: 'cloud-acked' });
                };
            };
            await done;
        } finally { db.close(); }
    }
    async function synchronize(cloud: CourseEvidenceCloudPort): Promise<void> {
        if (!options.cloud) return;
        const attempted = new Set<string>(), blocked = new Set<string>();
        for (;;) {
            const rows = (await pending()).filter(row => !attempted.has(JSON.stringify(row.key)) && !blocked.has(row.mutation.attemptId));
            if (!rows.length) return;
            rows.sort((a, b) => a.mutation.expectedRevision - b.mutation.expectedRevision);
            // A child's fixed parent diagnostic must be acknowledged first.
            const eligible: Outbox[] = [];
            for (const row of rows) {
                const parent = (await readEvidence(row.mutation.attemptId))?.parentAttemptId;
                if (!parent || !(await pending()).some(other => other.mutation.attemptId === parent)) eligible.push(row);
            }
            if (!eligible.length) return;
            for (const queued of eligible) {
                if (blocked.has(queued.mutation.attemptId)) continue;
                attempted.add(JSON.stringify(queued.key));
                try {
                    let sent = queued, receipt = await validateCourseReceipt(scope, await cloud.mutate(sent.mutation), sent.mutation);
                    if (receipt.status === 'conflict') {
                        const rebased = await rebase(sent, receipt.evidence);
                        if (rebased) { sent = rebased; receipt = await validateCourseReceipt(scope, await cloud.mutate(sent.mutation), sent.mutation); }
                    }
                    if (receipt.status === 'conflict') { await conflict(sent.mutation.attemptId); blocked.add(sent.mutation.attemptId); }
                    else await ack(sent, receipt);
                } catch (error) {
                    if (error instanceof Error && error.message === 'course-evidence-unsupported') return;
                    const semantic = error instanceof Error && ((error as Error & { status?: number }).status === 409 || error.message.startsWith('course-cloud-receipt'));
                    if (semantic) await conflict(queued.mutation.attemptId);
                    blocked.add(queued.mutation.attemptId);
                }
            }
        }
    }
    return { read: readEvidence, mutate, pending, status: async id => (await readRow(id))?.status ?? null, synchronize, hydrate };
}
