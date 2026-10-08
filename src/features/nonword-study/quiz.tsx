'use client';
import { useRef, useState, type Dispatch, type SetStateAction, type RefObject, type ReactNode } from 'react';
import type { NonWordLearningPort } from '../../application/nonword-study';
import { quizMaterial, transitionQuiz, type NonWordQuizState, type QuizMaterial } from '../../domain/content';
import { LearningText, LearningFeedback } from './text';
type Data = {
    prompt: string;
    options?: string[];
    answer?: string;
    explanation?: string;
    code?: string;
    learningSupport?: unknown;
};
type Props = {
    data: Data;
    state: NonWordQuizState;
    setState: Dispatch<SetStateAction<NonWordQuizState>>;
    onGrade: (rating: 'good' | 'again') => void | Promise<unknown>;
    rootRef?: RefObject<HTMLDivElement | null>;
    submitObservation?: () => void;
    renderMath?: (text: string) => ReactNode;
    lifecycle?: NonWordLearningPort;
    pending?: () => boolean;
    hasSavedFeedback?: () => boolean;
    continueAfterFeedback?: () => boolean;
};
export function NonWordQuiz(props: Props) {
    let material: QuizMaterial;
    try {
        material = quizMaterial(props.data);
    }
    catch {
        return <p role="status">题目选项或参考有歧义，请核对来源。暂不形成成绩。</p>;
    }
    return <QuizInteraction {...props} material={material}/>;
}
function QuizInteraction({ data, state, setState, onGrade, material, rootRef, submitObservation, renderMath, lifecycle, pending, hasSavedFeedback, continueAfterFeedback }: Props & {
    material: QuizMaterial;
}) {
    const [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const finishing = useRef(false), retry = state.phase.startsWith('retry');
    const choose = (id: string) => setState(current => transitionQuiz(current, { type: 'choose', id }, material));
    const submit = async () => {
        if (busy)
            return;
        const next = transitionQuiz(state, { type: retry ? 'submit-retry' : 'submit' }, material);
        if (next === state)
            return;
        setBusy(true);
        setError('');
        try {
            if (!retry) {
                submitObservation?.();
                await lifecycle?.submit(JSON.stringify(next.first?.selection));
                const result = next.first!.result;
                await lifecycle?.assess({ status: result.status, source: 'deterministic', rating: result.status === 'correct' ? 'good' : result.status === 'partial' ? 'hard' : 'again', explanation: `错选：${result.wrong.join('、') || '无'}；漏选：${result.missing.join('、') || '无'}。` });
            }
            if (retry) {
                const result = next.retry!;
                await lifecycle?.recordRemediation?.(JSON.stringify(next.selection), { status: result.status, source: 'deterministic', rating: result.status === 'correct' ? 'good' : result.status === 'partial' ? 'hard' : 'again', explanation: `错选：${result.wrong.join('、') || '无'}；漏选：${result.missing.join('、') || '无'}。` });
            }
            setState(next);
        }
        catch (reason) {
            setError(reason instanceof Error ? reason.message : '答案尚未保存，请重试。');
        }
        finally {
            setBusy(false);
        }
    };
    const finish = async () => {
        if (busy || finishing.current || !state.first)
            return;
        if (hasSavedFeedback?.()) {
            continueAfterFeedback?.();
            return;
        }
        finishing.current = true;
        try {
            await onGrade(state.first.result.status === 'correct' ? 'good' : 'again');
        }
        catch (reason) {
            finishing.current = false;
            setError(reason instanceof Error ? reason.message : '结果尚未可靠保存。');
        }
    };
    const feedback = retry ? state.retry : state.first?.result;
    const labels = (ids: string[]) => ids.map(id => material.options.find(option => option.id === id)?.text ?? id).join('；') || '无';
    const firstCorrect = state.first?.result.status === 'correct';
    return <div ref={rootRef} data-study-shortcuts data-study-activity="quiz" className="study-activity study-quiz nonword-study">
    <LearningText text={data.prompt} className="study-question" renderMath={renderMath}/>
    {data.code && <pre className="nonword-code"><code>{data.code}</code></pre>}
    <div role="group" aria-label={material.selection === 'multiple' ? '选择所有正确选项' : '选择一个选项'}>
      {material.options.map((option, index) => <button key={option.id} type="button" className="study-choice nonword-option" aria-pressed={state.selection.includes(option.id)} disabled={busy || Boolean(feedback)} data-study-key={index < 9 ? String(index + 1) : undefined} onClick={() => choose(option.id)}>
        <span aria-hidden="true">{state.selection.includes(option.id) ? '●' : '○'}</span><LearningText text={option.text} renderMath={renderMath}/>
      </button>)}
    </div>
    {!feedback && <button type="button" className="study-primary-action" disabled={busy || !state.selection.length} onClick={() => void submit()}>{busy ? '正在保存…' : retry ? '核对这次补练' : '提交答案'}</button>}
    {feedback && <section aria-label="作答反馈" className="nonword-feedback">
      <h3>{feedback.status === 'correct' ? '回答正确' : feedback.status === 'partial' ? '部分正确' : '这次需要复习'}</h3>
      {feedback.status !== 'correct' && <p>错选：{labels(feedback.wrong)}<br />漏选：{labels(feedback.missing)}</p>}
      {material.options.filter(option => feedback.wrong.includes(option.id) && option.explanation).map(option => <LearningFeedback key={option.id} text={option.explanation!} renderMath={renderMath} fullLabel="查看完整选项解释"/>)}
      {data.explanation && <LearningFeedback text={data.explanation} renderMath={renderMath}/>}
      <details><summary>完整参考答案</summary><LearningText text={labels(material.correctIds)} renderMath={renderMath}/></details>
      {retry && <p role="status">本次是辅助补练；首轮{firstCorrect ? '通过' : '仍需复习'}，原结果保持不变。</p>}
      {lifecycle?.purpose==='guided'?<p role="status">这是引导反馈，请收起讲解后进入独立尝试。</p>:<>
        {!firstCorrect && <button type="button" className="study-secondary-action" disabled={busy} onClick={() => setState(current => transitionQuiz(current, { type: 'retry' }, material))}>收起解释，再试一次</button>}
        <button type="button" className="study-primary-action" disabled={busy || pending?.()} onClick={() => void finish()}>{firstCorrect ? '继续' : '跳过补练或结束补练，继续'}</button>
      </>}
    </section>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
