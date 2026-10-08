'use client';
import type {StudyFocusSummary,StudyTaskLead} from './study-view-model';

function formatFocusDurationMeta(summary: StudyFocusSummary): string {
  const parts: string[] = [];
  const hasLead = typeof summary.leadMinutes === 'number' && Number.isFinite(summary.leadMinutes) && summary.leadMinutes >= 0;
  const hasTotal = typeof summary.minutes === 'number' && Number.isFinite(summary.minutes) && summary.minutes >= 0;

  if (hasLead) parts.push(`本组预计 ${summary.leadMinutes} 分钟`);
  if (summary.groups !== null && summary.groups > 1 && hasTotal) {
    parts.push(`当前待完成任务合计预计 ${summary.minutes} 分钟`);
  } else if (!hasLead && hasTotal) {
    parts.push(`待自测任务合计预计 ${summary.minutes} 分钟`);
  }
  if (parts.length === 0) parts.push('按自己的节奏完成');
  let meta = parts.join(' · ') + '，实际时间因作答而异';
  if (summary.blocked > 0) meta += ` · ${summary.blocked} 组资料需要核对`;
  return meta;
}

export function DashboardFocusHero({summary,lead,disabled,onStart,onAdvanced}:{summary:StudyFocusSummary;lead:StudyTaskLead|null;disabled:boolean;keyboardEnabled?:boolean;onStart:()=>void;onAdvanced:()=>void}){
 // Keyboard activation is native and requires focus on the button. Background Space scrolls.
 // Account and local task plans carry the actual selected (possibly resumed) task's estimate.
 // The compatibility plan supplies the same information through summary.leadMinutes.
 const displaySummary={...summary,leadMinutes:lead?.estimatedMinutes??summary.leadMinutes??null};
 const description=lead?`下一组：${lead.title}`:(summary.withheld?`${summary.withheld} 项材料待完善题目，暂不自测；可进入学科查看。`:summary.finishedPasses?'待巩固内容仍保留在复习安排中，也可以查看本轮回顾。':'查看今日安排，或选择学科自由学习。');
 const timing=summary.groups!==null&&summary.groups>0?formatFocusDurationMeta(displaySummary):summary.groups===null?'正在核对任务和进度…':'';
 // Keep both text slots during verification; real task descriptions remain fully readable.
 return <section className="dashboard-focus-hero" aria-label="今日自测入口"><div><p className="study-meta">今天，从这一组开始 · 学习日每日 04:00 切换</p><h2>{summary.groups===null?'正在核对今日自测':summary.groups===0?(summary.finishedPasses?'今日这一轮已结束':'当前没有待自测任务'):<>今日待自测 <strong>{summary.groups}</strong><span> 组</span></>}</h2><p className="study-meta">{summary.newWords!==undefined?`今日已安排新词 ${summary.newWords} 个`:null}</p><p className="study-focus-description" title={description}>{description}</p><p className="study-meta study-focus-timing" title={timing||undefined} aria-hidden={!timing||undefined}>{timing||'\u00a0'}</p></div><div className="dashboard-focus-actions"><button type="button" className="study-primary-action" disabled={disabled||!lead} onClick={onStart}>{lead?.kind==='continue'?'继续今日自测':'开始今日自测'}</button><button type="button" className="study-secondary-action" onClick={onAdvanced}>调整今日安排</button></div></section>;
}
