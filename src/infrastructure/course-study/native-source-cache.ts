import type { NativeCourseCapture, NativeCourseIdentity } from '../../domain/course-study';
import type { AttemptBinding } from '../../domain/learning-attempt';
// @ts-expect-error TS5097: standalone Node contracts.
import { parseNativeCourseCapture, parseNativeCourseIdentity, assertNativeCaptureBinding } from '../../domain/course-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { attemptId, parseAttemptBinding, canonicalAttemptJson } from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { studyHash } from '../../domain/sync/index.ts';

type Scope = { userId: string; libraryId: string };
type Receipt = { durable: true; captureId: string };
type CaptureRow = { key: string[]; capture: NativeCourseCapture; rowHash: string };
type IdentityRow = { key: string[]; captureId: string };
type AttemptRow = IdentityRow & { binding: AttemptBinding; linkHash: string };
const databaseName = 'zhixue-native-course-sources-v1';

function same(a: unknown, b: unknown): boolean { return canonicalAttemptJson(a) === canonicalAttemptJson(b); }
function closed(raw: unknown, fields: string[]): Record<string, unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || !same(Object.keys(raw).sort(), [...fields].sort())) throw Error('native-course-cache-corrupt');
    return raw as Record<string, unknown>;
}
function digest(raw: unknown): string {
    if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/.test(raw)) throw Error('native-course-cache-capture-id');
    return raw;
}
function pointer(raw: unknown, key: string[], binding?: AttemptBinding): string {
    const row = closed(raw, binding ? ['key', 'captureId', 'binding', 'linkHash'] : ['key', 'captureId']);
    if (!same(row.key, key)) throw Error('native-course-cache-scope');
    if (binding && !same(parseAttemptBinding(row.binding), binding)) throw Error('native-course-cache-binding');
    return digest(row.captureId);
}
function open(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') return Promise.reject(Error('native-course-cache-unavailable'));
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        request.onupgradeneeded = () => {
            for (const name of ['captures', 'identities', 'attempts']) request.result.createObjectStore(name, { keyPath: 'key' });
        };
        request.onblocked = () => reject(Error('native-course-cache-blocked'));
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            request.result.onversionchange = () => request.result.close();
            resolve(request.result);
        };
    });
}
function request<T>(value: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        value.onsuccess = () => resolve(value.result);
        value.onerror = () => reject(value.error);
    });
}
/** A cache is not an authentication certificate. Only the authenticated Companion receipt path may call save. */
export function createNativeCourseSourceCache(rawScope: Scope) {
    const scope = { userId: attemptId(rawScope.userId), libraryId: attemptId(rawScope.libraryId) };
    const owner = [scope.userId, scope.libraryId];
    if (!/^local-vault:[a-f0-9]{64}$/.test(scope.libraryId)) throw Error('native-course-cache-scope');
    const captureKey = (id: string) => [...owner, digest(id)];
    const attemptKey = (id: string) => [...owner, attemptId(id)];
    function identityKey(raw: NativeCourseIdentity): string[] {
        const identity = parseNativeCourseIdentity(raw);
        if (identity.libraryId !== scope.libraryId) throw Error('native-course-cache-scope');
        return [...owner, canonicalAttemptJson(identity)];
    }
    function bindingInScope(raw: AttemptBinding): AttemptBinding {
        const binding = parseAttemptBinding(raw);
        if (binding.ownerId !== scope.userId || binding.libraryId !== scope.libraryId || binding.snapshotId !== 'local')
            throw Error('native-course-cache-scope');
        return binding;
    }
    async function captureRow(raw: unknown, id: string): Promise<NativeCourseCapture> {
        const row = closed(raw, ['key', 'capture', 'rowHash']);
        if (!same(row.key, captureKey(id))) throw Error('native-course-cache-scope');
        if (digest(row.rowHash) !== await studyHash({ key: row.key, capture: row.capture })) throw Error('native-course-cache-integrity');
        const capture = await parseNativeCourseCapture(row.capture);
        if (capture.captureId !== id) throw Error('native-course-cache-capture-id');
        identityKey(capture.identity);
        return capture;
    }
    async function readCapture(id: string): Promise<NativeCourseCapture | null> {
        const db = await open();
        try {
            const raw = await request(db.transaction('captures').objectStore('captures').get(captureKey(id)));
            if (!raw) return null;
            const capture = await captureRow(raw, id), key = identityKey(capture.identity);
            const identity = await request(db.transaction('identities').objectStore('identities').get(key));
            if (!identity || pointer(identity, key) !== id) throw Error('native-course-cache-identity-conflict');
            return capture;
        } finally { db.close(); }
    }
    async function byIdentity(raw: NativeCourseIdentity): Promise<NativeCourseCapture | null> {
        const identity = parseNativeCourseIdentity(raw), key = identityKey(identity), db = await open();
        let id: string;
        try {
            const row = await request(db.transaction('identities').objectStore('identities').get(key));
            if (!row) return null;
            id = pointer(row, key);
        } finally { db.close(); }
        const capture = await readCapture(id);
        if (!capture || !same(capture.identity, identity)) throw Error('native-course-cache-identity-conflict');
        return capture;
    }
    async function read(raw: AttemptBinding, id: string): Promise<NativeCourseCapture | null> {
        const binding = bindingInScope(raw), key = attemptKey(id), db = await open();
        let captureId: string;
        try {
            const row = await request(db.transaction('attempts').objectStore('attempts').get(key));
            if (!row) return null;
            captureId = pointer(row, key, binding);
            if (digest(row.linkHash) !== await studyHash({ key, binding, captureId })) throw Error('native-course-cache-integrity');
        } finally { db.close(); }
        const capture = await readCapture(captureId);
        if (!capture) throw Error('native-course-cache-capture-missing');
        assertNativeCaptureBinding(capture, binding);
        return capture;
    }
    // Each write keeps its checks and mutations in a single IndexedDB transaction.
    // The acknowledgement is emitted only after commit and an exact readback.
    async function write(stores: string[], run: (tx: IDBTransaction, fail: (error: unknown) => void) => void): Promise<void> {
        const db = await open();
        try {
            await new Promise<void>((resolve, reject) => {
                const tx = db.transaction(stores, 'readwrite');
                let failure: unknown;
                const fail = (error: unknown) => { failure = error; tx.abort(); };
                tx.oncomplete = () => resolve();
                tx.onabort = () => reject(failure ?? tx.error ?? Error('native-course-cache-write-aborted'));
                tx.onerror = () => reject(tx.error);
                try { run(tx, fail); } catch (error) { fail(error); }
            });
        } finally { db.close(); }
    }
    async function save(raw: NativeCourseCapture): Promise<Receipt> {
        const capture = await parseNativeCourseCapture(raw), key = captureKey(capture.captureId), identity = identityKey(capture.identity);
        const row: CaptureRow = { key, capture, rowHash: await studyHash({ key, capture }) };
        await write(['captures', 'identities'], (tx, fail) => {
            const store = tx.objectStore('captures'), identities = tx.objectStore('identities');
            const getIdentity = identities.get(identity);
            getIdentity.onsuccess = () => {
                try {
                    const existing = getIdentity.result;
                    if (existing && pointer(existing, identity) !== capture.captureId) throw Error('native-course-cache-identity-conflict');
                    const getCapture = store.get(key);
                    getCapture.onsuccess = () => {
                        try {
                            if (getCapture.result && !same(getCapture.result, row)) throw Error('native-course-cache-capture-conflict');
                            if (Boolean(existing) !== Boolean(getCapture.result)) throw Error('native-course-cache-corrupt');
                            if (!getCapture.result) {
                                store.add(row);
                                identities.add({ key: identity, captureId: capture.captureId } satisfies IdentityRow);
                            }
                        } catch (error) { fail(error); }
                    };
                } catch (error) { fail(error); }
            };
        });
        if (!same(await byIdentity(capture.identity), capture)) throw Error('native-course-cache-receipt-mismatch');
        return { durable: true, captureId: capture.captureId };
    }
    async function bindAttempt(id: string, raw: AttemptBinding, captureId: string): Promise<Receipt> {
        const binding = bindingInScope(raw), key = attemptKey(id), capture = await readCapture(digest(captureId));
        if (!capture) throw Error('native-course-cache-capture-missing');
        assertNativeCaptureBinding(capture, binding);
        const row: AttemptRow = { key, binding, captureId, linkHash: await studyHash({ key, binding, captureId }) };
        const sourceKey = captureKey(captureId);
        const sourceRow: CaptureRow = { key: sourceKey, capture, rowHash: await studyHash({ key: sourceKey, capture }) };
        await write(['captures', 'attempts'], (tx, fail) => {
            const getCapture = tx.objectStore('captures').get(captureKey(captureId));
            getCapture.onsuccess = () => {
                try {
                    if (!same(getCapture.result, sourceRow)) throw Error('native-course-cache-capture-conflict');
                    const store = tx.objectStore('attempts'), get = store.get(key);
                    get.onsuccess = () => {
                        try {
                            if (get.result && !same(get.result, row)) throw Error('native-course-cache-attempt-conflict');
                            if (!get.result) store.add(row);
                        } catch (error) { fail(error); }
                    };
                } catch (error) { fail(error); }
            };
        });
        if (!same(await read(binding, id), capture)) throw Error('native-course-cache-receipt-mismatch');
        return { durable: true, captureId };
    }
    return { save, bindAttempt, read, byIdentity };
}
