// @ts-expect-error TS5097: standalone Node contracts.
import {paperReadingClockScope, readPaperReadingClockCheckpoint} from './contracts.ts';
import type {PaperReadingClockCheckpoint, PaperReadingClockScope, PaperReadingClockState, PaperReadingClockStorePort} from './contracts';

/** A material-scoped sidecar. It has no answer, model, task or formal-event port. */
export function createPaperReadingClock(options: {
    scope: PaperReadingClockScope;
    store: PaperReadingClockStorePort;
    now: () => number;
    makeId: () => string;
    isCurrent?: () => boolean;
}) {
    const scope = paperReadingClockScope(options.scope), listeners = new Set<() => void>();
    let status: PaperReadingClockState['status'] = 'loading';
    let saveStatus: PaperReadingClockState['saveStatus'] = 'unsaved';
    let error = '', elapsedMs = 0, paused = false, visible = false, active = false;
    let disposed = false, last = options.now(), saved: PaperReadingClockCheckpoint | null = null;
    let pending: PaperReadingClockCheckpoint | null = null, loading: Promise<void> | null = null;
    let queue: Promise<void> = Promise.resolve();
    const current = () => !disposed && (options.isCurrent?.() ?? true);
    const counting = () => current() && status === 'ready' && active && visible && !paused;
    const publish = () => {if (current()) for (const listener of listeners) listener();};
    const settle = () => {
        const time = options.now();
        if (!Number.isFinite(time)) throw Error('invalid-reading-clock-time');
        // Preserve a monotonic watermark when an injected wall clock moves backward.
        const delta = Math.max(0, time - last);
        last = Math.max(last, time);
        if (counting() && delta > 0) {
            elapsedMs = Math.min(Number.MAX_SAFE_INTEGER, elapsedMs + delta);
            if (saveStatus === 'saved') saveStatus = 'unsaved';
        }
    };
    const assertReady = () => {
        if (!current()) throw Error('inactive-reading-clock-scope');
        if (status !== 'ready') throw Error('reading-clock-not-ready');
    };
    const snapshot = (): PaperReadingClockState => {
        settle();
        return {status, elapsedMs: Math.floor(elapsedMs), paused, counting: counting(), saveStatus, error,
            softTarget: elapsedMs < 600000 ? 'below' : elapsedMs <= 900000 ? 'within' : 'beyond', sync: 'device-only'};
    };
    const flush = (): Promise<void> => {
        try {assertReady(); settle();} catch (cause) {return Promise.reject(cause);}
        const work = queue.catch(() => {}).then(async () => {
            assertReady(); settle();
            if (!pending && saved && saved.elapsedMs === Math.floor(elapsedMs) && saved.paused === paused) {
                saveStatus = 'saved'; error = ''; publish(); return;
            }
            saveStatus = 'saving'; publish();
            try {
                // Recover an uncertain commit first, even if interaction changed since it.
                // Then checkpoint the latest state. Bounded: never chase a running clock forever.
                for (let pass = 0; pass < 2; pass++) {
                    if (!pending) {
                        settle();
                        if (saved && saved.elapsedMs === Math.floor(elapsedMs) && saved.paused === paused) break;
                        pending = {schemaVersion: 1, scope, revision: (saved?.revision ?? 0) + 1,
                            operationId: options.makeId(), elapsedMs: Math.floor(elapsedMs), paused};
                    }
                    const checkpoint = pending;
                    const result = await options.store.save(scope, checkpoint, saved?.revision ?? 0);
                    if (!current()) return;
                    const receipt = readPaperReadingClockCheckpoint(result, scope);
                    if (JSON.stringify(receipt) !== JSON.stringify(checkpoint)) throw Error('reading-clock-receipt-mismatch');
                    saved = receipt; pending = null;
                }
                error = ''; settle();
                saveStatus = saved && Math.floor(elapsedMs) === saved.elapsedMs && paused === saved.paused ? 'saved' : 'unsaved';
                publish();
            } catch (cause) {
                if (current()) {saveStatus = 'failed'; error = cause instanceof Error ? cause.message : '阅读计时尚未保存'; publish();}
                throw cause;
            }
        });
        queue = work; return work;
    };
    const load = (): Promise<void> => {
        if (loading) return loading;
        if (!current()) return Promise.reject(Error('inactive-reading-clock-scope'));
        loading = (async () => {
            try {
                const value = await options.store.read(scope);
                if (!current()) return;
                saved = value === null ? null : readPaperReadingClockCheckpoint(value, scope);
                elapsedMs = saved?.elapsedMs ?? 0; paused = saved?.paused ?? false;
                // Restoration never uses stored timestamps to credit absent time.
                last = options.now(); status = 'ready'; saveStatus = saved ? 'saved' : 'unsaved'; error = ''; publish();
            } catch (cause) {
                if (current()) {status = 'unavailable'; error = cause instanceof Error ? cause.message : '阅读计时无法恢复'; publish();}
                loading = null; throw cause;
            }
        })();
        return loading;
    };
    return {
        load, snapshot, flush,
        subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
        setVisible(value: boolean) {settle(); visible = value; publish();},
        setActive(value: boolean) {settle(); active = value; publish();},
        pause(value: boolean): Promise<void> {
            try {assertReady(); settle();} catch (cause) {return Promise.reject(cause);}
            paused = value; if (saveStatus !== 'failed') saveStatus = 'unsaved'; publish(); return flush();
        },
        dispose() {settle(); active = false; visible = false; disposed = true; listeners.clear();},
    };
}
export type PaperReadingClock = ReturnType<typeof createPaperReadingClock>;
