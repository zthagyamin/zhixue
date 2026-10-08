import type { AttemptBinding, AttemptCheckpoint, AttemptEvaluation, AttemptMutation, AttemptReceipt, LearningAttempt } from '../../domain/learning-attempt';
import type { NonWordOutcome } from './index';
export interface AttemptRepository {
    read(id: string): Promise<LearningAttempt | null>;
    mutate(mutation: AttemptMutation): Promise<AttemptReceipt>;
}
type Mode = NonNullable<AttemptCheckpoint['mode']>;
type Options = {
    repository: AttemptRepository;
    binding: AttemptBinding;
    attemptId: string;
    formalEventId: string;
    mode: Mode;
    purpose?: 'first' | 'guided' | 'remediation';
    parentAttemptId?: string;
    intent?: 'review' | 'learn';
    now: () => string;
    newId: () => string;
    fingerprint: (input: unknown) => Promise<string>;
    evaluationFingerprint: (input: Extract<AttemptEvaluation, {
        status: 'resolved';
    }>) => Promise<string>;
};
/** Serial application use case. The repository owns durability; the original writer owns grades. */
export function createNonWordSession(options: Options) {
    let state: LearningAttempt | null = null, queue: Promise<unknown> = Promise.resolve(), revision = 0;
    const listeners = new Set<() => void>();
    const notify = () => {
        revision++;
        for (const listener of listeners)
            try {
                listener();
            }
            catch { /* A view cannot revoke an acknowledged write. */ }
    };
    const serial = <T>(operation: () => Promise<T>): Promise<T> => { const result = queue.then(operation); queue = result.catch(() => { }); return result; };
    const checkpoint = (phase: AttemptCheckpoint['phase'], fields: Record<string, string> = {}, traversed = false): AttemptCheckpoint => ({
        ...state?.checkpoint, phase, position: 0, traversed, mode: options.mode, intent: state?.checkpoint.intent ?? (options.intent === 'learn' ? 'lesson' : 'practice'), purpose: options.purpose ?? 'first', pluginFields: fields,
        visited: traversed ? [options.binding.itemKey] : [], pending: traversed && state?.evaluation.status === 'pending' ? [options.binding.itemKey] : [], skipped: [],
    });
    async function apply(change: Record<string, unknown>): Promise<LearningAttempt> {
        const mutation = { schemaVersion: 1, operationId: options.newId(), attemptId: options.attemptId, binding: options.binding, expectedRevision: state?.revision ?? 0, updatedAt: options.now(), ...change } as AttemptMutation;
        let receipt: AttemptReceipt;
        try {
            receipt = await options.repository.mutate(mutation);
        }
        catch (error) {
            // A lost local receipt must converge on the exact accepted operation, not create another one.
            const saved = await options.repository.read(options.attemptId).catch(() => null);
            const fingerprint = await options.fingerprint(mutation);
            if (!saved?.operations.some(operation => operation.operationId === mutation.operationId && operation.fingerprint === fingerprint))
                throw error;
            state = saved;
            notify();
            return saved;
        }
        if (!receipt.durable || receipt.status === 'conflict' || !receipt.attempt)
            throw Error('另一设备已修改这份作答。当前输入已保留，请核对后恢复。');
        state = receipt.attempt;
        notify();
        return state;
    }
    const open = () => serial(async () => {
        state = await options.repository.read(options.attemptId);
        if (state && await options.fingerprint(state.binding) !== await options.fingerprint(options.binding))
            throw Error('作答来源或版本已变化，不能套用原评价。');
        if (!state)
            await apply({ kind: 'checkpoint', answer: '', checkpoint: checkpoint('answering'), parentAttemptId: options.parentAttemptId ?? null });
        notify();
        return state!;
    });
    const updateView = (patch: Pick<AttemptCheckpoint, 'view' | 'intent' | 'activeSeconds' | 'targetMinutes'>) => serial(async () => {
        if (!state)
            throw Error('作答尚未恢复。');
        const next = { ...state.checkpoint, ...patch };
        if (await options.fingerprint(next) === await options.fingerprint(state.checkpoint))
            return state;
        return apply({ kind: 'checkpoint', answer: state.answer, checkpoint: next, parentAttemptId: state.parentAttemptId });
    });
    const save = (answer: string, fields: Record<string, string> = {}, phase: AttemptCheckpoint['phase'] = 'answering') => serial(async () => {
        if (!state)
            throw Error('作答尚未恢复。');
        // UI recovery fields may evolve; the first submitted answer cannot.
        const nextAnswer = state.submitted ? state.answer : answer, nextCheckpoint = checkpoint(phase, fields, state.checkpoint.traversed);
        if (nextAnswer === state.answer && await options.fingerprint(nextCheckpoint) === await options.fingerprint(state.checkpoint))
            return state;
        return apply({ kind: 'checkpoint', answer: nextAnswer, checkpoint: nextCheckpoint, parentAttemptId: state.parentAttemptId });
    });
    const submit = (answer: string, assistance: 'observed' | 'unknown' = 'unknown', observation: {
        maxPreHintLevel?: 0 | 1 | 2 | 3;
        answerRevealed?: boolean;
    } = {}) => serial(async () => {
        if (!state)
            throw Error('作答尚未恢复。');
        if (state.submitted) {
            if (state.submitted.answer !== answer)
                throw Error('首轮答案已保存。修改后的答案请作为补练保留。');
            return state;
        }
        if (state.answer !== answer)
            await apply({ kind: 'checkpoint', answer, checkpoint: checkpoint('answering', state.checkpoint.pluginFields), parentAttemptId: state.parentAttemptId });
        return apply({ kind: 'submit', answerRevision: state.answerRevision, assistance, ...observation });
    });
    const assess = (outcome: NonWordOutcome) => serial(async () => {
        if (!state?.submitted)
            throw Error('请先可靠保存首轮答案。');
        if (outcome.status === 'undetermined')
            return apply({ kind: 'evaluate', answerRevision: state.answerRevision, evaluation: { status: 'pending', reason: 'invalid', feedback: outcome.explanation } });
        const rating = outcome.rating ?? (outcome.status === 'correct' ? 'good' : outcome.status === 'partial' ? 'hard' : 'again');
        const evaluation: Extract<AttemptEvaluation, {
            status: 'resolved';
        }> = { status: 'resolved', rating, correct: outcome.status === 'correct', outcome: outcome.status, source: outcome.source, feedback: outcome.explanation, referenceHash: options.binding.contentHash, evaluationHash: '' };
        evaluation.evaluationHash = await options.evaluationFingerprint(evaluation);
        if (state.evaluation.status === 'resolved') {
            if (state.evaluation.evaluationHash !== evaluation.evaluationHash)
                throw Error('首轮已有核对结果，不能静默覆盖。');
            return state;
        }
        return apply({ kind: 'evaluate', answerRevision: state.answerRevision, evaluation });
    });
    const pending = (reason: 'offline' | 'invalid' | 'no-reference', feedback?: string) => serial(async () => {
        if (!state?.submitted)
            throw Error('答案尚未可靠保存，不能继续。');
        if (state.evaluation.status === 'resolved')
            throw Error('已有正式核对结果，不能改成未知。');
        return apply({ kind: 'evaluate', answerRevision: state.answerRevision, evaluation: { status: 'pending', reason, ...(feedback === undefined ? {} : { feedback }) } });
    });
    const traversePending = () => serial(async () => {
        if (!state?.submitted)
            throw Error('答案尚未可靠保存，不能继续。');
        if (state.evaluation.status !== 'pending')
            throw Error('没有已保存的待核对答案。');
        await apply({ kind: 'checkpoint', answer: state.answer, checkpoint: checkpoint('submitted', state.checkpoint.pluginFields, true), parentAttemptId: state.parentAttemptId });
    });
    const reserve = (rating: 'again' | 'hard' | 'good' | 'easy') => serial(async () => {
        if (!state?.submitted || state.evaluation.status !== 'resolved')
            throw Error('本次作答仍待核对，不能产生正式成绩。');
        if (state.formal) {
            if (state.formal.rating !== rating)
                throw Error('本次正式成绩已固定，不能更换评级。');
            return { eventId: state.formal.eventId, reviewedAt: state.formal.occurredAt };
        }
        await apply({ kind: 'claim-formal', eventId: options.formalEventId, occurredAt: state.submitted.submittedAt, evaluationHash: state.evaluation.evaluationHash, rating });
        return { eventId: state!.formal!.eventId, reviewedAt: state!.formal!.occurredAt };
    });
    const link = (coreHash: string) => serial(async () => {
        if (!state?.formal)
            throw Error('正式作答尚未认领。');
        if (state.formal.status === 'linked')
            return state;
        return apply({ kind: 'link-formal', eventId: state.formal.eventId, coreHash });
    });
    const markTraversed = () => serial(async () => {
        if (state?.formal?.status !== 'linked')
            throw Error('正式结果尚未取得持久回执。');
        return apply({ kind: 'checkpoint', answer: state.answer, checkpoint: checkpoint('feedback', state.checkpoint.pluginFields, true), parentAttemptId: state.parentAttemptId });
    });
    const markAuxiliaryTraversed = () => serial(async () => {
        if (!state?.submitted || state.evaluation.status !== 'resolved' || !['guided', 'remediation'].includes(state.checkpoint.purpose ?? ''))
            throw Error('辅助尝试尚未可靠核对。');
        return apply({ kind: 'checkpoint', answer: state.answer, checkpoint: checkpoint('feedback', state.checkpoint.pluginFields, true), parentAttemptId: state.parentAttemptId });
    });
    return { open, save, updateView, submit, assess, pending, traversePending, reserve, link, markTraversed, markAuxiliaryTraversed,
        snapshot: () => state ? structuredClone(state) : null, flush: () => queue,
        subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); }, getSnapshot: () => revision,
    };
}
