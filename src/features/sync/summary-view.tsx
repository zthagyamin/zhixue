import {syncSummary,type SyncSummaryInput} from './summary';

/** Presentation only: opening details is owned by the caller and never starts delivery. */
export function SyncSummary({onOpenDetails,...input}:SyncSummaryInput & {onOpenDetails:()=>void}) {
  const view=syncSummary(input);
  return <section aria-label="学习记录同步摘要" className="rounded-xl border border-[var(--line)] p-4 text-sm">
    <p className="font-bold">{view.queue}</p>
    <p className="mt-1 text-xs opacity-70">{view.checked}</p>
    {view.recent.length>0&&<div className="mt-2"><p className="text-xs font-bold">最近一次作答</p>{view.recent.map(text=><p key={text}>{text}</p>)}</div>}
    {view.guidance.map(text=><p key={text} className="mt-1">{text}</p>)}
    <button type="button" className="study-secondary-action mt-3" onClick={onOpenDetails}>查看同步详情</button>
  </section>;
}
