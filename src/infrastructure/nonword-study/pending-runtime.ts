import type { AttemptMutation, LearningAttempt } from '../../domain/learning-attempt';
import type { StudyItemVersion, StudySnapshot } from '../../domain/sync';
import type { NativeMathCapture } from '../../domain/math-study';
// @ts-expect-error TS5097: standalone Node contracts.
import { parseNativeMathCapture, assertNativeMathCaptureBinding } from '../../domain/math-study/index.ts';
import type { NativeCourseCapture } from '../../domain/course-study';
// @ts-expect-error TS5097: standalone Node contracts.
import { parseNativeCourseCapture, assertNativeCaptureBinding } from '../../domain/course-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { attemptId, canonicalAttemptJson } from '../../domain/learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { isNonWordOriginal } from '../../domain/content/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { createLocalAttemptRepository } from '../learning-attempt/index.ts';
export type PendingLocalPort = {
    list: () => Promise<LearningAttempt[]>;
    read: (id: string) => Promise<LearningAttempt | null>;
    pending?: () => Promise<readonly {
        mutation: Pick<AttemptMutation, 'attemptId'>;
    }[]>;
    status?: (id: string) => Promise<string | null>;
    reference?: (id: string) => Promise<unknown | null>;
};
export type PendingCloudPort = {
    list: () => Promise<LearningAttempt[]>;
    read: (id: string) => Promise<LearningAttempt | null>;
    referenceBundle?: (id: string) => Promise<{
        item: unknown;
        snapshot?: unknown;
    }>;
    reference?: (id: string) => Promise<unknown>;
};
export type PendingReferenceCapability = 'complete' | 'item-only' | 'reference-unavailable' | 'conflict' | 'not-nonword';
export type NonWordPendingOriginal = {
    attempt: LearningAttempt;
    item: StudyItemVersion | null;
    snapshot?: StudySnapshot;
    nativeCapture?: NativeCourseCapture;
    nativeMathCapture?: NativeMathCapture;
    referenceVerified: boolean;
    resumable: boolean;
    capability: PendingReferenceCapability;
    notice: string;
};
export type NonWordPendingOptions = {
    ownerId: string;
    libraryId: string;
    repository?: PendingLocalPort;
    cloud?: PendingCloudPort | null;
    parseItem: (raw: unknown) => Promise<StudyItemVersion>;
    parseSnapshot: (raw: unknown) => Promise<StudySnapshot>;
    /** A scoped cache reader may supply an original native/account source already available locally. */
    localReference?: (attempt: LearningAttempt) => Promise<unknown | null>;
    /** Read only the original attempt association in an owner-scoped native cache. */
    nativeReference?: (attempt: LearningAttempt) => Promise<NativeCourseCapture | null>;
    nativeMathReference?: (attempt: LearningAttempt) => Promise<NativeMathCapture | null>;
};
/** Read-only recovery composition. No hydration, outbox acknowledgment, model, or formal writer. */
export function createNonWordPendingRuntime(options: NonWordPendingOptions) {
    const ownerId = attemptId(options.ownerId), libraryId = attemptId(options.libraryId);
    const repository = options.repository ?? createLocalAttemptRepository({ userId: ownerId, libraryId }), cloud = options.cloud ?? null;
    const known = new Map<string, LearningAttempt>(), conflicts = new Set<string>(), statuses = new Map<string, string | null>();
    let notice = '';
    const owned = (row: LearningAttempt | null): row is LearningAttempt => Boolean(row && row.schemaVersion === 1 && row.binding?.ownerId === ownerId && row.binding?.libraryId === libraryId);
    const eligible = (row: LearningAttempt) => owned(row) && typeof row.attemptId === 'string' && Boolean(row.checkpoint && row.evaluation) && row.parentAttemptId === null
        && (row.checkpoint.purpose ?? 'first') === 'first' && !row.attemptId.startsWith('nw-round:')
        && ['quiz', 'recall', 'code', 'calculation', 'flashcard'].includes(row.checkpoint.mode ?? '')
        && (row.submitted ? typeof row.submitted.answer === 'string' && (row.evaluation.status === 'pending' || row.evaluation.status === 'resolved' && row.formal?.status !== 'linked')
            : row.formal === null && (typeof row.answer === 'string' && Boolean(row.answer.trim()) || row.checkpoint.view?.paused === true));
    const unsupported = (error: unknown) => error instanceof Error && /unsupported/.test(error.message);
    const unavailableNotice = (error?: unknown) => unsupported(error) ? '当前服务尚不支持原题恢复；原答案已保留。' : '原题参考暂不可用；原答案已保留，未使用当前新版本参考。';
    const sameSubmission = (a: LearningAttempt, b: LearningAttempt) => !a.submitted || !b.submitted || canonicalAttemptJson(a.submitted) === canonicalAttemptJson(b.submitted);
    async function choose(local: LearningAttempt | null, remote: LearningAttempt | null, queued: Set<string>): Promise<LearningAttempt | null> {
        if (local && !owned(local))
            throw Error('pending-attempt-scope');
        if (remote && !owned(remote))
            remote = null;
        if (!local)
            return remote;
        const status = await repository.status?.(local.attemptId);
        const prior = statuses.get(local.attemptId);
        statuses.set(local.attemptId, status ?? null);
        if (prior === 'cloud-conflict' && status === 'cloud-acked' && !queued.has(local.attemptId))
            conflicts.delete(local.attemptId);
        if (status === 'cloud-conflict')
            conflicts.add(local.attemptId);
        if (remote && (canonicalAttemptJson(local.binding) !== canonicalAttemptJson(remote.binding) || !sameSubmission(local, remote)))
            conflicts.add(local.attemptId);
        if (queued.has(local.attemptId) || conflicts.has(local.attemptId))
            return local;
        return remote && remote.revision > local.revision ? remote : local;
    }
    async function queuedIds(): Promise<Set<string>> { return new Set((await repository.pending?.() ?? []).map(row => row.mutation.attemptId)); }
    async function validateSource(attempt: LearningAttempt, raw: unknown): Promise<{
        item: StudyItemVersion;
        snapshot?: StudySnapshot;
    }> {
        const packet = raw && typeof raw === 'object' && Object.hasOwn(raw, 'item') ? raw as {
            item: unknown;
            snapshot?: unknown;
        } : { item: raw };
        const item = await options.parseItem(packet.item), binding = attempt.binding;
        if (item.itemKey !== binding.itemKey || item.contentHash !== binding.contentHash)
            throw Error('pending-original-item-binding');
        if (packet.snapshot === undefined || packet.snapshot === null)
            return { item };
        const snapshot = await options.parseSnapshot(packet.snapshot);
        if (snapshot.libraryId !== libraryId || snapshot.snapshotId !== binding.snapshotId
            || !snapshot.items.some(member => member.itemKey === binding.itemKey && member.contentHash === binding.contentHash))
            throw Error('pending-original-snapshot-binding');
        return { item, snapshot };
    }
    async function source(attempt: LearningAttempt): Promise<{
        item: StudyItemVersion;
        snapshot?: StudySnapshot;
        error?: unknown;
    } | {
        item: null;
        error?: unknown;
    }> {
        let cached: {
            item: StudyItemVersion;
            snapshot?: StudySnapshot;
        } | undefined, error: unknown;
        try {
            const raw = await options.localReference?.(attempt) ?? await repository.reference?.(attempt.attemptId);
            if (raw)
                cached = await validateSource(attempt, raw);
        }
        catch (reason) {
            error = reason;
        }
        if (cached && (cached.snapshot || !cloud || cached.item.kind === 'word' || cached.item.eventKind === 'word'))
            return cached;
        if (cloud) {
            try {
                const raw = cloud.referenceBundle ? await cloud.referenceBundle(attempt.attemptId) : cloud.reference ? { item: await cloud.reference(attempt.attemptId) } : null;
                if (raw)
                    return await validateSource(attempt, raw);
            }
            catch (reason) {
                error = reason;
            }
        }
        return cached ? { ...cached, error } : { item: null, error };
    }
    async function describe(attempt: LearningAttempt): Promise<NonWordPendingOriginal> {
        if (!cloud && attempt.binding.snapshotId === 'local' && attempt.checkpoint.mode === 'calculation' && options.nativeMathReference) {
            try {
                const raw = await options.nativeMathReference(structuredClone(attempt));
                if (raw) {
                    const capture = await parseNativeMathCapture(raw);
                    assertNativeMathCaptureBinding(capture, attempt.binding);
                    const conflict = conflicts.has(attempt.attemptId);
                    return { attempt: structuredClone(attempt), item: null, nativeMathCapture: capture,
                        referenceVerified: true, resumable: !conflict, capability: conflict ? 'conflict' : 'complete',
                        notice: conflict ? '另一设备的作答发生冲突；本机原答案保留，尚未覆盖。' : '' };
                }
            } catch (error) {
                return { attempt: structuredClone(attempt), item: null, referenceVerified: false, resumable: false,
                    capability: 'reference-unavailable', notice: unavailableNotice(error) };
            }
            return { attempt: structuredClone(attempt), item: null, referenceVerified: false, resumable: false,
                capability: 'reference-unavailable', notice: unavailableNotice() };
        }
        if (!cloud && attempt.binding.snapshotId === 'local' && options.nativeReference) {
            try {
                const raw = await options.nativeReference(structuredClone(attempt));
                if (raw) {
                    const capture = await parseNativeCourseCapture(raw);
                    assertNativeCaptureBinding(capture, attempt.binding);
                    if (capture.item.practice.questionType !== attempt.checkpoint.mode)
                        throw Error('pending-native-task-mode-binding');
                    const conflict = conflicts.has(attempt.attemptId);
                    return { attempt: structuredClone(attempt), item: null, nativeCapture: capture,
                        referenceVerified: true, resumable: !conflict, capability: conflict ? 'conflict' : 'complete',
                        notice: conflict ? '另一设备的作答发生冲突；本机原答案保留，尚未覆盖。' : '' };
                }
            } catch (error) {
                return { attempt: structuredClone(attempt), item: null, referenceVerified: false, resumable: false,
                    capability: 'reference-unavailable', notice: unavailableNotice(error) };
            }
        }
        const original = await source(attempt), conflict = conflicts.has(attempt.attemptId), item = original.item;
        const practice = Boolean(item && item.kind === 'practice' && isNonWordOriginal(attempt.checkpoint.mode ?? '', item));
        const snapshot = 'snapshot' in original ? original.snapshot : undefined;
        const capability: PendingReferenceCapability = item && !practice ? 'not-nonword' : conflict ? 'conflict' : !item ? 'reference-unavailable' : snapshot || !cloud ? 'complete' : original.error ? 'reference-unavailable' : 'item-only';
        return { attempt: structuredClone(attempt), item: practice ? item : null, ...(practice && snapshot ? { snapshot } : {}), referenceVerified: practice,
            resumable: practice && !conflict && Boolean(snapshot || !cloud), capability,
            notice: conflict ? '另一设备的作答发生冲突；本机原答案保留，尚未覆盖。' : capability === 'item-only' ? '当前服务未提供原快照头；原答案已保留，暂不能恢复正式核对。' : capability === 'reference-unavailable' ? unavailableNotice(original.error) : capability === 'not-nonword' ? '这是词汇或不支持的原材料，未纳入非词汇核对。' : '' };
    }
    async function listDetailed(): Promise<NonWordPendingOriginal[]> {
        notice = '';
        const locals = await repository.list(), queued = await queuedIds();
        let remotes: LearningAttempt[] = [];
        if (cloud)
            try {
                remotes = await cloud.list();
                if (!Array.isArray(remotes))
                    throw Error('pending-cloud-invalid');
            }
            catch (error) {
                remotes = [];
                notice = unavailableNotice(error);
            }
        const localById = new Map(locals.filter(owned).map(row => [row.attemptId, row])), remoteById = new Map<string, LearningAttempt>();
        for (const row of remotes.filter(owned)) {
            const old = remoteById.get(row.attemptId);
            if (!old || old.revision < row.revision)
                remoteById.set(row.attemptId, row);
        }
        const candidates: LearningAttempt[] = [];
        for (const id of new Set([...localById.keys(), ...remoteById.keys()])) {
            const row = await choose(localById.get(id) ?? null, remoteById.get(id) ?? null, queued);
            if (row && eligible(row)) {
                known.set(id, structuredClone(row));
                candidates.push(row);
            }
        }
        candidates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.attemptId.localeCompare(b.attemptId));
        const result: NonWordPendingOriginal[] = new Array(candidates.length);
        let next = 0;
        const worker = async () => {
            while (next < candidates.length) {
                const index = next++;
                result[index] = await describe(candidates[index]);
            }
        };
        await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, worker));
        return result.filter(row => row.capability !== 'not-nonword');
    }
    async function readCurrent(id: string, cached: boolean): Promise<LearningAttempt> {
        attemptId(id);
        const local = await repository.read(id), queued = await queuedIds();
        let remote: LearningAttempt | null = null;
        if (local && !owned(local))
            throw Error('pending-attempt-scope');
        if (cloud)
            try {
                remote = await cloud.read(id);
            }
            catch (error) {
                notice = unavailableNotice(error);
            }
        const attempt = await choose(local, remote, queued) ?? (cached ? known.get(id) : null) ?? null;
        if (!attempt || !owned(attempt) || attempt.attemptId !== id)
            throw Error('pending-attempt-scope-or-unavailable');
        return structuredClone(attempt);
    }
    async function readLatest(id: string): Promise<LearningAttempt> {
        const latest = await readCurrent(id, false);
        if (conflicts.has(id))
            throw Error('另一设备的作答发生冲突；原作答保留，尚未生成新成绩。');
        return latest;
    }
    return {
        list: async () => (await listDetailed()).map(row => row.attempt), listDetailed, notice: () => notice, readLatest,
        async loadStepOriginal(id: string): Promise<NonWordPendingOriginal> {
            const attempt = await readCurrent(id, false);
            if (attempt.parentAttemptId !== null || (attempt.checkpoint.purpose ?? 'first') !== 'first'
                || attempt.checkpoint.mode !== 'calculation' || !attempt.submitted || attempt.attemptId.startsWith('nw-round:'))
                throw Error('pending-step-not-first-original');
            return describe(attempt);
        },
        async loadOriginal(id: string): Promise<NonWordPendingOriginal> {
            const attempt = await readCurrent(id, true);
            if (!eligible(attempt))
                throw Error('pending-attempt-not-first-pending');
            return describe(attempt);
        },
    };
}
