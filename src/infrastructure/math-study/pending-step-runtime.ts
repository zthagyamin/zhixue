import type { LearningAttempt } from '../../domain/learning-attempt';
import type { CalculationSupport } from '../../domain/content';
import type { NativeMathTransport } from '../../domain/math-study';
import type { PracticeEvidenceV1 } from '../../domain/practice-evidence';
import type { PracticeEvidencePage } from '../../application/practice-evidence';
import type { NonWordPendingOptions, NonWordPendingOriginal } from '../nonword-study';
// @ts-expect-error TS5097: standalone Node contracts.
import { createNonWordPendingRuntime, createNonWordRuntime } from '../nonword-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { createLocalAttemptRepository } from '../learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { createLocalPracticeEvidenceRepository, createAccountPracticeEvidenceClient, createAccountMathClient } from '../practice-evidence/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { parsePracticeEvidence, evidenceEqual, validatePracticeEvidenceAuthority } from '../../domain/practice-evidence/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { attachAccountMathDriver } from './account-host-runtime.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import { nativeMathTask, attachNativeMathDriver } from './native-host-runtime.ts';

export type {PendingMathStep,PendingMathStepPage} from '../../application/math-study';
import type {PendingMathStep,PendingMathStepPage} from '../../application/math-study';
type EvidenceReader = {
    listSavedDrafts(): Promise<PracticeEvidenceV1[]>;
    listSavedStepDrafts?():Promise<readonly {record:PracticeEvidenceV1;diagnosticInvalid:boolean}[]>;
    pending(): Promise<readonly { mutation: { attemptId: string } }[]>;
    status(id: string): Promise<string | null>;
};
type EvidenceCloud = {
    listPage(page?: { cursor?: string; limit?: number }): Promise<PracticeEvidencePage>;
    read(id: string): Promise<PracticeEvidenceV1 | null>;
};
export type PendingMathStepOptions = NonWordPendingOptions & {
    workspaceId: string;
    current?: () => boolean;
    nativeMath?: NativeMathTransport;
    evidence?: EvidenceReader;
    evidenceCloud?: EvidenceCloud | null;
    maxPages?: number;
};
const conflictNotice = '另一设备的步骤或原作答发生冲突；本机内容保留，暂不能核对。';
const sourceNotice = '原题参考暂不可用；步骤原文保留，未使用当前新版本参考。';
const frozen = (attempt: LearningAttempt) => ({ binding: attempt.binding, submitted: attempt.submitted,
    answerRevision: attempt.answerRevision, answer: attempt.answer, parentAttemptId: attempt.parentAttemptId,
    mode: attempt.checkpoint.mode, purpose: attempt.checkpoint.purpose, evaluation: attempt.evaluation, formal: attempt.formal });
const supportOf = (original: NonWordPendingOriginal): CalculationSupport | undefined => {
    const support = original.nativeMathCapture?.item.learningSupport ?? original.item?.learningSupport;
    return support?.type === 'calculation' ? support : undefined;
};
/** Independent read-only list and an explicit step-only capability. No grade, event or FSRS writer. */
export function createPendingMathStepRuntime(options: PendingMathStepOptions) {
    const scope = { ownerId: options.ownerId, libraryId: options.libraryId };
    const attempts = options.repository ?? createLocalAttemptRepository({ userId: options.ownerId, libraryId: options.libraryId });
    const originals = createNonWordPendingRuntime({ ...options, repository: attempts });
    const evidence = options.evidence ?? createLocalPracticeEvidenceRepository(scope, { readAttempt: id => attempts.read(id) });
    const cloud = options.cloud ? options.evidenceCloud ?? createAccountPracticeEvidenceClient(scope) : null;
    const maxPages = Math.max(1, Math.min(20, options.maxPages ?? 10));
    const live = (signal?: AbortSignal) => { signal?.throwIfAborted(); if (options.current?.() === false) throw Error('资料库或用户已切换；原步骤保留。'); };
    const owned = (record: PracticeEvidenceV1) => record.binding.ownerId === options.ownerId && record.binding.libraryId === options.libraryId;
    async function describe(raw: PracticeEvidenceV1, conflict = false, diagnosticInvalid = false): Promise<PendingMathStep | null> {
        const record = parsePracticeEvidence(raw);
        if (!owned(record) || record.variant || !record.calculation?.stepInput.text.trim()) return null;
        const original = await originals.loadStepOriginal(record.attemptId);
        if (!evidenceEqual(original.attempt.binding, record.binding)) throw Error('pending-step-evidence-original-binding');
        const support = supportOf(original), step = support?.schemaVersion === 2 ? support.step : undefined;
        const diagnostic = record.calculation.diagnostic;
        let invalid = diagnosticInvalid || Boolean(diagnostic && (diagnostic.answerRevision !== original.attempt.submitted?.answerRevision
            || diagnostic.stepRevision !== record.calculation.stepInput.revision || diagnostic.sourceVersion !== record.binding.contentHash
            || step && diagnostic.stepId !== step.stepId));
        if (support && original.referenceVerified) {
            try { await validatePracticeEvidenceAuthority(record, { attempt: original.attempt, source: { binding: original.attempt.binding, calculation: support } }); }
            catch { invalid = true; }
        }
        if (!invalid && !conflict && original.capability !== 'conflict' && diagnostic && diagnostic.status !== 'undetermined') return null;
        const native = original.nativeMathCapture?.item, item = original.item;
        const available = original.resumable && original.referenceVerified && Boolean(step) && !invalid && !conflict;
        return { original, evidence: record, title: item?.title ?? native?.itemKey.slice('practice:'.length) ?? '原计算题',
            sourceLabel: native?.practice.sourceLabel ?? (item?.kind === 'practice' ? item.practice.sourceLabel : ''),
            prompt: native?.practice.prompt ?? (item?.kind === 'practice' ? item.practice.prompt : ''),
            stepPrompt: step?.prompt ?? '', stepText: record.calculation.stepInput.text,
            ...(diagnostic ? { diagnostic } : {}), canEvaluate: available,
            notice: diagnosticInvalid ? '已保存的步骤诊断损坏；原步骤保留，暂不能重新核对。' : conflict || original.capability === 'conflict' ? conflictNotice : invalid ? '步骤核对版本不匹配；原文保留，暂不能重新核对。'
                : !available ? original.notice || sourceNotice : original.attempt.formal?.status==='linked'?'步骤待核对，原最终成绩已保留。':'步骤待核对，原最终答案已保存。' };
    }
    async function list(): Promise<PendingMathStepPage> {
        live();
        const projections = evidence.listSavedStepDrafts ? await evidence.listSavedStepDrafts() : (await evidence.listSavedDrafts()).map(record=>({record,diagnosticInvalid:false}));
        const invalidDiagnostics=new Set(projections.filter(row=>row.diagnosticInvalid).map(row=>row.record.attemptId));
        const local = projections.map(row=>row.record), queued = new Set((await evidence.pending()).map(row => row.mutation.attemptId));
        const records = new Map(local.filter(owned).map(row => [row.attemptId, row])), conflicts = new Set<string>();
        for (const row of local) if (await evidence.status(row.attemptId) === 'cloud-conflict') conflicts.add(row.attemptId);
        let complete = true, notice = '';
        if (cloud) {
            try {
                let cursor: string | undefined;
                for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
                    const page = await cloud.listPage({ ...(cursor ? { cursor } : {}), limit: 200 }); live();
                    for (const raw of page.records) {
                        const remote = parsePracticeEvidence(raw); if (!owned(remote)) continue;
                        const old = records.get(remote.attemptId);
                        if (old && (!evidenceEqual(old.binding, remote.binding)
                            || !evidenceEqual(old.calculation?.stepInput, remote.calculation?.stepInput)
                            || old.calculation?.diagnostic && old.calculation.diagnostic.status !== 'undetermined' && !evidenceEqual(old.calculation.diagnostic, remote.calculation?.diagnostic)
                            || old.operations.some((operation, index) => index < remote.operations.length && !evidenceEqual(operation, remote.operations[index])))) conflicts.add(remote.attemptId);
                        if (!old || !queued.has(remote.attemptId) && !conflicts.has(remote.attemptId) && !invalidDiagnostics.has(remote.attemptId) && remote.revision > old.revision) records.set(remote.attemptId, remote);
                    }
                    if (page.complete) { complete = true; break; }
                    complete = false;
                    if (!page.nextCursor || page.nextCursor === cursor) throw Error('pending-step-pagination');
                    cursor = page.nextCursor;
                }
                if (!complete) notice = '账号步骤列表尚未完整读取；已显示已核对来源的部分记录。';
            } catch { complete = false; notice = '账号步骤列表尚未完整恢复；本机原文保留，可稍后重试。'; }
        }
        const rows: PendingMathStep[] = [];
        for (const record of records.values()) {
            try { const row = await describe(record, conflicts.has(record.attemptId), invalidDiagnostics.has(record.attemptId)); if (row) rows.push(row); }
            catch { complete = false; notice ||= '部分原步骤身份尚未可靠恢复，未使用猜测的来源。'; }
        }
        live(); rows.sort((a, b) => b.evidence.updatedAt.localeCompare(a.evidence.updatedAt) || a.evidence.attemptId.localeCompare(b.evidence.attemptId));
        return { rows, complete, notice };
    }
    async function load(id: string): Promise<PendingMathStep | null> {
        const projections=evidence.listSavedStepDrafts?await evidence.listSavedStepDrafts():(await evidence.listSavedDrafts()).map(record=>({record,diagnosticInvalid:false}));
        const projection=projections.find(row=>row.record.attemptId===id),local=projection?.record;
        let record = local, conflict = await evidence.status(id) === 'cloud-conflict';
        if (cloud) {
            const remote = await cloud.read(id);
            if (remote) {
                const parsed = parsePracticeEvidence(remote); if (!owned(parsed) || parsed.attemptId !== id) throw Error('pending-step-scope');
                const queued = (await evidence.pending()).some(row => row.mutation.attemptId === id);
                if (local && (!evidenceEqual(local.binding, parsed.binding) || !evidenceEqual(local.calculation?.stepInput, parsed.calculation?.stepInput)
                    || local.operations.some((op, index) => index < parsed.operations.length && !evidenceEqual(op, parsed.operations[index]))
                    || local.calculation?.diagnostic && local.calculation.diagnostic.status !== 'undetermined' && !evidenceEqual(local.calculation.diagnostic, parsed.calculation?.diagnostic))) conflict = true;
                if (!local || !queued && !conflict && !projection?.diagnosticInvalid && parsed.revision > local.revision) record = parsed;
            }
        }
        live(); return record ? describe(record, conflict,projection?.diagnosticInvalid??false) : null;
    }
    async function evaluate(row: PendingMathStep, signal?: AbortSignal) {
        live(signal);
        const latest = await load(row.evidence.attemptId); live(signal);
        if (!latest) return null; // Another device may have completed this exact step.
        if (!latest.canEvaluate) throw Error(latest.notice);
        if (!evidenceEqual(frozen(row.original.attempt), frozen(latest.original.attempt))
            || !evidenceEqual(row.evidence.calculation?.stepInput, latest.evidence.calculation?.stepInput)) throw Error('原作答或步骤版本已经改变；请重新打开保存的步骤。');
        if (row.original.nativeMathCapture?.captureId !== latest.original.nativeMathCapture?.captureId
            || !evidenceEqual(row.original.snapshot, latest.original.snapshot) || !evidenceEqual(row.original.item, latest.original.item))
            throw Error('原步骤来源版本已经改变；请重新打开保存的步骤。');
        const original = latest.original, attempt = original.attempt;
        const frozenScope = { workspaceId: options.workspaceId, ...attempt.binding, cloud: Boolean(options.cloud),
            ...(original.nativeMathCapture ? { nativeMathIdentity: original.nativeMathCapture.identity, nativeMathCapture: original.nativeMathCapture } : {}) };
        const runtime = await createNonWordRuntime(frozenScope, 'calculation', { existing: attempt, binding: attempt.binding });
        live(signal);
        const resolver = async (saved: LearningAttempt) => evidenceEqual(saved.binding, attempt.binding) && supportOf(original)
            ? { binding: saved.binding, calculation: supportOf(original) } : null;
        const details = createLocalPracticeEvidenceRepository(scope, { readAttempt: id => runtime.repository.read(id), resolveSource: resolver });
        await details.hydrate(latest.evidence);
        if (!evidenceEqual((await details.read(attempt.attemptId))?.calculation?.stepInput, latest.evidence.calculation?.stepInput)
            || await details.status(attempt.attemptId) === 'cloud-conflict') throw Error(conflictNotice);
        const driver = { runtime, restore: () => ({}), fields: () => ({}), answer: () => attempt.submitted!.answer,
            phase: () => 'feedback' as const };
        const nativeTransport = options.nativeMath ? {...options.nativeMath,
            async evaluate(request:Parameters<NativeMathTransport['evaluate']>[0],requestSignal?:AbortSignal){
                live(requestSignal);const receipt=await options.nativeMath!.evaluate(request,requestSignal);live(requestSignal);return receipt;
            }} : undefined;
        const accountEvaluate = createAccountMathClient(scope);
        const attached = original.nativeMathCapture
            ? await attachNativeMathDriver(driver, runtime, (await nativeMathTask(frozenScope, 'first', undefined, nativeTransport))!, nativeTransport)
            : original.item && original.snapshot ? await attachAccountMathDriver(driver, runtime, { item: original.item, snapshot: original.snapshot },{async evaluate(request,requestSignal){
                live(requestSignal);const receipt=await accountEvaluate(request,requestSignal);live(requestSignal);return receipt;
            }}) : null;
        live(signal);
        if (!attached?.runtime.practice.calculation) throw Error(sourceNotice);
        const result = await attached.runtime.practice.calculation.evaluate('step', signal); live(signal);
        const after = await runtime.repository.read(attempt.attemptId);
        if (!after || !evidenceEqual(frozen(after), frozen(attempt))) throw Error('原最终结果发生变化；步骤反馈未用于改写成绩。');
        return result.step ?? null;
    }
    return { list, load, evaluate };
}
