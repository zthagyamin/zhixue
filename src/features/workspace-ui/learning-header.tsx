import type {ReactNode} from 'react';

export function LearningWorkspaceHeader({date,children}:{date:string;children?:ReactNode}) {
  return <header className="learning-workspace-heading">
    <div><p className="learning-workspace-eyebrow">你的学习工作台</p>
      <h1>今日学习<span aria-hidden="true">。</span></h1>
      <p className="learning-workspace-intro">接着上次继续，或从今天的一小步开始。</p>
    </div>
    <div className="learning-workspace-date"><span>{date}</span>{children}</div>
  </header>;
}
