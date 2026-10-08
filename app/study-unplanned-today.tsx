"use client";
import {StudyEmptyPlanIcon,StudyIcon} from './study-session-shell';
import {unplannedTodayModel,type UnplannedState} from './study-unplanned-model';

export function StudyUnplannedToday({state,error,day,busy,onGenerate,onReview,onRetry,onConfirm}:{state:UnplannedState|null;error?:string|null;day:string;busy:boolean;onGenerate:()=>void;onReview:()=>void;onRetry:()=>void;onConfirm?:()=>void}){
  const view=unplannedTodayModel(state,error),waiting=view.phase==='checking',draft=view.phase==='draft';
  const confirm=draft&&Boolean(onConfirm);
  const action=confirm?onConfirm:view.action==='generate'?onGenerate:view.action==='retry'?onRetry:onReview;
  const badge=waiting?'核对中':view.phase==='failed'?'需要重试':draft?'待确认':view.phase==='approved-empty'?'暂未安排':'待安排';
  return <div className="c-unplanned-today c-plan-columns" data-phase={view.phase}>
    <aside className="c-unplanned-summary" aria-label="今日学习概览"><h3>今日概览</h3><div className="c-plan-metrics">
      <section className="c-metric-card"><div className="c-unplanned-metric-title"><h4>新词学习</h4><span>{draft?'草稿':'今日'}</span></div><p className="c-unplanned-metric-value">{view.newWords===null?(waiting||view.phase==='failed'?'待核对':'待安排'):<>{view.newWords}<small> 词</small></>}</p><p className="c-metric-caption">{draft?'草稿词量，确认后进入今日任务':'每日目标 20 词，以确认的任务为准'}</p></section>
      <section className="c-metric-card"><div className="c-unplanned-metric-title"><h4>必做复习</h4><span>{draft?'草稿':'优先'}</span></div><p className="c-unplanned-metric-value">{view.reviews===null?'待核对':<>{view.reviews}<small> 项</small></>}</p><p className="c-metric-caption">{draft?'当前草稿中的复习任务':'生成计划时核对到期与逾期项目'}</p></section>
    </div><p className="c-unplanned-summary-note">新词与复习分开安排，完成不等于掌握。</p></aside>
    <section className="c-unplanned-arrangement" aria-label="安排今日学习"><header><h3>今日安排</h3><time dateTime={day}>{Number(day.slice(5,7))} 月 {Number(day.slice(8,10))} 日</time></header>
      <div className="c-unplanned-start-card"><div className="c-unplanned-intro"><span className="c-unplanned-icon"><StudyEmptyPlanIcon/></span><div><span className="c-unplanned-badge">{badge}</span><h2>{view.title}</h2><p>{view.description}</p></div></div>
        <ol className="c-unplanned-steps" aria-label="安排学习流程">{['生成草稿','确认安排','开始学习'].map((label,index)=><li key={label} data-active={index===(draft?1:0)&&!waiting&&view.phase!=='failed'||undefined} data-done={draft&&index===0||undefined}><span aria-hidden="true">{draft&&index===0?'✓':index+1}</span><strong>{label}</strong></li>)}</ol>
        {draft&&view.tasks.length>0&&<ul className="c-unplanned-draft-list" aria-label="待确认的草稿任务">{view.tasks.slice(0,3).map(task=><li key={task.taskId}><span>{task.category==='new-word'?'新词':task.category==='review'?'复习':'学科'}</span><strong>{task.title}</strong><small>待确认</small></li>)}{view.tasks.length>3&&<li className="c-unplanned-more-draft">另有 {view.tasks.length-3} 项，可在草稿中查看</li>}</ul>}
        {view.phase==='failed'&&error&&<details className="c-unplanned-error"><summary>查看原因</summary><p>{error}</p></details>}
        <div className="c-unplanned-actions"><button type="button" className="study-primary-action" onClick={action} disabled={busy||waiting}>{busy?'正在处理…':confirm?'确认并开始今日自测':view.actionLabel}<StudyIcon name="back"/></button>{confirm?<button type="button" className="study-secondary-action" disabled={busy} onClick={onReview}>查看或调整草稿</button>:<a className="study-secondary-action" href="#study-subjects">{waiting||view.phase==='failed'?'查看学科':'自由学习'}</a>}</div>
        <p className="c-unplanned-footnote">{draft?'草稿尚未生效，不会自动替你批准。':'生成草稿后可以调整内容，再确认今天的安排。'}</p>
      </div>
    </section>
  </div>;
}
