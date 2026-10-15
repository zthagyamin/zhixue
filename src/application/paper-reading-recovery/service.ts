// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalAttemptJson} from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {recoveryObject, recoveryJson, recoveryScope, recoveryDigest, recoverySize, PAPER_READING_RECOVERY_MAX_RECORDS} from './contracts.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {validateRecoveryRows} from './records.ts';
import type {PaperReadingRecoveryArtifact, PaperReadingRecoveryCodec, PaperReadingRecoveryPort, PaperReadingRecoveryRecord, PaperReadingRecoveryScope} from './contracts';

export function createPaperReadingRecovery(options: {
    scope: PaperReadingRecoveryScope;
    port: PaperReadingRecoveryPort;
    codec: PaperReadingRecoveryCodec;
    hash: (text: string) => Promise<string>;
    isCurrent?: () => boolean;
}) {
    const scope = recoveryScope(options.scope);
    const current = () => {if (options.isCurrent?.() === false) throw Error('reading-recovery-inactive-scope');};
    const hash = async (raw: unknown) => {const digest = await options.hash(canonicalAttemptJson(raw)); recoveryDigest(digest); return digest;};
    const header = {schemaVersion: 1 as const, documentType: 'paper-reading-recovery' as const, scope, complete: true as const,
        originalPdf: 'excluded' as const, feedbackProvenance: 'restored-reading-evidence' as const};
    async function exportArtifact(): Promise<PaperReadingRecoveryArtifact> {
        current(); const captured = await options.port.snapshot(); current();
        const verified = await validateRecoveryRows(scope, captured, options.codec, options.hash); current();
        const records: PaperReadingRecoveryRecord[] = [];
        for (let index = 0; index < verified.rows.length; index++) {
            const body = {type: verified.types[index], ...verified.rows[index]}; records.push({...body, hash: await hash(body)});
        }
        const body = {...header, records}, artifact = {...body, hash: await hash(body)}; recoverySize(artifact); current(); return artifact;
    }
    async function check(input: unknown): Promise<PaperReadingRecoveryArtifact> {
        current(); recoverySize(input);
        let raw = input;
        if (typeof raw === 'string') {try {raw = JSON.parse(raw);} catch {throw Error('reading-recovery-invalid-json');}}
        const value = recoveryObject(raw, ['schemaVersion', 'documentType', 'scope', 'complete', 'originalPdf', 'feedbackProvenance', 'records', 'hash']);
        if (value.schemaVersion !== 1 || value.documentType !== header.documentType || value.complete !== true
            || value.originalPdf !== 'excluded' || value.feedbackProvenance !== header.feedbackProvenance) throw Error('reading-recovery-schema');
        const receivedScope = recoveryScope(value.scope);
        if (receivedScope.ownerId !== scope.ownerId || receivedScope.libraryId !== scope.libraryId) throw Error('reading-recovery-scope');
        recoveryDigest(value.hash);
        if (!Array.isArray(value.records) || value.records.length > PAPER_READING_RECOVERY_MAX_RECORDS) throw Error('reading-recovery-limit');
        const records = recoveryJson(value.records) as PaperReadingRecoveryRecord[];
        const body = {...header, records}; if (await hash(body) !== value.hash) throw Error('reading-recovery-artifact-hash');
        for (const record of records) {
            recoveryObject(record, ['type', 'id', 'workspaceId', 'kind', 'value', 'hash']); recoveryDigest(record.hash);
            const {hash: expected, ...row} = record;
            if (await hash(row) !== expected) throw Error('reading-recovery-record-hash');
        }
        const rows = records.map(({id, workspaceId, kind, value}) => ({id, workspaceId, kind, value}));
        const verified = await validateRecoveryRows(scope, rows, options.codec, options.hash); current();
        if (records.some((record, index) => record.type !== verified.types[index])) throw Error('reading-recovery-record-type');
        return {...body, hash: value.hash};
    }
    async function preview(input: unknown) {
        const artifact = await check(input);
        const rows = artifact.records.map(({id, workspaceId, kind, value}) => ({id, workspaceId, kind, value}));
        const result = await options.port.inspect(rows); current();
        const counts = {materials: 0, draft: 0, workspace: 0, prepared: 0, clock: 0, groups: 0};
        for (const record of artifact.records) counts[record.type]++;
        return {artifactHash: artifact.hash, scope, counts, recordCount: rows.length, canRestore: result.conflicts.length === 0,
            ...result, originalPdf: 'excluded' as const, feedbackProvenance: header.feedbackProvenance,
            notice: '原 PDF 未包含；需重新提供同版本原文件。恢复的是已有阅读反馈，不是重新判题；计时和问答仍仅保存在本机。'};
    }
    async function restore(input: unknown, previewHash: string) {
        recoveryDigest(previewHash);
        const artifact = await check(input);
        if (artifact.hash !== previewHash) throw Error('reading-recovery-preview-changed'); current();
        const rows = artifact.records.map(({id, workspaceId, kind, value}) => ({id, workspaceId, kind, value}));
        const receipt = await options.port.commit(rows); current();
        if (receipt.durable !== true || receipt.added + receipt.duplicates !== rows.length) throw Error('reading-recovery-receipt');
        return {...receipt, artifactHash: artifact.hash, feedbackProvenance: header.feedbackProvenance, originalPdf: 'excluded' as const};
    }
    return {export: exportArtifact, check, preview, restore};
}
export type PaperReadingRecoveryService = ReturnType<typeof createPaperReadingRecovery>;
