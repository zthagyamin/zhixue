import type { NonWordHostScope } from '../../application/nonword-study';
import type { LocalAttemptOptions } from '../../application/learning-attempt';
import type { AttemptCheckpoint, LearningAttempt } from '../../domain/learning-attempt';
// @ts-expect-error TS5097: standalone Node contracts.
import { createNonWordSession } from '../../application/nonword-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { createLocalAttemptRepository, createAccountAttemptClient, attemptFingerprint, evaluationFingerprint } from '../learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createContinuationCoordinator, type ContinuationGroup} from '../../application/nonword-study/index.ts';
export type NonWordMode = 'recall' | 'quiz' | 'code' | 'calculation' | 'flashcard';
export type NonWordRuntime = Awaited<ReturnType<typeof createNonWordRuntime>>;
/** Composition adapter. It has no model, scheduling or formal event-writing port. */
export async function createNonWordRuntime(scope: NonWordHostScope, mode: NonWordMode, options: LocalAttemptOptions & {
    purpose?: 'first' | 'guided' | 'remediation';
    parentAttemptId?: string;
    intent?: 'review' | 'learn';
    instanceId?: string;
    existing?: LearningAttempt;
    binding?: LearningAttempt['binding'];
    navigationGroup?:ContinuationGroup;
    continuationMode?:'group'|'direct';
} = {}) {
    if (options.existing && (options.existing.binding.ownerId !== scope.ownerId || options.existing.binding.libraryId !== scope.libraryId || options.existing.binding.itemKey !== scope.itemKey || options.existing.binding.contentHash !== scope.contentHash || options.existing.binding.snapshotId !== scope.snapshotId || options.existing.checkpoint.mode !== mode || options.existing.parentAttemptId || (options.existing.checkpoint.purpose ?? 'first') !== 'first'))
        throw Error('原始作答身份或版本不匹配。');
    if (options.binding && (options.binding.ownerId !== scope.ownerId || options.binding.libraryId !== scope.libraryId || options.binding.itemKey !== scope.itemKey || options.binding.snapshotId !== scope.snapshotId || options.binding.contentHash !== scope.contentHash))
        throw Error('恢复作答的来源不匹配。');
    const groupId = options.binding?.groupId ?? options.existing?.binding.groupId ?? await attemptFingerprint(scope.groupId), roundId = options.binding?.roundId ?? options.existing?.binding.roundId ?? await attemptFingerprint(scope.roundId);
    const binding = { ownerId: scope.ownerId, libraryId: scope.libraryId, snapshotId: scope.snapshotId, itemKey: scope.itemKey, contentHash: scope.contentHash, groupId, roundId };
    const purpose = options.purpose ?? 'first';
    const id = options.existing?.attemptId ?? `nw:${await attemptFingerprint([binding, mode, purpose, options.parentAttemptId ?? null, options.instanceId ?? null])}`;
    const formalEventId = options.existing?.formal?.eventId ?? `nw:${await attemptFingerprint([binding, 'formal-first'])}`;
    const repository = createLocalAttemptRepository({ userId: scope.ownerId, libraryId: scope.libraryId }, options);
    const cloud = scope.cloud ? createAccountAttemptClient({ ownerId: scope.ownerId, libraryId: scope.libraryId }) : null;
    const session = createNonWordSession({ repository, binding, attemptId: id, formalEventId, mode, purpose, parentAttemptId: options.parentAttemptId, intent: options.intent,
        now: () => new Date().toISOString(), newId: () => crypto.randomUUID(), fingerprint: attemptFingerprint, evaluationFingerprint });
    let syncNotice = '', syncJob: Promise<void> | null = null;
    const statusListeners = new Set<() => void>();
    const sync = async () => {
        if (!cloud)
            return;
        const result = await repository.sync(cloud);
        syncNotice = result.conflict ? '另一设备的作答发生冲突；本机答案保留，尚未覆盖。' : result.unsupported ? '当前服务尚不支持答案同步；本机答案保留。' : result.pending ? '答案已保存在本机，等待账号同步。' : '';
    };
    if (cloud) {
        await sync();
        try {
            await repository.refresh(cloud);
        }
        catch {
            syncNotice = '账号恢复暂不可用；继续使用本机已保存的答案。';
        }
    }
    if (options.existing && !await repository.read(id))
        await repository.hydrate(options.existing);
    await session.open();
    const continuations=createContinuationCoordinator({repository,fingerprint:attemptFingerprint,now:()=>new Date().toISOString(),newId:()=>crypto.randomUUID()});
    const frozenBoundary=purpose==='first'?await continuations.associate(session.snapshot()!,options.navigationGroup):'initial';
    const publicSession=purpose==='first'&&options.continuationMode!=='group'?{...session,
        async markTraversed(){const result=await session.markTraversed();await continuations.append(session.snapshot()!,frozenBoundary);return result;},
        async traversePending(){const result=await session.traversePending();await continuations.append(session.snapshot()!,frozenBoundary);return result;},
    }:session;
    const scheduleSync = () => {
        if (!syncJob)
            syncJob = sync().finally(() => {
                syncJob = null;
                for (const listener of statusListeners)
                    try {
                        listener();
                    }
                    catch { /* UI listeners cannot revoke a sync receipt. */ }
            });
        return syncJob;
    };
    return { session:publicSession, continuationBoundary:purpose==='first'?frozenBoundary:undefined, repository, cloud, scope, mode, purpose, sync,
        subscribeStatus(listener: () => void) { statusListeners.add(listener); return () => { statusListeners.delete(listener); }; },
        async groupSeconds() { return (await repository.list()).filter(row => row.binding.groupId === groupId && row.binding.roundId === roundId && row.attemptId !== id).reduce((sum, row) => sum + (row.checkpoint.activeSeconds ?? 0), 0); },
        async status() {
            const attempt = session.snapshot(), savedStatus = await repository.status(id);
            if (savedStatus === 'cloud-conflict')
                return '另一设备有不同作答或正式结果；本机答案保留，尚未覆盖。';
            if (!attempt?.submitted && !attempt?.answer && !Object.keys(attempt?.checkpoint.pluginFields ?? {}).length)
                return '草稿已就绪，输入后自动保存。';
            return savedStatus === 'cloud-acked' ? '答案已保存并同步到账号。' : syncNotice || '答案已保存在本机。';
        },
        async afterWrite() { void scheduleSync().catch(() => { }); },
        async synchronize() {
            await scheduleSync();
            if (cloud && (await repository.pending()).some(row => row.mutation.attemptId === id))
                await scheduleSync();
            if (await repository.status(id) === 'cloud-conflict')
                throw Error('另一设备已有不同作答或正式结果；本机答案保留，未重复提交成绩。');
        },
        async hydrateReference() {
            if (!cloud)
                return null;
            try {
                const item = await cloud.reference(id);
                await repository.rememberReference(id, item);
                return item;
            }
            catch {
                return repository.reference(id);
            }
        },
    };
}
/** Explicit recovery projection; never serialize the entire page draft store. */
export function recoveryFields(mode: NonWordMode, values: Record<string, unknown>): Record<string, string> {
    if (mode === 'quiz')
        return { selection: JSON.stringify(values.nonwordQuizState ?? null), phase: String((values.nonwordQuizState as {
                phase?: unknown;
            } | undefined)?.phase ?? 'answer') };
    if (mode === 'code')
        return { code: String(values.code ?? ''), stdin: String(values.stdin ?? ''), phase: String(values.codeState ?? 'coding'), firstRunKind: String(values.firstRunKind ?? 'not-run'), firstNeedsReview: String(values.firstNeedsReview ?? false) };
    if (mode === 'calculation')
        return { value: String(values.value ?? ''), phase: values.result ? 'feedback' : 'answer' };
    if (mode === 'flashcard')
        return { isFlipped: String(values.isFlipped ?? false), flashcardRating: String(values.flashcardRating ?? '') };
    const policy = values.recallAttempt as {
        attemptId?: string;
        maxPreHintLevel?: number;
    } | undefined;
    return { ...(policy?.attemptId && Number.isInteger(policy.maxPreHintLevel) ? { hintLevel: String(policy.maxPreHintLevel), policyAttemptId: policy.attemptId } : {}), answer: String(values.answer ?? ''), revealed: String(values.revealed ?? false), phase: values.recallForgotten ? 'forgotten' : values.result ? 'feedback' : 'answer' };
}
export function rawAnswer(mode: NonWordMode, values: Record<string, unknown>): string {
    if (mode === 'code')
        return String(values.firstTestCode || values.code || '');
    if (mode === 'calculation')
        return String(values.value ?? '');
    if (mode === 'quiz')
        return JSON.stringify((values.nonwordQuizState as {
            first?: {
                selection?: unknown;
            };
            selection?: unknown;
        } | undefined)?.first?.selection ?? (values.nonwordQuizState as {
            selection?: unknown;
        } | undefined)?.selection ?? []);
    return String(values.answer ?? '');
}
export function restoredFields(attempt: LearningAttempt, mode: NonWordMode): Record<string, unknown> {
    const fields = attempt.checkpoint.pluginFields ?? {}, evaluation = attempt.evaluation;
    if (mode === 'quiz') {
        if (!fields.selection)
            return {};
        try {
            const state = JSON.parse(fields.selection);
            return state && Array.isArray(state.selection) && ['answer', 'feedback', 'retry', 'retry-feedback'].includes(state.phase) ? { nonwordQuizState: state } : {};
        }
        catch {
            return {};
        }
    }
    if (mode === 'code')
        return { ...(fields.code !== undefined || attempt.answer ? { code: fields.code ?? attempt.answer } : {}), stdin: fields.stdin ?? '', codeState: fields.phase ?? 'coding', firstTestCode: attempt.submitted?.answer ?? '', firstTestOutput: evaluation.feedback ?? '', firstRunKind: fields.firstRunKind ?? (evaluation.status === 'resolved' ? (evaluation.correct ? 'correct' : 'incorrect') : attempt.submitted ? 'pending' : 'not-run'), firstNeedsReview: fields.firstNeedsReview === 'true' || Boolean(attempt.submitted && evaluation.status === 'pending') };
    if (mode === 'flashcard')
        return { isFlipped: fields.isFlipped === 'true', flashcardSaved: evaluation.status === 'resolved' && (attempt.checkpoint.purpose !== 'first' || attempt.formal?.status === 'linked'), flashcardRating: evaluation.status === 'resolved' ? evaluation.rating : ['again', 'hard', 'good', 'easy'].includes(fields.flashcardRating) ? fields.flashcardRating : null };
    const result = evaluation.status === 'resolved' ? { correct: evaluation.correct, verdict: evaluation.outcome === 'correct' ? 'correct' : evaluation.outcome === 'partial' ? 'partial' : 'incorrect', rating: evaluation.rating, source: evaluation.source === 'model' ? 'ai' : evaluation.source, feedback: evaluation.feedback, explanation: evaluation.feedback } : null;
    if (mode === 'calculation')
        return { value: fields.value ?? attempt.submitted?.answer ?? attempt.answer, result: result ?? (attempt.submitted ? { correct: null, explanation: evaluation.feedback ?? '答案已保存，等待核对。' } : null) };
    const hintLevel = attempt.submitted?.maxPreHintLevel ?? (fields.hintLevel !== undefined ? Number(fields.hintLevel) : undefined);
    return { ...(fields.policyAttemptId && hintLevel !== undefined ? { recallAttempt: { schemaVersion: 1, attemptId: fields.policyAttemptId, maxPreHintLevel: hintLevel } } : {}), answer: fields.answer ?? attempt.submitted?.answer ?? attempt.answer, revealed: Boolean(result) || fields.phase === 'forgotten', recallForgotten: fields.phase === 'forgotten', result, recallSelectedRating: result?.rating ?? null, nonwordPending: attempt.submitted && evaluation.status === 'pending' ? evaluation.feedback ?? '原答案已保存，可恢复核对。' : '' };
}
export function evaluationPhase(attempt: LearningAttempt | null): AttemptCheckpoint['phase'] {
    return attempt?.evaluation.status === 'resolved' ? 'feedback' : attempt?.submitted ? 'submitted' : 'answering';
}
// @ts-expect-error TS5097: standalone Node contracts.
export { createNonWordRoundRuntime } from './round-runtime.ts';
// @ts-expect-error TS5097: standalone Node contracts.
export { createNonWordPendingRuntime } from './pending-runtime.ts';
export type { NonWordPendingOptions, NonWordPendingOriginal } from './pending-runtime';
// @ts-expect-error TS5097: standalone Node contracts.
export { cacheOriginalPendingBundle } from './original-bundle.ts';
