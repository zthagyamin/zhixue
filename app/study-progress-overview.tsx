"use client";

import {Fragment,useId,useState,type CSSProperties,type ReactNode} from 'react';
import type {ModuleSummary,DynamicSubject} from './dynamic-ui-model';
import {stableStudyItemKey} from './dynamic-ui-model';
import type {StudyEventV3} from './study-event-v3';
import type {StudyRecordEnvelope} from './account-study-record';
import type {AssistanceHistoryEntry,AssistanceHistoryPhase} from './assistance-history';
import {assistanceObservationLabel} from './assistance-summary';
import {auxiliaryDeliveryLabel} from './study-submission-status';
import {pluginLabels} from './plugin-routing';
import {forecastDue} from './learning-metrics';
import {useProgressPlanScope,type AccountProgressPlanInput} from './use-progress-plan-scope';
import {progressRecordRows,progressScopeSummary,type ProgressRecordRow} from './study-progress-model';

function OutlineIcon({kind}:{kind:'download'|'info'|'sync'|'chevron'|'records'}){
  const paths={download:'M12 3v11m-4-4 4 4 4-4M4 15v5h16v-5',info:'M12 11v5m0-9v.1',sync:'m6 12 4 4 8-9',chevron:'m9 5 7 7-7 7',records:'M5 4h10l4 4v12H5zM14 4v5h5M8 13h8M8 16h6'};
  return <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{(kind==='info'||kind==='sync')&&<circle cx="12" cy="12" r="9"/>}<path d={paths[kind]}/></svg>;
}
function RecordDetails({row}:{row:ProgressRecordRow}){
  const summary=row.assistance?.summary;
  const names:Record<string,string>={'meaning-check':'释义核对','meaning-study':'查看释义','reference-answer':'参考答案','ai-hint':'提示','ai-tutor':'导师帮助','answer-feedback':'反馈核对'};
  return <div className="c-record-details">
    <strong>{summary?'本次辅助记录':'辅助情况未知'}</strong>
    <p>{assistanceObservationLabel(summary)}。{!summary?'历史记录没有可核对的辅助摘要，不能据此推断为独立完成。':'只记录页面行为摘要，不保存问答正文。'}</p>
    {summary&&<ul>{summary.preSubmitAssistance.map((action,index)=><li key={`pre-${index}`}><span>{names[action.action]??'辅助操作'} {action.count} 次</span><span>作答前</span></li>)}{summary.postSubmitFeedback.map((action,index)=><li key={`post-${index}`}><span>{names[action.action]??'反馈核对'} {action.count} 次</span><span>提交后</span></li>)}</ul>}
    <p>{row.accountReceived?'原作答已进入账号；知识库写回另行核对。':'原作答的账号接收与知识库写回状态待核对。'}</p>
    {row.assistance&&<p>{auxiliaryDeliveryLabel(row.assistance.state)}</p>}
  </div>;
}
const dateFormatter=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit'});
const timeFormatter=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false});

export function StudyProgressOverview({ready,modules,activeId,onSelect,subjects,stages,events,accountRecords,accountItems,assistance,assistancePhase,fsrsData,accountPlan,onSettings,onSync=onSettings,onSources=onSettings,onDataInfo,children}:{
  accountPlan?:AccountProgressPlanInput|null;ready:boolean;modules:ModuleSummary[];activeId:string;onSelect:(id:string)=>void;subjects:DynamicSubject[];stages:Record<string,number>;events:StudyEventV3[];
  accountRecords:ReadonlyArray<{record:StudyRecordEnvelope}>;accountItems:ReadonlyArray<{itemKey:string;contentHash:string;title:string}>;assistance:AssistanceHistoryEntry[];assistancePhase:AssistanceHistoryPhase;
  fsrsData:Record<string,{due?:string;stability?:number;last_review?:string}>;onSettings:()=>void;onSync?:()=>void;onSources?:()=>void;onDataInfo:()=>void;children?:ReactNode;
}){
  const id=useId(),[expanded,setExpanded]=useState<string|null>(null),[page,setPage]=useState({activeModule:'',limit:5}),[exportNotice,setExportNotice]=useState('');
  const activeModule=modules.find(item=>item.id===activeId),subject=subjects.find(item=>item.id===activeId);
  const keys=activeModule?.itemKeys??[],currentKeys=subject?.items.map(stableStudyItemKey).filter((key):key is string=>Boolean(key))??[];
  const fallbackSummary=progressScopeSummary(subject?currentKeys:keys,stages,ready,Boolean(subject)&&activeModule?.pluginType==='three-stage');
  const planView=useProgressPlanScope(accountPlan);
  const scopedTasks=accountPlan?.plan?.tasks.filter(task=>task.subjectId===activeId&&task.action.kind==='practice')??[];
  const selectedTask=scopedTasks.find(task=>task.category==='new-word')??scopedTasks[0];
  const plannedCount=selectedTask?planView?.counts[selectedTask.taskId]:undefined;
  const taskTotal=selectedTask?.action.kind==='practice'?selectedTask.action.itemKeys.length:0;
  const summary=selectedTask?{total:taskTotal,completed:plannedCount?.completed??null,percent:plannedCount&&plannedCount.total?Math.round(plannedCount.completed/plannedCount.total*100):null,evidence:fallbackSummary.evidence}:fallbackSummary;
  const labels=Object.fromEntries(subjects.flatMap(subject=>subject.items.map((item,index)=>[stableStudyItemKey(item)??'',String(item.word||item.title||item.front||item.prompt||`内容 ${index+1}`).slice(0,100)])));
  const rows=progressRecordRows({events,keys,labels,assistance,accountRecords,accountItems});
  const forecast=forecastDue({fsrsData:Object.fromEntries((activeModule?.itemKeys??[]).filter(key=>fsrsData[key]).map(key=>[key,fsrsData[key]])),now:new Date()});
  const max=Math.max(1,...forecast.days.map(day=>day.count));
  const limit=page.activeModule===activeId?page.limit:5,visible=rows.slice(0,limit),unit=selectedTask?.category==='new-word'||activeModule?.pluginType==='three-stage'?'词':'项';
  const choose=(next:string)=>{setExpanded(null);setExportNotice('');onSelect(next);};
  function exportRecords(){
    try{
      const blob=new Blob([JSON.stringify({subject:activeModule?.name,records:rows.map(({id,occurredAt,title,correct,stage,mode,accountReceived,assistance})=>({eventId:id,occurredAt,title,correct,stage,mode,accountReceived,assistance:assistance?.summary??null,assistanceDelivery:assistance?.state??'unknown'}))},null,2)],{type:'application/json'});
      const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download='zhixue-study-records.json';anchor.click();window.setTimeout(()=>URL.revokeObjectURL(url),1000);setExportNotice('已发起下载，请确认浏览器已保存文件。');
    }catch{setExportNotice('导出未完成，请重试；已有记录保留。');}
  }
  if(!ready)return <section className="c-progress-empty" role="status"><OutlineIcon kind="records"/><h2>学习历史待核对</h2><p>已有记录保留，未核对的历史不会显示为零进度。</p><button type="button" onClick={onSync}>查看同步状态</button></section>;
  return <section className="c-progress-overview" aria-label="动态学习进度">
    <header className="c-progress-heading"><div><h1>学习进度与记录</h1><p>完成不代表已掌握，需要持续复习与实践。</p></div><div className="c-progress-tools"><button type="button" aria-label="数据说明" onClick={onDataInfo}><OutlineIcon kind="info"/><span>数据说明</span></button><button type="button" aria-label="同步状态" onClick={onSync}><OutlineIcon kind="sync"/><span>同步状态</span></button></div></header>
    {!modules.length?<div className="c-progress-empty"><OutlineIcon kind="records"/><h2>还没有可展示的学习进度</h2><p>连接学习资料并完成第一次练习后，这里会显示你的记录。</p><button type="button" onClick={onSources}>连接资料来源</button></div>:<>
      <div className="c-progress-toolbar"><div role="tablist" aria-label="选择进度学科" className="c-progress-tabs">{modules.map((entry,index)=><button key={entry.id} id={`${id}-tab-${index}`} type="button" role="tab" aria-selected={entry.id===activeId} aria-controls={`${id}-panel`} tabIndex={entry.id===activeId?0:-1} onClick={()=>choose(entry.id)} onKeyDown={event=>{const delta=event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:0;if(!delta&&!['Home','End'].includes(event.key))return;event.preventDefault();const target=event.key==='Home'?0:event.key==='End'?modules.length-1:(index+delta+modules.length)%modules.length;choose(modules[target].id);document.getElementById(`${id}-tab-${target}`)?.focus();}}>{entry.name}</button>)}</div><button type="button" className="c-record-export" disabled={!rows.length} onClick={exportRecords} title="导出当前学科已核对的作答记录"><OutlineIcon kind="download"/>导出记录</button></div>
      {exportNotice&&<p className="c-progress-notice" role="status">{exportNotice}</p>}
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${Math.max(0,modules.findIndex(entry=>entry.id===activeId))}`}>
        <div className="c-progress-card-grid">
          <article className="c-progress-card c-progress-current"><h2>{selectedTask?'今日进度':'学习进度'} <small>{selectedTask?'（本轮计划）':'（当前范围）'}</small></h2><div className="c-current-body"><div className="c-progress-ring" role="img" aria-label={summary.completed===null?'完成数量尚无可核对口径':`当前范围已完成 ${summary.completed} / ${summary.total} ${unit}`}>
            <svg viewBox="0 0 128 128" aria-hidden="true"><circle cx="64" cy="64" r="56"/><circle className="c-progress-ring-value" cx="64" cy="64" r="56" pathLength="100" strokeDasharray={`${summary.percent??0} 100`}/></svg><div><strong>{summary.completed===null?'—':summary.completed}</strong>{summary.completed!==null&&<span>/{summary.total}</span>}<small>{summary.completed===null?'完成情况待核对':'当前范围已完成'}</small></div>
          </div><div className="c-current-description"><h3>{selectedTask?`本轮目标：${selectedTask.category==='new-word'?'新学':activeModule?.name??'学习'} ${summary.total} ${unit}`:subject?`当前范围：${subject.name} ${summary.total} ${unit}`:'今天没有该学科的练习范围'}</h3><p>完成不代表已掌握，需要持续复习。</p><div className="c-progress-track-row"><div className="c-progress-track"><span style={{width:`${summary.percent??0}%`}}/></div><strong>{summary.percent===null?'—':`${summary.percent}%`}</strong></div><p className="c-progress-counts">{summary.completed===null?(selectedTask?(planView?.phase==='failed'?'计划范围历史待重新核对':'正在核对本轮计划…'):`${summary.evidence??0} 项内容已有学习证据`):`已完成 ${summary.completed} ${unit} | 剩余 ${summary.total-summary.completed} ${unit}`}</p></div></div></article>
          <article className="c-progress-card c-progress-forecast"><h2>近七日复习到期 <small>（预测）</small><span>单位：项</span></h2><div className="c-forecast-columns">{forecast.days.map(day=><div className="c-forecast-day" key={day.dayOffset}><div className="c-forecast-pillar"><strong>{day.count||'—'}</strong><i data-empty={day.count===0||undefined} style={{height:`${day.count/max*66}px`} as CSSProperties}/></div><span>{day.dateLabel}</span><small>{day.dayOffset===0?'今天':`+${day.dayOffset} 天`}</small></div>)}</div><p className="c-forecast-caption" data-overdue={forecast.overdue>0||undefined}>{forecast.overdue?`另有 ${forecast.overdue} 项已逾期，请优先复习。`:'按当前复习状态预测，后续作答会调整安排。'}</p></article>
        </div>
        <section className="c-recent-records" aria-label="近期练习记录"><h2>近期练习记录 <small>（{rows.length} 条已核对作答）</small></h2>
          {assistancePhase!=='ready'&&<p className="c-record-phase" role="status">{assistancePhase==='failed'?'辅助历史尚未完整核对；已有作答保留。':assistancePhase==='unsupported'?'当前服务尚不支持辅助摘要同步。':'辅助历史正在核对，未知不等于未使用辅助。'}</p>}
          <table className="c-record-table"><thead><tr><th>日期</th><th>学习模式</th><th>内容范围</th><th>结果</th><th>辅助记录</th><th>备注</th></tr></thead><tbody>{visible.map(row=>{const date=new Date(row.occurredAt),opened=expanded===row.id;return <Fragment key={row.id}><tr className="c-record-row"><td className="c-record-date"><time dateTime={row.occurredAt}><strong>{dateFormatter.format(date)}</strong><span>{timeFormatter.format(date)}</span></time></td><td className="c-record-mode">{row.mode?pluginLabels[row.mode]:'学习作答'}</td><td className="c-record-title"><span className="c-record-mobile-mode">{row.mode?pluginLabels[row.mode]:'学习作答'} · </span>{row.title}</td><td className="c-record-result"><span data-result={row.correct?'correct':'retry'}><i aria-hidden="true">{row.correct?'✓':'−'}</i>{row.correct?'通过':'需巩固'}</span></td><td className="c-record-assistance"><div className="c-record-assistance-line"><span>{row.assistance?.summary?assistanceObservationLabel(row.assistance.summary):'辅助情况未知'}<small className="c-record-mobile-receipt"> / {row.accountReceived?'账号已接收':'接收待核对'}</small></span><button type="button" className="c-record-toggle" aria-label={`查看 ${row.title} 的辅助记录`} aria-expanded={opened} aria-controls={`${id}-record-${row.id}`} onClick={()=>setExpanded(opened?null:row.id)}><OutlineIcon kind="chevron"/></button></div></td><td className="c-record-note">{row.accountReceived?'账号已接收':'接收情况待核对'}</td></tr>{opened&&<tr id={`${id}-record-${row.id}`} className="c-record-expanded"><td colSpan={6}><RecordDetails row={row}/></td></tr>}</Fragment>;})}</tbody></table>
          {!rows.length&&<div className="c-record-empty"><OutlineIcon kind="records"/><strong>暂时没有作答记录</strong><p>完成一次真实练习后，记录会出现在这里。</p></div>}
          <footer><span>显示 {visible.length} / {rows.length} 条记录</span>{visible.length<rows.length?<button type="button" onClick={()=>setPage({activeModule:activeId,limit:limit+20})}>查看更多记录 <OutlineIcon kind="chevron"/></button>:<span>已展示当前已核对记录</span>}</footer>
        </section>
      </div>
    </>}
    <details className="c-progress-more"><summary>内容明细与学习分析 <span>阶段记录、记忆风险与辅助摘要</span></summary><div>{children}</div></details>
  </section>;
}
