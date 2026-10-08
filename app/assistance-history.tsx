import type {StudyEventV3} from './study-event-v3';
import type {SubmissionRow} from './study-submission-journal';
import type {AssistanceSummaryV1} from './assistance-summary';
import type {AssistanceReadView} from './assistance-read-cache';
import type {AuxiliaryDelivery} from './study-submission-transport';
import {assistanceObservationLabel} from './assistance-summary';
import {auxiliaryDeliveryLabel} from './study-submission-status';
import {pluginLabels} from './plugin-routing';

export type AssistanceHistoryEntry={eventId:string;occurredAt:string;summary:AssistanceSummaryV1|null;state:AuxiliaryDelivery|'pending'};
export type AssistanceHistoryPhase='loading'|'cached'|'ready'|'failed'|'unsupported';
/** Inputs have already passed their independent core/journal/read validation. */
export function assistanceHistoryEntries(events:StudyEventV3[],view:AssistanceReadView|null,submissions:SubmissionRow[]):AssistanceHistoryEntry[]{
  const entries=new Map<string,AssistanceHistoryEntry>();
  for(const event of events)if(event.eventType==='practice-attempt')entries.set(event.eventId,{eventId:event.eventId,occurredAt:event.occurredAt,summary:null,state:'unknown'});
  for(const row of submissions){const p=row.payload;if(!entries.has(p.eventId))entries.set(p.eventId,{eventId:p.eventId,occurredAt:p.core.occurredAt,summary:null,state:'unknown'});
    const state:AuxiliaryDelivery|'pending'=!p.summary?'unknown':row.writeback?.receipt.status??(p.route.kind==='local'&&!p.route.binding?'binding-unknown':row.cloudAck?'account-received':'pending');
    entries.set(p.eventId,{eventId:p.eventId,occurredAt:p.core.occurredAt,summary:p.summary,state});
  }
  const receipts=new Map(view?.receipts.map(row=>[row.receipt.summaryId,row.receipt])??[]);
  for(const row of view?.summaries??[]){const summary=row.record.summary;entries.set(summary.attemptEventId,{eventId:summary.attemptEventId,occurredAt:row.parent.event.occurredAt,summary,state:receipts.get(summary.summaryId)?.status??'account-received'});}
  return [...entries.values()].sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)||b.eventId.localeCompare(a.eventId));
}
const actions={ 'meaning-check':'核对释义','meaning-study':'不会时查看释义','reference-answer':'查看参考答案','ai-hint':'请求提示','ai-tutor':'导师帮助','answer-feedback':'查看作答反馈'};
export function AssistanceHistory({entries,phase,onRefresh}:{entries:AssistanceHistoryEntry[];phase:AssistanceHistoryPhase;onRefresh:()=>void}){
  return <details className="study-context assistance-history"><summary>辅助学习记录</summary><div>
    <p className="study-meta">只记录提交作答时的行为摘要，不保存问答正文，也不改变成绩或复习安排。</p>
    <div className="assistance-history-status"><span role="status">{phase==='failed'?'辅助历史尚未完整核对；保留上次已核对记录。':phase==='loading'?'正在核对辅助记录…':phase==='cached'?'显示本机完整缓存，正在检查更新。':phase==='unsupported'?'当前服务尚不支持摘要同步；已保存记录保留。':'已核对本次读取到的辅助记录。'}</span><button type="button" onClick={onRefresh}>重新核对</button></div>
    <ol>{entries.slice(0,10).map(entry=><li key={entry.eventId}>
      <header><time dateTime={entry.occurredAt}>{new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(entry.occurredAt))}</time><span>{entry.summary?pluginLabels[entry.summary.practiceMode]:'学习作答'}</span></header>
      <p>{assistanceObservationLabel(entry.summary)}</p>
      {entry.summary&&entry.summary.preSubmitAssistance.length>0&&<p className="study-meta">{entry.summary.preSubmitAssistance.map(row=>`${actions[row.action]} ${row.count} 次`).join(' · ')}</p>}
      {entry.summary&&entry.summary.postSubmitFeedback.length>0&&<p className="study-meta">提交后：{entry.summary.postSubmitFeedback.map(row=>`${actions[row.action]} ${row.count} 次`).join(' · ')}</p>}
      <p className="study-meta">{auxiliaryDeliveryLabel(entry.state)}</p>
    </li>)}</ol>
    {!entries.length&&phase==='ready'&&<p className="study-meta">暂时没有可展示的提交记录。未提交的页面操作不会保存为摘要。</p>}
  </div></details>;
}
