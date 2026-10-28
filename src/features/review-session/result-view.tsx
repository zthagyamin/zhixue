import type {ReactNode} from 'react';
import {practiceResultView, type PracticeSessionResult} from './result';

export function PracticeResult({result, taskComplete, onBack, onContinue, onPending, onReload, children}: {
  result: PracticeSessionResult; taskComplete?: boolean;
  onBack: () => void; onContinue?: () => void; onPending?: () => void; onReload?: () => void;
  children?: ReactNode;
}) {
  const view = practiceResultView(result);
  return <section className="study-card study-feedback practice-result" aria-label="本轮练习结果" aria-live="polite">
    <p className="study-meta">本轮结果</p><h2>{view.title}</h2>
    <p>{result.answered > 0 ? `已核对 ${result.answered} 次：答对 ${result.correct} 次，待巩固 ${result.wrong} 次。` : '本次未形成已核对的作答。'}</p>
    <p>{[
      result.awaitingReview === undefined ? null : `待核对 ${result.awaitingReview} 题`,
      result.skipped === undefined ? null : `暂时跳过 ${result.skipped} 题`,
      result.remaining === undefined ? null : `本轮剩余 ${result.remaining} 题`,
    ].filter(Boolean).join(' · ')}</p>
    <p className="study-meta">{view.detail}</p>
    {taskComplete && <p>今日这项任务已完成</p>}
    <div className="study-result-actions">
      {onContinue && <button type="button" className="study-primary-action" onClick={onContinue}>继续今日任务</button>}
      {onPending && (result.awaitingReview ?? 0) > 0 && <button type="button" className="study-secondary-action" onClick={onPending}>查看待核对答案</button>}
      <button type="button" className="study-secondary-action" onClick={onBack}>返回今日</button>
      {onReload && <button type="button" className="study-secondary-action" onClick={onReload}>重新读取到期题</button>}
    </div>
    {children}
  </section>;
}

export function PracticeEmpty({scope, onBack, onSubjects, onPlan}: {
  scope: string; onBack: () => void; onSubjects?: () => void; onPlan?: () => void;
}) {
  return <section className="study-card study-feedback" aria-label="复习练习">
    <p className="study-meta">{scope}</p><h2>当前范围暂无可练复习题</h2>
    <p>这只说明当前范围没有可练项目；其他学科和复习安排可另行查看。</p>
    <div className="study-result-actions">
      <button type="button" className="study-secondary-action" onClick={onBack}>返回今日</button>
      {onSubjects && <button type="button" className="study-primary-action" onClick={onSubjects}>去学科自由学习</button>}
      {onPlan && <button type="button" className="study-secondary-action" onClick={onPlan}>查看复习安排</button>}
    </div>
    <details><summary>技术排错信息</summary><p>当前复习列表已读取并按范围筛选；兼容本机来源通过 /v1/practice 提供题目。</p></details>
  </section>;
}
