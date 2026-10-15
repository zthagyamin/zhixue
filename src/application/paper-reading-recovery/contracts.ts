export type PaperReadingRecoveryScope = {ownerId: string; libraryId: string};
export type PaperReadingRecoveryRow = {id: string; workspaceId: string; kind: string; value: unknown};
export type PaperReadingRecoveryKind = 'materials' | 'draft' | 'workspace' | 'prepared' | 'clock' | 'groups';
export type PaperReadingRecoveryRecord = PaperReadingRecoveryRow & {type: PaperReadingRecoveryKind; hash: string};
export type PaperReadingRecoveryArtifact = {
    schemaVersion: 1;
    documentType: 'paper-reading-recovery';
    scope: PaperReadingRecoveryScope;
    complete: true;
    originalPdf: 'excluded';
    feedbackProvenance: 'restored-reading-evidence';
    records: PaperReadingRecoveryRecord[];
    hash: string;
};
export type PaperReadingRecoveryInspection = {added: number; duplicates: number; conflicts: string[]};
export interface PaperReadingRecoveryPort {
    /** One consistent bounded snapshot; overflow must throw, never return a partial list. */
    snapshot(): Promise<PaperReadingRecoveryRow[]>;
    inspect(rows: PaperReadingRecoveryRow[]): Promise<PaperReadingRecoveryInspection>;
    /** One atomic transaction, with fresh conflict checks before writing any row. */
    commit(rows: PaperReadingRecoveryRow[]): Promise<{added: number; duplicates: number; durable: true}>;
}
export type PaperReadingRecoveryMaterial = {
    paperId: string;
    title: string;
    origin?: {version: string; kind: string};
    sections: {id: string; paragraphs: {id: string; rawEn: string; pageNumber?: number}[]}[];
};
export type PaperReadingRecoveryCodec = {
    parseMaterial(value: unknown): PaperReadingRecoveryMaterial;
    fingerprint(value: unknown): Promise<string>;
};
export const PAPER_READING_RECOVERY_MAX_RECORDS = 2000;
export const PAPER_READING_RECOVERY_MAX_BYTES = 50_000_000;
export function recoveryObject(raw: unknown, fields: string[], optional: string[] = []): Record<string, unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || fields.some(key => !Object.hasOwn(raw, key))
        || Object.keys(raw).some(key => !fields.includes(key) && !optional.includes(key))) throw Error('reading-recovery-invalid-fields');
    return raw as Record<string, unknown>;
}
export function recoveryScope(raw: unknown): PaperReadingRecoveryScope {
    const value = recoveryObject(raw, ['ownerId', 'libraryId']);
    for (const key of ['ownerId', 'libraryId']) if (typeof value[key] !== 'string' || !(value[key] as string).trim()
        || (value[key] as string).length > 200) throw Error('reading-recovery-scope');
    return {ownerId: value.ownerId as string, libraryId: value.libraryId as string};
}
export function recoverySize(raw: unknown): void {
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (!text || new TextEncoder().encode(text).byteLength > PAPER_READING_RECOVERY_MAX_BYTES) throw Error('reading-recovery-limit');
}
export function recoveryJson<T>(value: T): T {
    try {return JSON.parse(JSON.stringify(value));} catch {throw Error('reading-recovery-invalid-json');}
}
export function recoveryDigest(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw Error('reading-recovery-hash');
}
export function recoveryRanges(rawScope: PaperReadingRecoveryScope): {exact?: string; prefix?: string}[] {
    const {ownerId, libraryId} = recoveryScope(rawScope), pair = JSON.stringify([ownerId, libraryId]).slice(0, -1) + ',';
    return [{exact: `${ownerId}:paper-document:${libraryId}`},
        {prefix: `${ownerId}:paper-draft:${JSON.stringify([libraryId]).slice(0, -1)},`},
        {prefix: 'paper-reading-workspaces:v1:paper-reading:v1:' + pair},
        {prefix: 'paper-reading-prepared:v1:' + pair},
        {prefix: 'paper-reading-clock:v1:' + pair}, {prefix: 'paper-reading-groups:v1:' + pair}];
}
