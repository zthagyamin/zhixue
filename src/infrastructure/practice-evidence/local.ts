// @ts-expect-error TS5097: standalone Node contracts.
import { applyPracticeEvidenceMutation, parsePracticeEvidence, parsePracticeEvidenceMutation, practiceEvidenceFingerprint, evidenceEqual, validatePracticeEvidenceAuthority, validatePracticeEvidenceTree } from '../../domain/practice-evidence/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { resolvePracticeEvidenceAuthority } from '../../application/practice-evidence/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { attemptId } from '../../domain/learning-attempt/index.ts';
import type { PracticeEvidenceMutationV1, PracticeEvidenceReceipt, PracticeEvidenceV1 } from '../../domain/practice-evidence';
import type { PracticeEvidenceAttemptPort, PracticeEvidenceCloudPort, PracticeEvidenceCloudResponse, PracticeEvidenceOutbox, PracticeEvidenceScope, PracticeEvidenceServiceWritePort, PracticeEvidenceSyncState } from '../../application/practice-evidence';
export type SavedStepDraftProjection = Readonly<{record:PracticeEvidenceV1;diagnosticInvalid:boolean}>;

type Row = {
    key: string[];
    scope: string[];
    record: PracticeEvidenceV1;
    status: PracticeEvidenceSyncState;
    cloudRevision: number;
    /** Local receipt proving when immutable first execution evidence entered this history. */
    firstReportOperation?: PracticeEvidenceV1['operations'][number];
};
export type LocalPracticeEvidenceOptions = {
    service?: PracticeEvidenceServiceWritePort;
    beforeCommit?: (transaction: IDBTransaction) => void;
};
function open(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined')
        return Promise.reject(Error('practice-evidence-local-unavailable'));
    return new Promise((resolve, reject) => {
        const r = indexedDB.open('zhixue-practice-evidence-v1', 1);
        r.onupgradeneeded = () => { for (const name of ['records', 'outbox']) {
            const s = r.result.createObjectStore(name, { keyPath: 'key' });
            s.createIndex('scope', 'scope');
        } };
        r.onerror = () => reject(r.error);
        r.onblocked = () => reject(Error('practice-evidence-local-blocked'));
        r.onsuccess = () => { r.result.onversionchange = () => r.result.close(); resolve(r.result); };
    });
}
function request<T>(r: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
function completion(tx: IDBTransaction): Promise<void> { return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error ?? Error('practice-evidence-local-write-aborted')); }); }
function extendsHistory(local: PracticeEvidenceV1, remote: PracticeEvidenceV1): boolean {
    if (remote.revision < local.revision || !evidenceEqual(local.binding, remote.binding))
        return false;
    return local.operations.every((op, i) => evidenceEqual(op, remote.operations[i]))
        && (!local.execution?.first || evidenceEqual(local.execution.first, remote.execution?.first))
        && (!local.execution?.first || evidenceEqual(local.execution.firstOutput, remote.execution?.firstOutput))
        && (!local.variant || evidenceEqual(local.variant, remote.variant));
}
function firstReportIntroduction(row: Row, pendingHistory: PracticeEvidenceOutbox[]): PracticeEvidenceV1['operations'][number] | undefined {
    const first = row.record.execution?.first;
    if (row.firstReportOperation) {
        const operation = row.record.operations[row.firstReportOperation.revision - 1];
        if (!first || !evidenceEqual(operation, row.firstReportOperation))
            throw Error('practice-evidence-cloud-receipt-first-history');
        return operation;
    }
    if (!first)
        return undefined;
    // Earlier development rows have no private introduction receipt. Only a complete,
    // fingerprint-validated history from revision zero can establish the first report.
    // A later repeated identical report is not proof that an earlier prefix lacked it.
    const history = pendingHistory.filter(entry => entry.mutation.attemptId === row.record.attemptId)
        .sort((a, b) => a.mutation.expectedRevision - b.mutation.expectedRevision);
    if (history.length !== row.record.operations.length || !history.every((entry, index) =>
        entry.mutation.expectedRevision === index && evidenceEqual(row.record.operations[index], {
            operationId: entry.mutation.operationId, fingerprint: entry.fingerprint, revision: index + 1
        })))
        return undefined;
    const introduction = history.find(entry => entry.mutation.kind === 'code-report');
    if (!introduction || introduction.mutation.kind !== 'code-report'
        || !evidenceEqual(introduction.mutation.report, first)
        || !evidenceEqual(introduction.mutation.output, row.record.execution?.firstOutput))
        throw Error('practice-evidence-cloud-receipt-first-history');
    return row.record.operations[introduction.mutation.expectedRevision];
}
function compatibleFirstEvidence(row: Row, remote: PracticeEvidenceV1, introduction: PracticeEvidenceV1['operations'][number] | undefined): boolean {
    if (!row.record.execution?.first)
        return true;
    if (introduction && remote.revision < introduction.revision)
        return remote.execution?.first === undefined && remote.execution?.firstOutput === undefined;
    return evidenceEqual(row.record.execution.first, remote.execution?.first)
        && evidenceEqual(row.record.execution.firstOutput, remote.execution?.firstOutput);
}
export function createLocalPracticeEvidenceRepository(scope: PracticeEvidenceScope, attempts: PracticeEvidenceAttemptPort, options: LocalPracticeEvidenceOptions = {}) {
    attemptId(scope.ownerId);
    attemptId(scope.libraryId);
    const owner = [scope.ownerId, scope.libraryId], key = (id: string) => [...owner, attemptId(id)];
    async function readRow(id: string): Promise<Row | null> {
        const db = await open();
        try {
            const tx = db.transaction('records'), done = completion(tx), row = await request(tx.objectStore('records').get(key(id)));
            await done;
            return row ?? null;
        }
        finally {
            db.close();
        }
    }
    async function validate(raw: unknown): Promise<PracticeEvidenceV1> {
        const r = parsePracticeEvidence(raw), authority = await resolvePracticeEvidenceAuthority(scope, attempts, r);
        await validatePracticeEvidenceAuthority(r, authority);
        return r;
    }
    async function read(id: string): Promise<PracticeEvidenceV1 | null> {
        const row = await readRow(id);
        return row ? validate(row.record) : null;
    }
    async function savedDrafts(allowInvalidDiagnostic:boolean):Promise<SavedStepDraftProjection[]> {
        const db = await open();
        let rows: Row[];
        try {
            const tx = db.transaction('records'), done = completion(tx);
            rows = await request(tx.objectStore('records').index('scope').getAll(owner));
            await done;
        } finally { db.close(); }
        const saved:SavedStepDraftProjection[]=[];
        for(const row of rows){
            try{
                validatePracticeEvidenceTree(row);
                if(Object.keys(row).some(field=>!['key','scope','record','status','cloudRevision','firstReportOperation'].includes(field))
                    || !['device-only','cloud-acked','cloud-conflict','cloud-unsupported','cloud-incompatible'].includes(row.status)
                    || !Number.isSafeInteger(row.cloudRevision)||row.cloudRevision<0)continue;
                let record:PracticeEvidenceV1,diagnosticInvalid=false;
                try{record=parsePracticeEvidence(row.record);}
                catch{
                    if(!allowInvalidDiagnostic||!row.record?.calculation||!Object.hasOwn(row.record.calculation,'diagnostic'))continue;
                    // This clone is a display projection only. Every other field must still parse.
                    const projection=structuredClone(row.record);delete projection.calculation!.diagnostic;
                    record=parsePracticeEvidence(projection);diagnosticInvalid=true;
                }
                if(!evidenceEqual(row.scope,owner)||!evidenceEqual(row.key,key(record.attemptId))
                    ||record.binding.ownerId!==scope.ownerId||record.binding.libraryId!==scope.libraryId)continue;
                const original=await attempts.readAttempt(record.attemptId);
                if(!original||original.schemaVersion!==1||original.attemptId!==record.attemptId
                    ||!evidenceEqual(original.binding,record.binding))continue;
                saved.push({record:structuredClone(record),diagnosticInvalid});
            }catch{/* Corrupt or foreign rows never become a projection or model authority. */}
        }
        return saved;
    }
    async function pending(): Promise<PracticeEvidenceOutbox[]> {
        const db = await open();
        try {
            const tx = db.transaction('outbox'), done = completion(tx), rows = await request(tx.objectStore('outbox').index('scope').getAll(owner));
            await done;
            for (const row of rows as PracticeEvidenceOutbox[]) {
                validatePracticeEvidenceTree(row);
                if (Object.keys(row).sort().join(',') !== 'fingerprint,key,mutation,scope'
                    || !evidenceEqual(row.scope,owner) || !evidenceEqual(row.key,[...key(row.mutation.attemptId),row.mutation.operationId]))
                    throw Error('practice-evidence-outbox-scope');
                const mutation=parsePracticeEvidenceMutation(row.mutation);
                if (mutation.binding.ownerId!==scope.ownerId || mutation.binding.libraryId!==scope.libraryId || row.fingerprint!==await practiceEvidenceFingerprint(mutation))
                    throw Error('practice-evidence-outbox-fingerprint');
            }
            return rows;
        }
        finally {
            db.close();
        }
    }
    async function mark(id: string, status: PracticeEvidenceSyncState): Promise<void> {
        const db = await open();
        try {
            const tx = db.transaction('records', 'readwrite'), done = completion(tx), s = tx.objectStore('records'), get = s.get(key(id));
            get.onsuccess = () => { if (get.result)
                s.put({ ...get.result, status }); };
            await done;
        }
        finally {
            db.close();
        }
    }
    async function mutate(raw: PracticeEvidenceMutationV1): Promise<PracticeEvidenceReceipt> {
        const m = parsePracticeEvidenceMutation(raw), fingerprint = await practiceEvidenceFingerprint(m), current = await read(m.attemptId);
        const known = current?.operations.find(o => o.operationId === m.operationId);
        if (known)
            return { status: known.fingerprint === fingerprint ? 'duplicate' : 'conflict', durable: known.fingerprint === fingerprint, operationId: m.operationId, revision: current!.revision, record: current };
        const authority = await resolvePracticeEvidenceAuthority(scope, attempts, m, options.service, current);
        const result = await applyPracticeEvidenceMutation(current, m, authority);
        if (result.status !== 'accepted')
            return result;
        const db = await open();
        try {
            const tx = db.transaction(['records', 'outbox'], 'readwrite'), done = completion(tx), store = tx.objectStore('records'), get = store.get(key(m.attemptId));
            let actual = result;
            get.onsuccess = () => {
                const latest = (get.result as Row | undefined)?.record ?? null;
                if (!evidenceEqual(latest, current)) {
                    const old = latest?.operations.find(o => o.operationId === m.operationId);
                    const status = old?.fingerprint === fingerprint ? 'duplicate' : 'conflict';
                    actual = { status, durable: false, operationId: m.operationId, revision: latest?.revision ?? 0, record: latest };
                    return;
                }
                const existing = get.result as Row | undefined;
                const firstReportOperation = !current?.execution?.first && result.record?.execution?.first
                    ? result.record.operations[result.record.revision - 1] : existing?.firstReportOperation;
                store.put({ key: key(m.attemptId), scope: owner, record: result.record, status: 'device-only', cloudRevision: existing?.cloudRevision ?? 0,
                    ...(firstReportOperation ? {firstReportOperation} : {}) });
                tx.objectStore('outbox').put({ key: [...key(m.attemptId), m.operationId], scope: owner, mutation: m, fingerprint });
                try {
                    options.beforeCommit?.(tx);
                }
                catch {
                    tx.abort();
                }
            };
            await done;
            return { ...actual, durable: actual.status !== 'conflict' };
        }
        finally {
            db.close();
        }
    }
    async function hydrate(raw: unknown): Promise<boolean> {
        const remote = await validate(raw), original = await attempts.readAttempt(remote.attemptId), db = await open();
        try {
            const tx = db.transaction(['records', 'outbox'], 'readwrite'), done = completion(tx), store = tx.objectStore('records'), get = store.get(key(remote.attemptId));
            let accepted = false;
            get.onsuccess = () => {
                const local = get.result as Row | undefined, queue = tx.objectStore('outbox').index('scope').getAll(owner);
                queue.onsuccess = () => {
                    if ((queue.result as PracticeEvidenceOutbox[]).some(r => r.mutation.attemptId === remote.attemptId))
                        return;
                    if (local && !extendsHistory(local.record, remote)) {
                        store.put({ ...local, status: 'cloud-conflict' });
                        return;
                    }
                    if (local && (original?.submitted && local.record.calculation && !evidenceEqual(local.record.calculation.stepInput, remote.calculation?.stepInput)
                        || original?.formal && local.record.execution?.latest && (!evidenceEqual(local.record.execution.latest, remote.execution?.latest)
                            || !evidenceEqual(local.record.execution.latestOutput, remote.execution?.latestOutput))
                        || local.record.calculation?.diagnostic?.status !== 'undetermined' && local.record.calculation?.diagnostic && !evidenceEqual(local.record.calculation.diagnostic, remote.calculation?.diagnostic))) {
                        store.put({ ...local, status: 'cloud-conflict' });
                        return;
                    }
                    if (local && local.record.revision === remote.revision && !evidenceEqual(local.record, remote)) {
                        store.put({ ...local, status: 'cloud-conflict' });
                        return;
                    }
                    store.put({ key: key(remote.attemptId), scope: owner, record: remote, status: 'cloud-acked', cloudRevision: remote.revision,
                        ...(local?.firstReportOperation ? {firstReportOperation: local.firstReportOperation} : {}) });
                    accepted = true;
                };
            };
            await done;
            return accepted;
        }
        finally {
            db.close();
        }
    }
    async function ack(outbox: PracticeEvidenceOutbox, receipt: PracticeEvidenceReceipt): Promise<void> {
        if (!['accepted', 'duplicate'].includes(receipt.status) || !receipt.durable || receipt.operationId !== outbox.mutation.operationId || !receipt.record || receipt.revision !== receipt.record.revision)
            throw Error('practice-evidence-cloud-receipt');
        const remote = await validate(receipt.record), op = remote.operations.find(o => o.operationId === outbox.mutation.operationId);
        if (!op || op.fingerprint !== outbox.fingerprint || remote.attemptId !== outbox.mutation.attemptId || !evidenceEqual(remote.binding, outbox.mutation.binding))
            throw Error('practice-evidence-cloud-receipt-identity');
        const pendingHistory = await pending();
        const db = await open();
        try {
            const tx = db.transaction(['records', 'outbox'], 'readwrite'), done = completion(tx), s = tx.objectStore('records'), get = s.get(key(remote.attemptId));
            let invalid = false;
            get.onsuccess = () => {
                const row = get.result as Row | undefined;
                let introduction: PracticeEvidenceV1['operations'][number] | undefined;
                try {
                    if (row)
                        introduction = firstReportIntroduction(row, pendingHistory);
                } catch {
                    invalid = true;
                    tx.abort();
                    return;
                }
                if (!row || !row.record.operations.some(o => o.operationId === op.operationId && o.fingerprint === op.fingerprint)
                    || row.record.operations.some((o, i) => i < remote.operations.length && !evidenceEqual(o, remote.operations[i]))
                    || !compatibleFirstEvidence(row, remote, introduction)) {
                    invalid = true;
                    tx.abort();
                    return;
                }
                const queue = tx.objectStore('outbox').get(outbox.key);
                queue.onsuccess = () => {
                    if (!queue.result || queue.result.fingerprint !== outbox.fingerprint) {
                        invalid = true;
                        tx.abort();
                        return;
                    }
                    tx.objectStore('outbox').delete(outbox.key);
                    const all = tx.objectStore('outbox').index('scope').getAll(owner);
                    all.onsuccess = () => s.put({ ...row, ...(introduction ? {firstReportOperation: introduction} : {}),
                        status: (all.result as PracticeEvidenceOutbox[]).some(r => r.mutation.attemptId === remote.attemptId) ? 'device-only' : 'cloud-acked', cloudRevision: Math.max(row.cloudRevision, remote.revision) });
                };
            };
            try {
                await done;
            }
            catch (error) {
                if (invalid)
                    throw Error('practice-evidence-cloud-receipt-history');
                throw error;
            }
        }
        finally {
            db.close();
        }
    }
    let syncTail: Promise<unknown> = Promise.resolve();
    async function performSync(cloud: PracticeEvidenceCloudPort) {
        let acked = 0, conflict = false, unsupported = false, incompatible = false;
        const blocked = new Set<string>(), queue = (await pending()).sort((a, b) => a.mutation.expectedRevision - b.mutation.expectedRevision);
        for (const entry of queue) {
            const id = entry.mutation.attemptId;
            if (blocked.has(id))
                continue;
            let result: PracticeEvidenceCloudResponse;
            try {
                result = await cloud.mutate(entry.mutation);
            }
            catch (error) {
                blocked.add(id);
                if (error instanceof Error && ['practice-evidence-unsupported', 'practice-evidence-incompatible'].includes(error.message)) {
                    unsupported = error.message === 'practice-evidence-unsupported';
                    incompatible = !unsupported;
                    await mark(id, unsupported ? 'cloud-unsupported' : 'cloud-incompatible');
                    break;
                }
                if (error instanceof Error && (error as Error & {
                    status?: number;
                }).status === 409) {
                    conflict = true;
                    await mark(id, 'cloud-conflict');
                }
                continue;
            }
            try {
                validatePracticeEvidenceTree(result);
                if (!result || !['accepted', 'duplicate', 'conflict', 'unsupported', 'incompatible'].includes(result.status)
                    || Object.keys(result).some(k => !(['unsupported', 'incompatible'].includes(result.status) ? ['status'] : ['status', 'durable', 'operationId', 'revision', 'record']).includes(k)))
                    throw Error('incompatible');
            }
            catch {
                incompatible = true;
                await mark(id, 'cloud-incompatible');
                break;
            }
            if (result.status === 'unsupported' || result.status === 'incompatible') {
                unsupported = result.status === 'unsupported';
                incompatible = result.status === 'incompatible';
                await mark(id, unsupported ? 'cloud-unsupported' : 'cloud-incompatible');
                break;
            }
            if (result.status === 'conflict') {
                conflict = true;
                blocked.add(id);
                await mark(id, 'cloud-conflict');
                continue;
            }
            try {
                await ack(entry, result);
                acked++;
            }
            catch (error) {
                if (!(error instanceof Error) || !error.message.startsWith('practice-evidence-') || error.message.startsWith('practice-evidence-local-'))
                    throw error;
                conflict = true;
                blocked.add(id);
                await mark(id, 'cloud-conflict');
            }
        }
        const count = (await pending()).length;
        return { acked, pending: count, conflict, unsupported, incompatible, complete: count === 0 };
    }
    return {
        read, mutate, pending, hydrate,
        /** Read-only owned raw projection. No source/model authority is granted by this list. */
        listSavedDrafts: async ():Promise<PracticeEvidenceV1[]> => (await savedDrafts(false)).map(row=>row.record),
        /** Invalid diagnosis may be omitted solely for display; never hydrate or grade this projection. */
        listSavedStepDrafts: ():Promise<SavedStepDraftProjection[]> => savedDrafts(true),
        status: async (id: string) => (await readRow(id))?.status ?? null,
        refresh: async (cloud: Pick<PracticeEvidenceCloudPort, 'list'>) => { if (!cloud.list)
            return { restored: 0, unsupported: true }; let restored = 0; for (const record of await cloud.list())
            if (await hydrate(record))
                restored++; return { restored }; },
        sync: (cloud: PracticeEvidenceCloudPort) => { const task = syncTail.then(() => performSync(cloud)); syncTail = task.catch(() => undefined); return task; }
    };
}
