export type PaperReadingClockScope = {
    ownerId: string;
    libraryId: string;
    materialFingerprint: string;
};
export type PaperReadingClockCheckpoint = {
    schemaVersion: 1;
    scope: PaperReadingClockScope;
    revision: number;
    operationId: string;
    elapsedMs: number;
    paused: boolean;
};
export interface PaperReadingClockStorePort {
    read(scope: PaperReadingClockScope): Promise<PaperReadingClockCheckpoint | null>;
    /** Compare-and-swap; resolve only after durable commit. No silent fallback. */
    save(scope: PaperReadingClockScope, checkpoint: PaperReadingClockCheckpoint, expectedRevision: number): Promise<PaperReadingClockCheckpoint>;
}
/** Reserved controlled boundary. The local clock never invents a remote receipt. */
export interface PaperReadingClockRemotePort extends PaperReadingClockStorePort {
    supported(): Promise<boolean>;
}
export type PaperReadingClockState = {
    status: 'loading' | 'ready' | 'unavailable';
    elapsedMs: number;
    paused: boolean;
    counting: boolean;
    saveStatus: 'unsaved' | 'saving' | 'saved' | 'failed';
    error: string;
    softTarget: 'below' | 'within' | 'beyond';
    sync: 'device-only';
};

export function paperReadingClockScope(value: PaperReadingClockScope): PaperReadingClockScope {
    if (!value || typeof value.ownerId !== 'string' || !value.ownerId.trim()
        || typeof value.libraryId !== 'string' || !value.libraryId.trim()
        || typeof value.materialFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.materialFingerprint)) throw Error('invalid-reading-clock-scope');
    return {ownerId: value.ownerId, libraryId: value.libraryId, materialFingerprint: value.materialFingerprint};
}
export function paperReadingClockKey(scope: PaperReadingClockScope): string {
    const key = paperReadingClockScope(scope);
    return `paper-reading-clock:v1:${JSON.stringify([key.ownerId, key.libraryId, key.materialFingerprint])}`;
}
export function readPaperReadingClockCheckpoint(value: unknown, scope: PaperReadingClockScope): PaperReadingClockCheckpoint {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('corrupt-reading-clock');
    const record = value as PaperReadingClockCheckpoint;
    const expected = ['schemaVersion', 'scope', 'revision', 'operationId', 'elapsedMs', 'paused'];
    if (Object.keys(record).some(key => !expected.includes(key)) || record.schemaVersion !== 1
        || !Number.isSafeInteger(record.revision) || record.revision < 1
        || typeof record.operationId !== 'string' || !record.operationId.trim()
        || !Number.isSafeInteger(record.elapsedMs) || record.elapsedMs < 0
        || typeof record.paused !== 'boolean'
        || paperReadingClockKey(record.scope) !== paperReadingClockKey(scope)) throw Error('corrupt-reading-clock');
    return {schemaVersion: 1, scope: paperReadingClockScope(record.scope), revision: record.revision,
        operationId: record.operationId, elapsedMs: record.elapsedMs, paused: record.paused};
}
