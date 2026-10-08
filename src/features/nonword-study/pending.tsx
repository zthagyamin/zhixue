'use client';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AttemptBinding, LearningAttempt } from '../../domain/learning-attempt';
import { LearningText } from './text';
export type PendingAnswerSource = {
    attemptId: string;
    binding: Pick<AttemptBinding, 'ownerId' | 'libraryId' | 'snapshotId' | 'itemKey' | 'contentHash'>;
    kind: 'practice' | 'word';
    title: string;
    sourceLabel: string;
    prompt: string;
    reference?: string;
};
/** Application-owned reads and navigation; this feature has no persistence or evaluation service. */
export interface PendingAnswerQueuePort {
    list(): Promise<LearningAttempt[]>;
    notice?:()=>string;
    reference(row: LearningAttempt): Promise<PendingAnswerSource>;
    onResume(row: LearningAttempt): Promise<void>;
}
export type PendingAnswerQueueProps = {
    ownerId: string;
    libraryId: string;
    version?: string | number;
    port: PendingAnswerQueuePort;
    renderMath: (text: string) => ReactNode;
    accountCapability?: 'available' | 'unsupported' | 'offline' | 'local-only';
};
type Scope = {
    ownerId: string;
    libraryId: string;
    version?: string | number;
    port: PendingAnswerQueuePort;
};
type SourceState = {
    state: 'ready';
    value: PendingAnswerSource;
} | {
    state: 'loading';
} | {
    state: 'failed';
    message: string;
};
type Activity = {
    state: 'busy' | 'done';
} | {
    state: 'failed';
    message: string;
};
type Snapshot = {
    scope: Scope;
    sequence: number;
    rows: LearningAttempt[];
    loading: boolean;
    error: string;
    sources: Record<string, SourceState>;
    activities: Record<string, Activity>;
};
const modes = new Set(['quiz', 'recall', 'code', 'calculation', 'flashcard']);
const bindingFields = ['ownerId', 'libraryId', 'snapshotId', 'itemKey', 'contentHash'] as const;
const itemKey = (row: LearningAttempt) => JSON.stringify([row.attemptId, ...bindingFields.map(field => row.binding[field]), row.binding.groupId, row.binding.roundId, row.revision]);
const resumeKey = (row: LearningAttempt) => JSON.stringify([row.binding.ownerId, row.binding.libraryId, row.attemptId]);
function eligible(row: LearningAttempt, scope: Scope): boolean {
    return row?.schemaVersion === 1 && row.binding?.ownerId === scope.ownerId && row.binding.libraryId === scope.libraryId
        && row.parentAttemptId === null && row.checkpoint?.purpose === 'first' && modes.has(row.checkpoint.mode ?? '')
        && !row.attemptId.startsWith('nw-round:') && !row.binding.itemKey.startsWith('word:')
        && (row.submitted ? typeof row.submitted.answer === 'string' && (row.evaluation?.status === 'pending' || row.evaluation?.status === 'resolved' && row.formal?.status !== 'linked')
            : row.formal === null && (typeof row.answer === 'string' && Boolean(row.answer.trim()) || row.checkpoint.view?.paused === true));
}
function verifiedSource(row: LearningAttempt, value: PendingAnswerSource): PendingAnswerSource {
    if (!value || value.attemptId !== row.attemptId || !value.binding
        || bindingFields.some(field => value.binding[field] !== row.binding[field]))
        throw Error('来源身份或内容版本不一致。原回答仍保留，暂不能继续。');
    if (!['practice', 'word'].includes(value.kind) || typeof value.title !== 'string'
        || typeof value.sourceLabel !== 'string' || typeof value.prompt !== 'string' || !value.prompt.trim()
        || value.reference !== undefined && typeof value.reference !== 'string')
        throw Error('原资料的内容尚未完整核对。原回答仍保留。');
    return structuredClone(value);
}
function status(row: LearningAttempt): string {
    if (!row.submitted)
        return '尚未提交 · 草稿已保存，可续学';
    return row.evaluation.status === 'resolved' ? '已核对，正式保存待完成' : '原回答已保存，等待核对';
}
function savedTime(value: string): string {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : value;
}
/** Opens on demand, retaining old-day/source-version work without claiming a score or mastery. */
export function PendingAnswerQueue({ ownerId, libraryId, version, port, renderMath, accountCapability }: PendingAnswerQueueProps) {
    const scope = useMemo<Scope>(() => ({ ownerId, libraryId, version, port }), [ownerId, libraryId, version, port]);
    const current = useRef(scope);
    current.current = scope;
    const live = useRef(true), sequence = useRef(0), actionLocks = useRef(new Map<string, Scope>());
    const [opened, setOpened] = useState<Scope | null>(null);
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    useEffect(() => {
        live.current = true;
        const clock = sequence;
        return () => { live.current = false; clock.current++; };
    }, []);
    const matches = (captured: Scope, request: number) => live.current && current.current === captured && sequence.current === request;
    const shown = snapshot?.scope === scope ? snapshot : null;
    const rows = (shown?.rows ?? []).filter(row => {
        const original = shown?.sources[itemKey(row)];
        return original?.state !== 'ready' || original.value.kind !== 'word';
    });
    const readReference = async (row: LearningAttempt, captured: Scope, request: number) => {
        const key = itemKey(row);
        if (!matches(captured, request))
            return;
        setSnapshot(old => old?.scope === captured && old.sequence === request
            ? { ...old, sources: { ...old.sources, [key]: { state: 'loading' } } } : old);
        let result: SourceState;
        try {
            result = { state: 'ready', value: verifiedSource(row, await captured.port.reference(structuredClone(row))) };
        }
        catch (error) {
            result = { state: 'failed', message: error instanceof Error ? error.message : '原资料暂时不可用。' };
        }
        if (!matches(captured, request))
            return;
        setSnapshot(old => old?.scope === captured && old.sequence === request
            ? { ...old, sources: { ...old.sources, [key]: result } } : old);
    };
    const load = async () => {
        const captured = scope, request = ++sequence.current;
        setSnapshot(old => ({ scope: captured, sequence: request, rows: old?.scope === captured ? old.rows : [],
            sources: old?.scope === captured ? old.sources : {}, activities: {}, loading: true, error: '' }));
        try {
            const provided = await captured.port.list();
            if (!matches(captured, request))
                return;
            if (!Array.isArray(provided))
                throw Error('待核对列表尚未完整读取。');
            const selected = provided.filter(row => eligible(row, captured)).map(row => structuredClone(row));
            setSnapshot({ scope: captured, sequence: request, rows: selected, sources: {}, activities: {}, loading: false, error: captured.port.notice?.()??'' });
            // Reading source material is bounded independently of the amount of saved work.
            let cursor = 0;
            const worker = async () => {
                while (cursor < selected.length && matches(captured, request)) {
                    const row = selected[cursor++];
                    await readReference(row, captured, request);
                }
            };
            await Promise.all(Array.from({ length: Math.min(4, selected.length) }, worker));
        }
        catch (error) {
            if (!matches(captured, request))
                return;
            const message = error instanceof Error && error.message === 'learning-attempts-unsupported'
                ? '当前账号服务尚不支持待核对答案读取，请使用已保存的本机资料。'
                : error instanceof Error ? error.message : '待核对列表暂时无法读取。';
            setSnapshot(old => old?.scope === captured && old.sequence === request ? { ...old, loading: false, error: message } : old);
        }
    };
    const resume = async (row: LearningAttempt) => {
        const captured = scope, request = shown?.sequence, key = itemKey(row), lock = resumeKey(row), original = shown?.sources[key];
        if (request === undefined || !matches(captured, request) || !eligible(row, captured)
            || original?.state !== 'ready' || original.value.kind !== 'practice'
            || actionLocks.current.get(lock) === captured || shown?.activities[key]?.state === 'done')
            return;
        actionLocks.current.set(lock, captured);
        setSnapshot(old => old?.scope === captured ? { ...old, activities: { ...old.activities, [key]: { state: 'busy' } } } : old);
        try {
            verifiedSource(row, original.value);
            await captured.port.onResume(structuredClone(row));
            if (matches(captured, request))
                setSnapshot(old => old?.scope === captured && old.sequence === request
                    ? { ...old, activities: { ...old.activities, [key]: { state: 'done' } } } : old);
        }
        catch (error) {
            if (matches(captured, request))
                setSnapshot(old => old?.scope === captured && old.sequence === request
                    ? { ...old, activities: { ...old.activities, [key]: { state: 'failed', message: error instanceof Error ? error.message : '原回答暂时不能继续，请重试。' } } } : old);
        }
        finally {
            if (actionLocks.current.get(lock) === captured)
                actionLocks.current.delete(lock);
            if (live.current && current.current === captured)
                setSnapshot(old => old?.scope === captured ? { ...old } : old);
        }
    };
    const isOpen = opened === scope;
    return <section aria-label="待核对答案队列" className="nonword-study" style={{ fontSize: '1rem', lineHeight: 1.65, minWidth: 0 }}>
    <button type="button" className="study-secondary-action" aria-expanded={isOpen} onClick={() => {
            if (isOpen)
                setOpened(null);
            else {
                setOpened(scope);
                void load();
            }
        }}>
      待核对答案{shown ? shown.error?' · 读取受限':` ${rows.length}` : ''}
    </button>
    {isOpen && <div style={{ marginBlock: '1rem', minWidth: 0 }}>
      <h2 style={{ fontSize: '1.25rem' }}>保留的原回答</h2>
      <p>这里保留原作答、暂停草稿与原资料版本。打开、续学或继续核对都不自动形成成绩。</p>
      {accountCapability === 'unsupported' && <p role="status">当前账号服务尚不支持待核对答案同步；本机保存的答案仍可查看与继续。</p>}
      {accountCapability === 'offline' && <p role="status">账号同步暂不可用；已读出的原回答仍保留，请恢复连接后核对同步状态。</p>}
      {shown?.loading && <p role="status">正在读取已保存的原回答…</p>}
      {shown?.error && <p role="alert">{shown.error} 原回答没有删除。</p>}
      <button type="button" className="study-secondary-action" disabled={shown?.loading} onClick={() => void load()}>刷新待核对答案</button>
      {shown && !shown.loading && !shown.error && rows.length === 0 && <p role="status">当前资料库没有待核对的首轮答案。</p>}
      <ol style={{ padding: 0, listStyle: 'none', minWidth: 0 }}>{rows.map(row => {
                const key = itemKey(row), original = shown?.sources[key], activity = shown?.activities[key];
                const answer = row.submitted?.answer ?? row.answer, savedAt = row.submitted?.submittedAt ?? row.updatedAt;
                const verified = original?.state === 'ready' ? original.value : null;
                const busy = activity?.state === 'busy' || actionLocks.current.get(resumeKey(row)) === scope, done = activity?.state === 'done';
                return <li key={key} style={{ paddingBlock: '1rem', borderTop: '1px solid var(--line)', minWidth: 0, overflowWrap: 'anywhere' }}>
          <h3 style={{ fontSize: '1.1rem' }}>{verified?.title || '保留的原作答'}</h3>
          <p>{status(row)} · 保存于 <time dateTime={savedAt}>{savedTime(savedAt)}</time></p>
          {verified ? <>
            <p>原来源：{verified.sourceLabel || '材料未提供来源名称'}</p>
            <LearningText text={verified.prompt} renderMath={renderMath}/>
            {verified.reference && <details><summary>原参考资料</summary><LearningText text={verified.reference} renderMath={renderMath}/></details>}
          </> : original?.state === 'failed' ? <p role="status">原资料暂时不可用，题型与版本仍待核对。原回答仍保留。{original.message}</p>
                        : <p role="status">正在读取原资料及其版本…</p>}
          <details><summary>{row.submitted ? '查看完整原回答' : '查看已保存草稿'}</summary>
            {answer ? <pre style={{ fontSize: '1rem', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxWidth: '100%', marginBlock: '.75rem' }}>{answer}</pre>
                        : <p>本次没有保存文字回答。</p>}
          </details>
          {row.submitted && row.evaluation.status === 'resolved' && row.evaluation.feedback && <details><summary>已保留的核对反馈</summary><LearningText text={row.evaluation.feedback} renderMath={renderMath}/></details>}
          {original?.state === 'failed' && <button type="button" className="study-secondary-action" disabled={busy} onClick={() => {
                            if (shown)
                                void readReference(row, scope, shown.sequence);
                        }}>重试读取原资料</button>}
          <button type="button" className="study-primary-action" disabled={!verified || busy || done} onClick={() => void resume(row)}>{busy ? row.submitted ? '正在打开原答案…' : '正在打开原草稿…' : done ? row.submitted ? '已打开原答案' : '已打开原草稿' : row.submitted ? '继续核对原答案' : '继续学习原草稿'}</button>
          {activity?.state === 'failed' && <p role="alert">{activity.message} 原回答仍保留，可重试。</p>}
        </li>;
            })}</ol>
    </div>}
  </section>;
}
