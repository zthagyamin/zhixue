"use client";
import {DailyMinimumStatus} from '../src/features/planning';
import type {LongTermPlanSpec} from '../src/domain/planning';
export {nativePlanDraftActions} from "../src/features/planning";

import {StudySubjectTaskGroups} from './study-subject-task-groups';
import {practiceBudgetView} from './study-review-goal';
import {planningUnitAlreadyScheduled} from './task-plan-overlap';
import {PlanRelationshipNotice} from './plan-relationship-notice';
import {useId,useState} from 'react';
import type {DailyTask,PlanningCatalog,TaskPlanV2,SuggestionRequest,ReviewObligation} from './task-plan-types';
import type {TaskEdit} from './task-plan-edit';
import type {TaskPlanSummary} from './task-plan-runtime';
import {StudyPanel,StudyTaskGlyph,StudyEmptyPlanIcon} from './study-session-shell';
import {DashboardFocusHero} from './dashboard-focus-hero';
import {selectStudyTask,studyFocusSummary} from './study-view-model';

const button='rounded-lg border border-[var(--line)] px-3 py-2 text-sm font-bold transition-colors hover:bg-[var(--surface-2)] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--lime-dark)] disabled:opacity-40 disabled:cursor-not-allowed';
const field='rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm min-w-0 focus-visible:outline-2 focus-visible:outline-[var(--lime-dark)]';
export type TodayLearningProps={
  minimumSpec?:LongTermPlanSpec|null;
  onLongTerm?:()=>void;
  onTopUpMinimums?:()=>void;
  withheldTaskIds?:readonly string[];finishedPassTaskIds?:readonly string[];reviewSelectionTaskIds?:readonly string[];onReviewSelectionChange?:(ids:string[])=>void;practiceGroupByTask?:Record<string,string>;
  studyFirst?:boolean;
  activePractice?:boolean;
  plan:TaskPlanV2|null;catalog:PlanningCatalog|null;summary:TaskPlanSummary;completedTaskIds:string[];reviewRounds?:ReviewObligation[];
  dirty:boolean;loading:boolean;ready:boolean;message:string;lastSyncedAt?:string;pendingCount?:number;
  offline?:boolean;hasVerifiedHistory?:boolean;
  hasBackup?:boolean;onRestoreBackup?:()=>void;
  onGenerate:()=>void;onReload:()=>void;onStart:(taskId:string,eligibleTaskIds?:string[])=>void;onEdit:(edit:TaskEdit)=>void;
  onSuggest:(intent:SuggestionRequest['intent'])=>void;onSave:()=>void;onComplete:(taskId:string)=>void;
  onOptionalMinutes:(minutes:number|undefined)=>void;
};

export function TodayLearning(props:TodayLearningProps) {
  const {plan,catalog,summary,loading,ready,completedTaskIds}=props;
  const id=useId(),[subjectChoice,setSubjectChoice]=useState(''),[unitChoice,setUnitChoice]=useState('');
  const [editing,setEditing]=useState(false);
  const [reviewPage,setReviewPage]=useState({day:'',count:50});
  const reviewLimit=reviewPage.day===plan?.day?reviewPage.count:50;
  const taskIndexes=new Map(plan?.tasks.map((task,index)=>[task.taskId,index])??[]);
  const wordNames=new Map((plan?.vocabulary.snapshot??[]).map(word=>[word.itemKey,word.word]));
  const subject=catalog?.subjects.find(subject=>subject.subjectId===subjectChoice)??catalog?.subjects[0];
  const unit=subject?.units.find(unit=>unit.unitId===unitChoice);
  const busy=loading || !ready;
  const focusReady=ready&&props.hasVerifiedHistory!==false;
  const navigation={withheldTaskIds:props.withheldTaskIds,finishedPassTaskIds:props.finishedPassTaskIds,practiceGroupByTask:props.practiceGroupByTask,reviewSelectionTaskIds:props.reviewSelectionTaskIds,onReviewSelectionChange:props.onReviewSelectionChange};
  const focusTasks=practiceBudgetView((plan?.tasks??[]).filter(task=>!props.withheldTaskIds?.includes(task.taskId)),plan?.longTermAllocation?.reviewTarget??undefined,0,completedTaskIds,[...plan?.manual.lockedTaskIds??[],...props.finishedPassTaskIds??[]],props.reviewSelectionTaskIds,plan?.longTermAllocation?.practiceBudgetGroups).visible;
  const focusLead=selectStudyTask({ready:focusReady,tasks:focusTasks,completedTaskIds,startedTaskIds:plan?.manual.lockedTaskIds??[],...navigation});
  const focusSummary=studyFocusSummary({ready:focusReady,tasks:focusTasks,completedTaskIds,...navigation});
  const leadTask=plan?.tasks.find(task=>task.taskId===focusLead?.taskId);
  const newAssigned=plan?.tasks.filter(task=>task.category==='new-word').reduce((sum,task)=>sum+task.quantity,0)??0;
  function taskRow(task:DailyTask,index:number,eligibleTaskIds?:string[]) {
    const done=completedTaskIds.includes(task.taskId),owner=catalog?.subjects.find(subject=>subject.subjectId===task.subjectId);
    const review=props.reviewRounds?.find(round=>round.roundId===task.reviewRoundId || round.aliasRoundIds?.includes(task.reviewRoundId??''));
    const due=review?new Date(Date.parse(review.dueAt)+8*3600000).toISOString():null;
    return <li key={task.taskId} data-current={props.studyFirst&&leadTask?.taskId===task.taskId||undefined} className={`${props.studyFirst?'c-local-task-row ':''}border border-[var(--line)] rounded-lg p-4 ${done?'bg-[var(--lime)]/20':''}`}>
      <div className="c-local-task-main flex flex-wrap items-start justify-between gap-3">
        {props.studyFirst&&<><span className="c-task-number" aria-hidden="true">{String(index+1).padStart(2,'0')}</span><StudyTaskGlyph category={task.category}/></>}
        <div className="c-local-task-copy min-w-0 flex-1">
          <p className="text-xs opacity-60 mb-1">{owner?.name??task.subjectId} · {task.category==='review'?'到期复习':task.required?'必做':'可选'} · {task.origin==='goal'?'学科指标':task.origin==='manual'?'手动安排':task.origin==='ai'?'AI 建议':task.origin==='fallback'?'规则建议':'固定任务'}</p>
          <h4 className={`text-base font-bold break-words ${done?'line-through opacity-60':''}`}>{done && <span aria-label="已完成">✓ </span>}{task.title}</h4>
          {due && <p className="mt-1 text-xs opacity-60">{`${due.slice(0,10)===plan?.day?'今日':due.slice(0,10)} ${due.slice(11,16)} 到期${done?' · 本轮已完成':''}`}</p>}
          {task.action.kind==='manual' && <p className="mt-1 text-xs opacity-60">{`本次数量：${task.quantity} 项`}</p>}
          {task.estimatedMinutes!==undefined && <p className="text-xs opacity-60 mt-1">约 {task.estimatedMinutes} 分钟，仅供参考</p>}
          {task.blockedReason && <p className="text-sm text-[var(--orange)] mt-2" role="status">{task.blockedReason}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button className={button} disabled={busy || Boolean(task.blockedReason) || done} onClick={()=>props.onStart(task.taskId,eligibleTaskIds)}>{props.finishedPassTaskIds?.includes(task.taskId)?'查看本轮回顾':props.studyFirst&&leadTask?.taskId===task.taskId?'开始学习':task.action.kind==='open-note'?'打开学习资料':task.action.kind==='manual'?'开始这项任务':task.category==='new-word'?'去背词':task.category==='review'?'去复习':'去练习'}</button>
          {task.completionRule==='self-report' && <button className={button} disabled={busy || done || Boolean(task.blockedReason)} onClick={()=>props.onComplete(task.taskId)}>记录本次完成</button>}
          {task.blockedReason && <button className={button} disabled={busy} onClick={()=>props.onEdit({type:'refresh-source',taskId:task.taskId})}>确认资料更新</button>}
        </div>
      </div>
      {task.completionRule.startsWith('formal-') && <p className="mt-2 text-xs opacity-60">以学习知识库正式进度为准，练习与自报不会改写掌握状态。</p>}
      <details className="c-local-task-options mt-3 text-sm">
        <summary className="cursor-pointer opacity-60 focus-visible:outline-2">调整这项任务</summary>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button className={button} disabled={busy || index===0} onClick={()=>props.onEdit({type:'move',taskId:task.taskId,beforeTaskId:plan!.tasks[index-1].taskId})}>上移</button>
          <button className={button} disabled={busy || index===plan!.tasks.length-1} onClick={()=>props.onEdit({type:'move',taskId:task.taskId,beforeTaskId:plan!.tasks[index+2]?.taskId??null})}>下移</button>
          {!task.required && <button className={button} disabled={busy} onClick={()=>props.onEdit({type:'remove',taskId:task.taskId})}>今天不安排</button>}
          {task.required && <span className="text-xs opacity-60">必做任务不能通过“少安排”删除。</span>}
        </div>
        {task.category!=='new-word' && <form className="mt-3 flex flex-wrap gap-2" key={`${task.taskId}:${task.title}:${task.quantity}`} onSubmit={event=>{
          event.preventDefault();const values=new FormData(event.currentTarget),title=String(values.get('title')??'').trim();
          if (!title) return;
          props.onEdit({type:'upsert',task:{...task,title,quantity:task.action.kind==='manual'?Number(values.get('quantity')):task.quantity}});
        }}>
          <label className="flex flex-col gap-1 flex-1 min-w-40"><span className="text-xs opacity-60">任务名称</span><input name="title" className={field} defaultValue={task.title} maxLength={200} /></label>
          {task.action.kind==='manual' && <label className="flex flex-col gap-1"><span className="text-xs opacity-60">本次数量</span><input name="quantity" type="number" min={1} step={1} className={`${field} w-24`} defaultValue={task.quantity} /></label>}
          <button className={`${button} self-end`} disabled={busy}>保存调整</button>
        </form>}
        {task.category==='new-word' && task.action.kind==='practice' && <form className="mt-3 flex flex-wrap gap-2" onSubmit={event=>{
          event.preventDefault();const values=new FormData(event.currentTarget);
          props.onEdit({type:'replace-new-word',taskId:task.taskId,fromItemKey:String(values.get('from')),toItemKey:String(values.get('to'))});
        }}>
          <label className="flex flex-col gap-1"><span className="text-xs opacity-60">换出尚未开始的词</span><select name="from" className={field}>{task.action.itemKeys.map(key=><option key={key} value={key}>{wordNames.get(key)??key}</option>)}</select></label>
          <label className="flex flex-col gap-1"><span className="text-xs opacity-60">换入词</span><select name="to" className={field}>{owner?.words.map(word=><option key={word.itemKey} value={word.itemKey}>{word.word}</option>)}</select></label>
          <button className={`${button} self-end`} disabled={busy || done}>替换未开始词</button>
          <p className="basis-full text-xs opacity-60">已开始、已学过或来源不明确的词不能作为新词替换。</p>
        </form>}
      </details>
    </li>;
  }
  const feedback=<>
    {props.message && <p role="status" className="mt-4 border-l-2 border-[var(--orange)] pl-3 text-sm leading-relaxed">{props.message}</p>}
    {props.offline && <p className="mt-3 text-sm">离线 · 使用上次完整同步的资料与本机新记录，不代表已核对其他设备。</p>}
  </>;
  const minimumStatus=<DailyMinimumStatus spec={props.minimumSpec??null} plan={plan} day={plan?.day??''} names={Object.fromEntries(catalog?.subjects.map(s=>[s.subjectId,s.name])??[])}/>;
  return <section className={props.studyFirst?'study-plan-board':'rounded-xl border border-[var(--line)] bg-[var(--surface)] p-5 sm:p-8 text-[var(--ink)]'} aria-labelledby={`${id}-title`} aria-busy={loading}>
    {!editing&&minimumStatus}
    {props.dirty&&<p role="status" className="mt-2 mb-3 text-sm text-[var(--warning)]">尚未保存到学习知识库 · 可在“调整安排”中保存。</p>}
    {feedback}
    {props.studyFirst&&plan&&<DashboardFocusHero summary={focusSummary} lead={focusLead} disabled={busy||!focusReady} keyboardEnabled={!props.activePractice&&!editing} onStart={()=>{if(focusLead)props.onStart(focusLead.taskId,focusTasks.map(task=>task.taskId));}} onAdvanced={()=>setEditing(true)}/>}
    <details className="study-plan-details" open={!props.studyFirst||!plan||undefined}><summary hidden={!props.studyFirst||!plan}>查看今日任务与进度</summary>
    <PlanRelationshipNotice allocation={plan?.longTermAllocation} hasPlan={Boolean(plan)} onLongTerm={props.onLongTerm}/>
    {props.studyFirst ? (
      <div className={plan ? "c-plan-columns" : "c-plan-unplanned"}>
        {plan && (
          <div className="c-plan-summary-col"><h3>今日任务</h3><div className="c-plan-metrics">
            <section className="c-metric-card">
              <div className="c-metric-line"><h4>新词</h4>
              <p className="c-metric-value"><b>
                {props.hasVerifiedHistory===false?'待核对':`${summary.newDone}`}
                </b><small>/ {summary.newTarget} 词</small>
              </p></div>
              <progress aria-label="新词任务完成" value={props.hasVerifiedHistory===false ? undefined : summary.newDone} max={Math.max(1,summary.newTarget)} />
              <p className="c-metric-caption">
                {props.hasVerifiedHistory===false?'完成情况待核对':`还需学习 ${Math.max(0, summary.newTarget - summary.newDone)} 词`}
              </p>
            </section>
            <section className="c-metric-card">
              <div className="c-metric-line"><h4>全部到期复习</h4>
              <p className="c-metric-value"><b>
                {props.hasVerifiedHistory===false?'待核对':`${summary.reviewDone}`}
                </b><small>/ {summary.reviewTotal} 项</small>
              </p></div>
              <progress aria-label="到期复习完成" value={props.hasVerifiedHistory===false ? undefined : summary.reviewDone} max={summary.reviewTotal || 1} />
              <p className="c-metric-caption">
                {props.hasVerifiedHistory===false?'完成情况待核对':plan?.longTermAllocation?.reviewTarget!=null?`默认目标 ${plan.longTermAllocation.reviewTarget} 条，可追加；这里显示全部到期内容`:`还需复习 ${Math.max(0, summary.reviewTotal - summary.reviewDone)} 项`}
              </p>
            </section>
            </div><button type="button" className="c-btn-plan-adjust c-plan-adjust-btn flex items-center gap-2 text-sm font-bold text-[var(--blue)] py-2" onClick={()=>setEditing(true)} aria-haspopup="dialog">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>
              </svg>
              <span>调整安排</span>
            </button>

          </div>
        )}
        <div className="study-plan-execution">
          {!plan ? (
            <div className="c-plan-empty">
              <StudyEmptyPlanIcon/>
              <div>
                <h4>今天还没生成计划</h4>
                <p>生成计划后开始学习，或先进行自由学习。</p>
              </div>
              <div className="flex gap-3 mt-3">
                <button type="button" className="c-btn-orange" disabled={busy} onClick={props.onGenerate}>生成计划</button>
                <a className="c-free-study-link" href="#study-subjects">自由学习</a>
              </div>
            </div>
          ) : (
            <>
              {props.hasVerifiedHistory!==false && summary.newMissing>0 && (
                <p role="status" className="mb-4 text-sm text-[var(--orange)]">可用新词不足，还缺 {summary.newMissing} 个。请补充词库或核对历史身份，不会用复习凑数。</p>
              )}
              <div><h3>学习任务 <small>（按学科）</small></h3>
                <StudySubjectTaskGroups {...navigation} tasks={plan.tasks} practiceBudgetGroups={plan.longTermAllocation?.practiceBudgetGroups} reviewTarget={plan.longTermAllocation?.reviewTarget??undefined} reviewScopeKey={JSON.stringify([plan.day,plan.sourceHash])} startedTaskIds={plan.manual.lockedTaskIds} subjects={(catalog?.subjects??[]).map(subject=>({subjectId:subject.subjectId,name:subject.name,kind:subject.words.length?'words' as const:undefined}))} ready={ready} busy={loading} completedTaskIds={completedTaskIds} onStart={props.onStart} canStart={task=>task.action.kind==='practice'||task.action.kind==='open-note'} renderTask={taskRow}/>
              </div>
              <div className="c-plan-footnote mt-6 pt-4 border-t border-[var(--line)] flex flex-col sm:flex-row justify-between text-xs text-[var(--muted)] gap-2">
                <span>ⓘ 今日新词安排 {newAssigned} 词 · 全部到期复习 {summary.reviewTotal} 条{plan.longTermAllocation?.reviewTarget!=null?` · 默认复习目标 ${plan.longTermAllocation.reviewTarget} 条（可追加）`:""}</span>
                <span>完成表示任务已做完，不等于完全掌握。</span>
              </div>
            </>
          )}
        </div>
      </div>
    ) : (
      <>
        {!plan ? (
          <div className="py-7"><h3 className="font-bold">今天还没生成计划</h3><p className="mt-2 mb-4 text-sm opacity-60">你仍可选择学科自由学习。无需先填写学习时长。</p><button className={`${button} bg-[var(--ink)] text-[var(--surface)]`} disabled={busy} onClick={props.onGenerate}>生成今日安排</button></div>
        ) : (
          <>
            <div className="my-6 grid grid-cols-1 sm:grid-cols-2 border-y border-[var(--line)]" aria-label="每日必做">
              <div className="py-5 sm:pr-5"><p className="text-sm opacity-60">新学单词</p><p className="mt-1 text-2xl font-bold tabular-nums">{props.hasVerifiedHistory===false?'待核对':`${summary.newDone} / ${summary.newTarget}`}</p><p className="text-xs opacity-60 mt-1">旧词复习不占新词名额</p></div>
              <div className="py-5 sm:pl-5 sm:border-l border-[var(--line)]"><p className="text-sm opacity-60">到期复习</p><p className="mt-1 text-2xl font-bold tabular-nums">{props.hasVerifiedHistory===false?'待核对':`${summary.reviewDone} / ${summary.reviewTotal}`}</p><p className="text-xs opacity-60 mt-1">包括逾期；完成后仍保留在今日计数中</p></div>
            </div>
            {props.hasVerifiedHistory!==false && summary.newMissing>0 && <p role="status" className="mb-4 text-sm text-[var(--orange)]">可用新词不足，还缺 {summary.newMissing} 个。请补充词库或核对历史身份，不会用复习凑数。</p>}
            <div className="space-y-6">{(['required','subject','optional'] as const).map(section=>{
              const tasks=plan.tasks.filter(task=>section==='required'?task.category!=='subject' && task.required:section==='subject'?task.category==='subject' && task.required:!task.required);
              const reviewCount=tasks.filter(task=>task.category==='review').length;let seenReviews=0;
              const visible=tasks.filter(task=>task.category!=='review' || ++seenReviews<=reviewLimit);
              return <div key={section}><h3 className="text-base font-bold mb-3">{section==='required'?'每日必做':section==='subject'?'学科任务':'自主加学'}</h3>
                {tasks.length?<ol className="space-y-2">{visible.map(task=>taskRow(task,taskIndexes.get(task.taskId)!))}</ol>
                  :<p className="text-sm opacity-60">{section==='required'?'暂无待列入的必做内容。':section==='subject'?'没有需要补充的指标任务；无指标学科的建议列在自主加学。':'暂未安排，可刷新建议或手动添加。'}</p>}
                {reviewCount>reviewLimit && <button className={`${button} mt-3`} onClick={()=>setReviewPage({day:plan.day,count:reviewLimit+50})}>展开更多复习（已显示 {reviewLimit} / {reviewCount}）</button>}
              </div>;
            })}</div>
          </>
        )}
      </>
    )}
    <details className="c-local-plan-heading flex flex-wrap justify-between items-center gap-4 mb-4"><summary>计划与同步状态</summary>
      <div>
        <h2 id={`${id}-title`} className="study-plan-title">{props.studyFirst?'今日任务':'今日学习'}</h2>
        <p className="mt-1 text-sm opacity-60">新词数量依今日安排，复习另算；可以按每日目标逐步完成。按学科进度生成任务，在练习中理解与巩固。</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className={button} disabled={loading} onClick={props.onReload}>{loading?'正在核对…':'刷新'}</button>
        {plan && <button type="button" className={button} onClick={()=>setEditing(true)} aria-haspopup="dialog">调整安排</button>}
      </div>
    </details>
    <StudyPanel open={editing} onClose={()=>setEditing(false)} title="调整今日安排">
      {minimumStatus}
      {feedback}
      <div className="mt-6 pt-5 border-t border-[var(--line)] flex flex-wrap gap-2">
        <button className={button} disabled={busy} onClick={props.onGenerate}>刷新今天的安排</button>
        {props.onTopUpMinimums&&<button className={button} disabled={busy||props.activePractice} onClick={props.onTopUpMinimums}>按长线最低量补齐今日草稿</button>}
        <button className={button} disabled={busy || props.offline} onClick={()=>props.onSuggest('standard')}>AI 推荐额外任务</button>
        <button className={button} disabled={busy} onClick={()=>props.onSuggest('less')}>少安排一点</button>
        <button className={button} disabled={busy || props.offline} onClick={()=>props.onSuggest('more')}>再加一点</button>
      </div>
      <label className="mt-4 flex flex-wrap items-center gap-2 text-sm"><span>本次额外学习时间（分钟）</span><input key={`${plan?.day}:${plan?.optionalMinutes}`} type="number" min={0} step={1} placeholder="不限制" className={`${field} w-28`} defaultValue={plan?.optionalMinutes??''} disabled={busy} onBlur={event=>{
        const raw=event.target.value;const value=raw===''?undefined:Number(raw);
        if(value===undefined || Number.isSafeInteger(value) && value>=0) props.onOptionalMinutes(value);
      }} /><span className="text-xs opacity-60">只供本次额外选做任务参考，不覆盖长线时间目标或必做任务。</span></label>
      {subject && <details className="mt-5 rounded-lg border border-[var(--line)] p-4"><summary className="cursor-pointer font-bold text-sm focus-visible:outline-2">手动添加任务</summary>
        <form className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3" onSubmit={event=>{
          event.preventDefault();const form=event.currentTarget,values=new FormData(form),title=unit?.title??String(values.get('title')??'').trim();
          if(!title) return;
          props.onEdit({type:'upsert',task:{taskId:`manual:${crypto.randomUUID()}`,subjectId:subject.subjectId,title,category:'subject',origin:'manual',required:false,
            unitIds:unit?[unit.unitId]:[],quantity:unit?1:Number(values.get('quantity')),action:unit?unit.action:{kind:'manual'},completionRule:unit?.completionRule??'self-report',sourceHash:unit?.sourceHash??catalog!.sourceHash}});
        }}>
          <label className="flex flex-col gap-1"><span className="text-xs opacity-60">学科</span><select className={field} value={subject.subjectId} onChange={event=>{setSubjectChoice(event.target.value);setUnitChoice('');}}>{catalog?.subjects.map(subject=><option key={subject.subjectId} value={subject.subjectId}>{subject.name}</option>)}</select></label>
          <label className="flex flex-col gap-1"><span className="text-xs opacity-60">学习单元</span><select className={field} value={unitChoice} onChange={event=>setUnitChoice(event.target.value)}><option value="">自定义待办（仅自报，不更新掌握状态）</option>{subject.units.map(unit=><option key={unit.unitId} value={unit.unitId} disabled={Boolean(plan&&planningUnitAlreadyScheduled(unit,plan.tasks,'complete'))}>{unit.title}</option>)}</select></label>
          {!unit && <><label className="flex flex-col gap-1"><span className="text-xs opacity-60">任务名称</span><input name="title" className={field} maxLength={200} placeholder="例如：整理今天的阅读笔记" /></label><label className="flex flex-col gap-1"><span className="text-xs opacity-60">本次数量</span><input className={field} name="quantity" type="number" min={1} step={1} defaultValue={1} /></label></>}
          <button className={`${button} justify-self-start`} disabled={busy}>添加到今天</button>
        </form></details>}
      <div className="mt-6 flex flex-wrap items-center gap-3"><button className={`${button} bg-[var(--ink)] text-[var(--surface)]`} disabled={busy || props.offline || !props.dirty} onClick={props.onSave}>保存到学习知识库</button><p className="text-sm opacity-60" role="status">{props.dirty?'尚未保存到学习知识库':props.offline?'上次保存的安排（离线）':'已保存的今日安排'}</p></div>
      <details className="mt-5 text-xs opacity-60"><summary className="cursor-pointer focus-visible:outline-2">同步与计划诊断</summary><dl className="mt-2 space-y-1 break-all"><dt>最近完整同步</dt><dd>{props.lastSyncedAt??'尚未核对'}</dd><dt>待同步任务记录</dt><dd>{props.pendingCount??0}</dd><dt>草稿版本</dt><dd>{plan?.draftVersion}</dd><dt>计划校验值</dt><dd>{plan?.planHash}</dd></dl>{catalog?.diagnostics.map((diagnostic,index)=><p key={index}>{diagnostic.message}</p>)}
        {props.hasBackup && <button className={`${button} mt-3`} disabled={busy || props.offline} onClick={props.onRestoreBackup}>恢复上一份本机草稿</button>}
      </details>
    </StudyPanel>
    </details>
  </section>;
}
