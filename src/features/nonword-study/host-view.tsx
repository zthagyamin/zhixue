'use client';
import type { NonWordLearningPort } from '../../application/nonword-study';
import type { HostDraft, HostProps } from './host-contracts';
import { LearningText } from './text';
type Props = Pick<HostProps, 'temporary' | 'question' | 'reference' | 'renderMath' | 'renderPlugin' | 'onGrade'> & {
    ready: boolean;
    busy: boolean;
    paused: boolean;
    submitted: boolean;
    intent: 'review' | 'learn';
    lessonStep: 'reading' | 'guided' | 'independent';
    purpose: 'first' | 'guided' | 'remediation';
    status: string;
    elapsed: number;
    error: string;
    retryContinue: boolean;
    retryGrade: boolean;
    generation: number;
    draft: HostDraft;
    lifecycle: NonWordLearningPort;
    actions: {
        chooseIntent: (next: 'review' | 'learn') => void;
        pause: () => void;
        retryContinue: () => void;
        retryGrade: () => void;
        beginGuided: () => void;
        skipRemediation: () => void;
        beginIndependent: () => void;
    };
};
/** Presentation receives state and learner actions, with no storage or event-writing port. */
export function HostView(props: Props) {
    const { ready, busy, paused, intent, submitted, status, elapsed, error, retryContinue, retryGrade, lessonStep, generation, draft, lifecycle, actions } = props;
    const course = Boolean(lifecycle.course);
    return <section className="nonword-host" aria-label="非词汇学习流程">
    <div className="nonword-entry" role="group" aria-label="学习入口">
      <button type="button" className="study-secondary-action" aria-pressed={intent === 'review'} disabled={!ready || busy || submitted} onClick={() => actions.chooseIntent('review')}>日常复习</button>
      <button type="button" className="study-secondary-action" aria-pressed={intent === 'learn'} disabled={!ready || busy || submitted} onClick={() => actions.chooseIntent('learn')}>深入学习</button>
      <button type="button" className="study-secondary-action" disabled={!ready || busy} onClick={actions.pause}>{paused ? '继续学习' : '暂停并保存'}</button>
    </div>
    {course ? <div className="nonword-course-meta">
      <p className="nonword-status" role="status">{courseStatus(status)}</p>
      <details><summary>用时</summary><p>有效用时 {Math.floor(elapsed / 60)} 分 {elapsed % 60} 秒 · 目标10—15分钟</p></details>
    </div> : <p className="nonword-status" role="status">{status} · 本组有效用时 {Math.floor(elapsed / 60)} 分 {elapsed % 60} 秒 · 目标10—15分钟</p>}
    {error && <p role="alert">{error}
      {retryContinue && <button type="button" className="study-secondary-action" disabled={busy} onClick={actions.retryContinue}>重试继续</button>}
      {retryGrade && <button type="button" className="study-secondary-action" disabled={busy} onClick={actions.retryGrade}>重试保存作答</button>}
    </p>}
    {!ready ? <p>{course ? '正在恢复…' : '正在恢复可靠保存的作答；来源与原答案不会被重新绑定。'}</p> : paused ? <p>{course ? '已暂停' : '本次已暂停；恢复后接着当前题目。'}</p> : lessonStep === 'reading' ? <section aria-label="学习讲解">
      <h3>{course ? '讲解' : '先理解任务，再尝试'}</h3>
      {props.question && <LearningText text={props.question} className="study-question" renderMath={props.renderMath}/>}
      <LearningText text={props.reference || (course ? '暂无讲解，请核对来源。' : '本题没有足够的讲解材料。可核对来源后继续，暂不假装已经完成深入学习。')} renderMath={props.renderMath}/>
      <button type="button" className="study-primary-action" disabled={busy} onClick={actions.beginGuided}>进入引导练习</button>
    </section> : <>
      {lessonStep === 'guided' && <p>{course ? '引导练习 · 可对照讲解' : '引导练习：可以对照材料。结果保留为辅助尝试，不证明首轮独立通过。'}</p>}
      <PluginSlot key={generation} renderPlugin={props.renderPlugin} draft={draft} lifecycle={lifecycle} onGrade={props.onGrade}/>
      {!props.temporary && props.purpose === 'remediation' && !submitted && <button type="button" className="study-secondary-action" disabled={busy} onClick={actions.skipRemediation}>跳过本次补练，继续</button>}
      {lessonStep === 'guided' && <button type="button" className="study-secondary-action" disabled={busy} onClick={actions.beginIndependent}>收起讲解，独立尝试</button>}
    </>}
  </section>;
}
function courseStatus(status: string): string {
    const labels: Record<string, string> = {
        '答案已保存在本机。': '已保存',
        '答案已保存并同步到账号。': '已同步',
        '答案已保存在本机，等待账号同步。': '本机已保存 · 待同步',
        '正在保存在本机…': '正在保存…',
        '引导答案已保存，等待核对；可以收起讲解进入独立尝试。': '引导答案已保存 · 待核对',
        '辅助尝试已保存，首轮结果保持不变。': '补练已保存',
    };
    return labels[status] ?? status;
}
function PluginSlot(props: {
    renderPlugin: HostProps['renderPlugin'];
    draft: HostDraft;
    lifecycle: NonWordLearningPort;
    onGrade: HostProps['onGrade'];
}) {
    return props.renderPlugin(props.draft, props.lifecycle, props.onGrade);
}
