// @ts-expect-error TS5097: standalone Node contracts.
import {paperReadingClockScope, readPaperReadingClockCheckpoint} from './contracts.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {readPaperReadingGroupsCheckpoint} from './group-contracts.ts';
import type {PaperReadingClockScope} from './contracts';
import type {PaperReadingGroup, PaperReadingGroupClockState, PaperReadingGroupClockStorePort, PaperReadingGroupsCheckpoint} from './group-contracts';

/** Independent group history. Existing cumulative V1 is read once, never dual-written. */
export function createPaperReadingGroupClock(options: {
    scope: PaperReadingClockScope;
    store: PaperReadingGroupClockStorePort;
    now: () => number;
    makeId: () => string;
    isCurrent?: () => boolean;
}) {
    const scope = paperReadingClockScope(options.scope), listeners = new Set<() => void>();
    let status: PaperReadingGroupClockState['status'] = 'loading';
    let saveStatus: PaperReadingGroupClockState['saveStatus'] = 'unsaved';
    let error = '', groups: PaperReadingGroup[] = [], legacyElapsedMs = 0;
    let active = false, visible = false, disposed = false, last = options.now(), boundaryBusy = false;
    let saved: PaperReadingGroupsCheckpoint | null = null, pending: PaperReadingGroupsCheckpoint | null = null;
    let boundaryPending: PaperReadingGroupsCheckpoint | null = null;
    let loading: Promise<void> | null = null, boundaryWork: Promise<void> | null = null;
    let boundaryKind: 'start' | 'complete' | null = null;
    let queue: Promise<void> = Promise.resolve();
    const current = () => !disposed && (options.isCurrent?.() ?? true);
    const group = () => groups[groups.length - 1];
    const counting = () => current() && status === 'ready' && active && visible && Boolean(group())
        && !group().paused && !group().completed && !boundaryBusy && !boundaryPending && !boundaryKind;
    const publish = () => {if (current()) for (const listener of listeners) listener();};
    const settle = () => {
        const time = options.now(); if (!Number.isFinite(time)) throw Error('invalid-reading-clock-time');
        const delta = Math.max(0, time - last); last = Math.max(last, time);
        if (counting() && delta > 0) {
            const latest = group(); groups = [...groups.slice(0, -1), {...latest, elapsedMs: Math.min(Number.MAX_SAFE_INTEGER, latest.elapsedMs + delta)}];
            if (saveStatus === 'saved') saveStatus = 'unsaved';
        }
    };
    const assertReady = () => {
        if (!current()) throw Error('inactive-reading-clock-scope');
        if (status !== 'ready') throw Error('reading-clock-not-ready');
    };
    const roundedGroups = () => groups.map(value => ({...value, elapsedMs: Math.floor(value.elapsedMs)}));
    const checkpoint = (values = roundedGroups()): PaperReadingGroupsCheckpoint => ({schemaVersion: 1, scope,
        revision: (saved?.revision ?? 0) + 1, operationId: options.makeId(), legacyElapsedMs, groups: values});
    const matches = () => saved && JSON.stringify(saved.groups) === JSON.stringify(roundedGroups());
    const accept = (value: PaperReadingGroupsCheckpoint, expected: PaperReadingGroupsCheckpoint) => {
        const receipt = readPaperReadingGroupsCheckpoint(value, scope);
        if (JSON.stringify(receipt) !== JSON.stringify(expected)) throw Error('reading-groups-receipt-mismatch');
        saved = receipt; return receipt;
    };
    const fail = (cause: unknown) => {
        if (current()) {saveStatus = 'failed'; error = cause instanceof Error ? cause.message : '阅读组尚未保存'; publish();}
    };
    const saveDraft = async () => {
        for (let pass = 0; pass < 2; pass++) {
            settle(); if (!pending && matches()) break;
            pending ??= checkpoint();
            const value = pending, receipt = await options.store.saveGroups(scope, value, saved?.revision ?? 0);
            if (!current()) return false;
            accept(receipt, value); pending = null;
        }
        return true;
    };
    const saveBoundary = async () => {
        if (!boundaryPending) return true;
        const value = boundaryPending, receipt = await options.store.saveGroups(scope, value, saved?.revision ?? 0);
        if (!current()) return false;
        groups = accept(receipt, value).groups.map(entry => ({...entry})); boundaryPending = null;
        last = Math.max(last, options.now()); return true;
    };
    const finishSave = () => {settle(); error = ''; saveStatus = matches() ? 'saved' : 'unsaved'; publish();};
    const finishBoundary = async () => {
        if (!boundaryKind) return true;
        if (!boundaryPending) {
            if (!await saveDraft()) return false;
            const previous = group();
            if (boundaryKind === 'complete' && previous.completed) {boundaryKind = null; return true;}
            const finished = {...previous, elapsedMs: Math.floor(previous.elapsedMs), paused: true, completed: true};
            const next = [...roundedGroups().slice(0, -1), finished];
            if (boundaryKind === 'start') next.push({groupId: options.makeId(), elapsedMs: 0, paused: false, completed: false});
            boundaryPending = checkpoint(next);
        }
        if (!await saveBoundary()) return false;
        boundaryKind = null;
        last = Math.max(last, options.now());
        return true;
    };
    const enqueue = (work: () => Promise<void>) => {
        const next = queue.catch(() => {}).then(work); queue = next; return next;
    };
    const flush = (): Promise<void> => {
        try {assertReady(); settle();} catch (cause) {return Promise.reject(cause);}
        return enqueue(async () => {
            assertReady(); saveStatus = 'saving'; publish();
            try {
                if (boundaryKind ? !await finishBoundary() : !await saveDraft()) return;
                finishSave();
            } catch (cause) {fail(cause); throw cause;}
        });
    };
    const boundary = (kind: 'start' | 'complete'): Promise<void> => {
        if (boundaryWork) return boundaryKind === kind ? boundaryWork : Promise.reject(Error('reading-group-boundary-conflict'));
        try {assertReady(); settle();} catch (cause) {return Promise.reject(cause);}
        if (boundaryKind && boundaryKind !== kind) return Promise.reject(Error('reading-group-boundary-conflict'));
        boundaryKind = kind; boundaryBusy = true; publish();
        boundaryWork = enqueue(async () => {
            try {
                assertReady(); saveStatus = 'saving'; publish();
                if (!await finishBoundary()) return;
                finishSave();
            } catch (cause) {fail(cause); throw cause;}
            finally {boundaryBusy = false; boundaryWork = null; publish();}
        });
        return boundaryWork;
    };
    const load = (): Promise<void> => {
        if (loading) return loading;
        if (!current()) return Promise.reject(Error('inactive-reading-clock-scope'));
        loading = (async () => {
            try {
                const stored = await options.store.readGroups(scope); if (!current()) return;
                if (stored) saved = readPaperReadingGroupsCheckpoint(stored, scope);
                else {
                    const old = await options.store.read(scope); if (!current()) return;
                    const legacy = old === null ? null : readPaperReadingClockCheckpoint(old, scope);
                    legacyElapsedMs = legacy?.elapsedMs ?? 0;
                    groups = [{groupId: options.makeId(), elapsedMs: 0, paused: legacy?.paused ?? false, completed: false}];
                    const first = checkpoint();
                    const receipt = await options.store.saveGroups(scope, first, 0); if (!current()) return;
                    accept(receipt, first);
                }
                legacyElapsedMs = saved!.legacyElapsedMs; groups = saved!.groups.map(value => ({...value}));
                last = options.now(); status = 'ready'; saveStatus = 'saved'; error = ''; publish();
            } catch (cause) {
                if (current()) {status = 'unavailable'; error = cause instanceof Error ? cause.message : '阅读组无法恢复'; publish();}
                loading = null; throw cause;
            }
        })();
        return loading;
    };
    const snapshot = (): PaperReadingGroupClockState => {
        settle(); const latest = group(), elapsedMs = Math.floor(latest?.elapsedMs ?? 0);
        return {status, saveStatus, error, elapsedMs, paused: latest?.paused ?? false, counting: counting(),
            softTarget: elapsedMs < 600000 ? 'below' : elapsedMs <= 900000 ? 'within' : 'beyond', sync: 'device-only',
            groupId: latest?.groupId ?? null, groupCompleted: latest?.completed ?? false,
            completedGroupCount: groups.filter(value => value.completed).length,
            materialElapsedMs: Math.min(Number.MAX_SAFE_INTEGER, legacyElapsedMs + groups.reduce((total, value) => total + Math.floor(value.elapsedMs), 0))};
    };
    return {load, snapshot, flush, startGroup: () => boundary('start'), completeGroup: () => boundary('complete'),
        subscribe(listener: () => void) {listeners.add(listener); return () => {listeners.delete(listener);};},
        setActive(value: boolean) {settle(); active = value; publish();},
        setVisible(value: boolean) {settle(); visible = value; publish();},
        pause(value: boolean): Promise<void> {
            try {assertReady(); settle(); if (group().completed || boundaryKind || boundaryBusy) throw Error('reading-group-boundary-pending');}
            catch (cause) {return Promise.reject(cause);}
            groups = [...groups.slice(0, -1), {...group(), paused: value}];
            if (saveStatus !== 'failed') saveStatus = 'unsaved'; publish(); return flush();
        },
        dispose() {settle(); disposed = true; active = false; visible = false; listeners.clear();},
    };
}
export type PaperReadingGroupClock = ReturnType<typeof createPaperReadingGroupClock>;
