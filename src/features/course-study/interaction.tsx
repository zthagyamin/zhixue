'use client';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { NonWordLearningPort } from '../../application/nonword-study';
import type { CourseLearningPort } from '../../application/course-study';
import type { AttemptEvidenceDraft, FSRSRating } from '../../domain/assessment';
import type { CourseDiagnostic, CourseEvidence, ResolvedCourseTask } from '../../domain/course-study';
import { LearningText, LearningFeedback } from '../nonword-study';
import { conditionInPrompt } from './condition-presentation';

export type CourseInteractionProps = {
    lifecycle: NonWordLearningPort;
    draft: AttemptEvidenceDraft & { write: (field: string, value: unknown) => boolean };
    onGrade: (rating: FSRSRating) => void | Promise<unknown>;
    renderMath?: (text: string) => ReactNode;
};
type Scope = { course: CourseLearningPort | undefined; attemptId: string | undefined };
type View = { scope: Scope; answer: string; selection: string[]; saved: boolean;
    evidence: CourseEvidence | null; pending: boolean; busy: boolean; evaluating: boolean; error: string };
type Operation = { scope: Scope; controller: AbortController; cancelled: boolean;
    saved: Promise<void>; promise: Promise<void>; cancelPromise?: Promise<void> };
const rating = { correct: 'good', partial: 'hard', incorrect: 'again' } as const;
const conclusion = { correct: '本次回答符合要求', partial: '本次回答部分符合要求', incorrect: '本次回答需要修正', undetermined: '本次回答待核对' };
function selectionFrom(answer: string): string[] {
    try { const value: unknown = JSON.parse(answer); return Array.isArray(value) && value.every(x => typeof x === 'string') ? value : []; }
    catch { return []; }
}
function matching(course: CourseLearningPort, attemptId?: string): CourseEvidence | null {
    const evidence = course.evidence();
    return evidence && evidence.attemptId === attemptId && evidence.taskId === course.task.taskId ? evidence : null;
}
/** A concise, source-authored correction, never a generated answer hint. */
function keyGap(task: ResolvedCourseTask, diagnostic: CourseDiagnostic) {
    const missed = task.criteria.filter(point => diagnostic.missedPointIds.includes(point.id));
    const point = missed.find(value => value.mandatory)
        ?? task.criteria.find(value => diagnostic.errorPointIds.includes(value.id)) ?? missed[0];
    if (point) return { label: diagnostic.missedPointIds.includes(point.id) ? '待补要点' : '需要修正',
        text: point.text, reason: diagnostic.pointEvidence.find(value => value.pointId === point.id)?.reason
            || (diagnostic.missedPointIds.includes(point.id) ? '原答案尚未覆盖这项要求。' : '原答案与这项来源要求不一致。') };
    const option = task.options?.find(value => diagnostic.wrongOptionIds.includes(value.optionId))
        ?? task.options?.find(value => diagnostic.missingOptionIds.includes(value.optionId));
    return option ? { label: diagnostic.wrongOptionIds.includes(option.optionId) ? '错选' : '漏选',
        text: option.text, reason: option.explanation ?? '' } : null;
}

/** Controlled course intent only. The shared host owns durable evidence and formal grades. */
export function CourseInteraction({ lifecycle, draft, onGrade, renderMath }: CourseInteractionProps) {
    const course = lifecycle.course;
    const scope = useMemo<Scope>(() => ({ course, attemptId: lifecycle.attemptId }), [course, lifecycle.attemptId]);
    const restore = (): View => {
        const evidence = course ? matching(course, lifecycle.attemptId) : null;
        return { scope, answer: draft.read('answer', ''), selection: draft.read<string[]>('courseSelection', []),
            saved: Boolean(lifecycle.submitted), evidence, pending: Boolean(lifecycle.submitted && (!evidence?.diagnostic || evidence.diagnostic.status === 'undetermined')),
            busy: false, evaluating: false, error: '' };
    };
    const [state, setState] = useState<View>(restore);
    // React's derived-state reset hides a previous attempt before effects run.
    if (state.scope !== scope) setState(restore());
    const active = useRef<Scope | null>(null), operation = useRef<Operation | null>(null);
    useEffect(() => {
        active.current = scope;
        return () => { active.current = null; operation.current?.controller.abort(); };
    }, [scope]);
    const patch = (value: Partial<View>) => setState(previous => previous.scope === scope ? { ...previous, ...value } : previous);
    const current = (op: Operation) => active.current === scope && operation.current === op && !op.cancelled;
    const view = state.scope === scope ? state : restore();
    if (!course) return <div className="course-study" role="status">课程任务尚未准备好。</div>;
    const task = course.task, saved = view.saved || Boolean(lifecycle.submitted);
    const original = saved ? course.originalAnswer() : view.answer;
    const selected = saved ? selectionFrom(original) : view.selection;
    const available = matching(course, scope.attemptId);
    const evidence = view.evidence && available?.diagnosticHash === view.evidence.diagnosticHash
        && available?.answerRevision === view.evidence.answerRevision ? available : null;
    const diagnostic = evidence?.diagnostic ?? null;
    const resolved = diagnostic && diagnostic.status !== 'undetermined';
    const gap = resolved ? keyGap(task, diagnostic) : null;
    const criteriaReference = task.criteria.map(point => point.text).join('\n');
    const extraConditions = task.conditions.filter(condition => !conditionInPrompt(task.prompt, condition));
    const pending = saved && !resolved;

    const run = (selfAssess = false): Promise<void> => {
        if (operation.current?.scope === scope) return operation.current.promise;
        if (!lifecycle.ready || active.current !== scope) return Promise.resolve();
        const controller = new AbortController();
        const op: Operation = { scope, controller, cancelled: false, saved: Promise.resolve(), promise: Promise.resolve() };
        operation.current = op;
        patch({ busy: true, evaluating: !selfAssess, error: '' });
        const answer = task.mode === 'quiz' ? JSON.stringify(view.selection) : view.answer;
        op.saved = saved ? Promise.resolve() : Promise.resolve().then(() => lifecycle.submit(answer));
        op.promise = (async () => {
            let reliable = saved;
            try {
                await op.saved;
                reliable = true;
                if (!current(op)) return;
                patch({ saved: true });
                const result = selfAssess ? await course.selfAssess!('incorrect', controller.signal) : await course.evaluate(controller.signal);
                if (!current(op) || controller.signal.aborted) return;
                const persisted = matching(course, scope.attemptId);
                if (!persisted?.diagnostic || persisted.diagnosticHash !== result.diagnosticHash || persisted.answerRevision !== result.answerRevision)
                    throw Error('matching-course-evidence-unavailable');
                if (persisted.diagnostic.status === 'undetermined') await lifecycle.waitForReview('课程核对尚未确定，原答案保留。');
                if (current(op)) patch({ evidence: persisted, pending: persisted.diagnostic.status === 'undetermined' });
            }
            catch {
                if (!current(op)) return;
                if (reliable) {
                    try { await lifecycle.waitForReview('AI 核对暂未完成，原答案保留。'); }
                    catch { if (current(op)) patch({ error: '待核对状态尚未保存，请重试。' }); }
                    if (current(op)) patch({ saved: true, evidence: null, pending: true });
                }
                else patch({ error: '原答案尚未保存，当前输入保留。请重试。' });
            }
            finally {
                if (operation.current === op && !op.cancelled) { operation.current = null; if (active.current === scope) patch({ busy: false, evaluating: false }); }
            }
        })();
        return op.promise;
    };
    const cancel = (): Promise<void> => {
        const op = operation.current;
        if (!op || op.scope !== scope) return Promise.resolve();
        if (op.cancelPromise) return op.cancelPromise;
        op.cancelled = true;
        op.controller.abort();
        op.cancelPromise = (async () => {
            try {
                await op.saved;
                if (active.current !== scope) return;
                await lifecycle.waitForReview('AI 核对已停止，原答案保留。');
                if (active.current === scope) patch({ saved: true, evidence: null, pending: true });
            }
            catch { if (active.current === scope) patch({ error: '停止核对后的状态尚未保存，当前输入保留。请重试。' }); }
            finally {
                if (operation.current === op) { operation.current = null; if (active.current === scope) patch({ busy: false, evaluating: false }); }
            }
        })();
        return op.cancelPromise;
    };
    const continueWith = (action: () => Promise<unknown> | unknown): Promise<void> => {
        if (operation.current?.scope === scope) return operation.current.promise;
        const op: Operation = { scope, controller: new AbortController(), cancelled: false, saved: Promise.resolve(), promise: Promise.resolve() };
        operation.current = op;
        patch({ busy: true, evaluating: false, error: '' });
        op.promise = Promise.resolve().then(() => { if (current(op)) return action(); }).then(() => {}).catch(() => {
            if (current(op)) patch({ error: '继续状态尚未保存，请重试。' });
        }).finally(() => {
            if (operation.current === op) { operation.current = null; if (active.current === scope) patch({ busy: false }); }
        });
        return op.promise;
    };
    const continueResolved = () => continueWith(() => {
        const persisted = matching(course, scope.attemptId), status = persisted?.diagnostic?.status;
        if (!status || status === 'undetermined' || persisted?.diagnosticHash !== evidence?.diagnosticHash)
            throw Error('matching-course-evidence-unavailable');
        if (lifecycle.purpose === 'remediation') {
            if (!lifecycle.finishRemediation) throw Error('remediation-continuation-unavailable');
            return lifecycle.finishRemediation();
        }
        return onGrade(rating[status]);
    });
    const continuePending = () => continueWith(async () => {
        if (!saved) throw Error('original-not-saved');
        await lifecycle.waitForReview('课程核对尚未完成，原答案保留。');
        if (active.current === scope) await lifecycle.continuePending();
    });
    const changeSelection = (id: string) => {
        if (saved || view.busy) return;
        const next = task.selection === 'single' ? [id] : selected.includes(id) ? selected.filter(value => value !== id) : [...selected, id];
        if (draft.write('courseSelection', next)) patch({ selection: next });
    };
    const canSubmit = lifecycle.ready && !view.busy && (task.mode === 'quiz' ? selected.length > 0 : view.answer.trim().length > 0);
    const targeted = resolved && lifecycle.purpose === 'first' && Boolean(lifecycle.startRemediation) && diagnostic.status !== 'correct';
    const remediationId = targeted && diagnostic.source !== 'self-assess' ? course.remediationTaskId() : null;
    return <section className="course-study" aria-label="课程作答" aria-busy={view.busy}>
      <div className="course-study-source" aria-label="题目来源">
        {task.sources.map(source => <p key={source.sourceId}>{source.label} · {source.locator}</p>)}
      </div>
      <LearningText text={task.prompt} className="course-study-prompt" renderMath={renderMath}/>
      <details className="course-study-scope"><summary>答题范围</summary><LearningText text={task.scope} renderMath={renderMath}/>
        {task.conditions.length > 0 && <ul>{task.conditions.map((condition, index) => <li key={index}><LearningText text={condition} renderMath={renderMath}/></li>)}</ul>}
      </details>
      {extraConditions.length > 0 && <div className="course-study-conditions"><span>条件</span><ul>{extraConditions.map((condition, index) => <li key={index}><LearningText text={condition} renderMath={renderMath}/></li>)}</ul></div>}
      {task.mode === 'quiz' ? <fieldset className="course-study-options" disabled={saved || view.busy || !lifecycle.ready}
        role={task.selection === 'single' ? 'radiogroup' : 'group'}><legend>{task.selection === 'single' ? '单选' : '多选'}</legend>
        {task.options?.map((option, index) => <label className="course-study-option" key={option.optionId}>
          <input type={task.selection === 'single' ? 'radio' : 'checkbox'} name={`course-choice-${scope.attemptId ?? 'current'}`}
            checked={selected.includes(option.optionId)} onChange={() => changeSelection(option.optionId)}
            onKeyDown={event => { if (event.key === 'Enter' && !saved && canSubmit) { event.preventDefault(); void run(); } }}/>
          <span className="course-study-option-letter" aria-hidden="true">{String.fromCharCode(65 + index)}.</span>
          <LearningText text={option.text} renderMath={renderMath}/>
        </label>)}
      </fieldset> : <label className="course-study-answer"><span>{saved ? '已保存的原答案' : '你的回答'}</span>
        <textarea value={original} readOnly={saved} disabled={!lifecycle.ready || view.busy} rows={6}
          onChange={event => { if (!saved && draft.write('answer', event.target.value)) patch({ answer: event.target.value }); }}
          onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !saved && canSubmit) { event.preventDefault(); void run(); } }}/>
        {!saved && <small><kbd>Ctrl</kbd> + <kbd>Enter</kbd> 提交</small>}
      </label>}
      {view.error && <p className="course-study-error" role="alert">{view.error}</p>}
      {!saved && <div className="course-study-actions">
        <button type="button" className="study-primary-action" disabled={!canSubmit} onClick={() => void run()}>提交回答</button>
        {course.selfAssess && <button type="button" className="study-secondary-action" disabled={!lifecycle.ready || view.busy} onClick={() => void run(true)}>我忘了，查看关键参考</button>}
      </div>}
      {view.busy && <div className="course-study-actions" role="status"><span>{view.evaluating ? '正在保存与核对…' : '正在保存继续状态…'}</span>
        {view.evaluating && <button type="button" className="study-secondary-action" onClick={() => void cancel()}>停止核对</button>}</div>}
      {pending && !view.busy && <div className="course-study-feedback" aria-live="polite">
        <h3>待核对</h3><p>答案已保存，可稍后核对。</p>
        <div className="course-study-actions"><button type="button" className="study-primary-action" onClick={() => void run()}>重试核对原答案</button>
          <button type="button" className="study-secondary-action" onClick={() => void continuePending()}>保留待核对并继续</button></div>
      </div>}
      {resolved && <div className="course-study-feedback" aria-live="polite">
        <h3>{lifecycle.purpose === 'remediation' && diagnostic.status === 'correct' ? '本次补练通过' : conclusion[diagnostic.status]}</h3>
        {diagnostic.source === 'self-assess' && <p>自评：忘记了</p>}
        {gap && <div className="course-study-key"><strong>{gap.label}</strong><LearningText text={gap.text} renderMath={renderMath}/>
          {gap.reason && <LearningFeedback text={gap.reason} renderMath={renderMath}/>}</div>}
        <LearningFeedback text={diagnostic.feedback} renderMath={renderMath}/>
        <details open={diagnostic.source === 'self-assess'}><summary>查看来源依据与完整参考</summary>
          {task.mode === 'quiz' && <ul aria-label="错选与漏选">
            {task.options?.filter(option => diagnostic.wrongOptionIds.includes(option.optionId) || diagnostic.missingOptionIds.includes(option.optionId)).map(option => <li key={option.optionId}>
              <strong>{diagnostic.wrongOptionIds.includes(option.optionId) ? '错选' : '漏选'}</strong>
              <LearningText text={option.text} renderMath={renderMath}/>
              {option.explanation && <LearningFeedback text={option.explanation} renderMath={renderMath}/>}
            </li>)}
          </ul>}
          <LearningText text={criteriaReference} renderMath={renderMath}/>
          {task.answer && task.answer !== criteriaReference && <LearningText text={task.answer} renderMath={renderMath}/>}
          {diagnostic.pointEvidence.map((point, index) => <blockquote key={index}>
            <LearningText text={point.sourceQuote} renderMath={renderMath}/>
            <LearningText text={point.reason} renderMath={renderMath}/>
          </blockquote>)}
        </details>
        {targeted && !remediationId && <p className="course-study-limit">暂无对应补练，可重试原题。</p>}
        <div className="course-study-actions">
          <button type="button" className="study-primary-action" disabled={view.busy} onClick={() => void continueResolved()}>{lifecycle.purpose === 'guided' ? '保存本次引导结果' : '继续'}</button>
          {targeted && <button type="button" className="study-secondary-action" disabled={view.busy} onClick={() => void continueWith(() => lifecycle.startRemediation!())}>{remediationId ? '针对这个问题补练' : '收起解释，在原题再试'}</button>}
        </div>
      </div>}
    </section>;
}
