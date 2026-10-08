'use client';
import {useId,useState,type ReactNode} from 'react';
import {groupStudyTasks,type StudyGroupTask,type StudyTaskGroup} from './study-subject-task-groups-model';
import './study-subject-task-groups.css';
import {practiceBudgetView} from './study-review-goal';
import type {PracticeBudgetGroup} from '../src/domain/planning';
import {PracticeBudgetStatus} from '../src/features/planning';
type Subject={subjectId:string;name:string;kind?:'words'|'code'|'paper'|'math'|'course'};
type Props<T extends StudyGroupTask>={practiceBudgetGroups?:readonly PracticeBudgetGroup[];tasks:readonly T[];subjects?:readonly Subject[];completedTaskIds:readonly string[];startedTaskIds?:readonly string[];verifiedStartedTaskIds?:readonly string[];withheldTaskIds?:readonly string[];finishedPassTaskIds?:readonly string[];reviewSelectionTaskIds?:readonly string[];onReviewSelectionChange?:(ids:string[])=>void;practiceGroupByTask?:Record<string,string>;eligibleTaskIds?:string[];reviewTarget?:number;reviewScopeKey?:string;ready:boolean;busy?:boolean;onStart?:(taskId:string,eligibleTaskIds?:string[])=>void;canStart?:(task:T)=>boolean;renderTask:(task:T,index:number,eligibleTaskIds?:string[])=>ReactNode};
export function StudySubjectTaskGroups<T extends StudyGroupTask>(props:Props<T>){
 const scope=JSON.stringify([props.reviewScopeKey,props.reviewTarget,props.reviewSelectionTaskIds,props.practiceBudgetGroups]),[addition,setAddition]=useState({scope:'',count:0});
 const [appended,setAppended]=useState<{scope:string;ids:string[]}>({scope:'',ids:[]});
 const extra=addition.scope===scope?addition.count:0;
 const available=props.tasks.filter(task=>!props.withheldTaskIds?.includes(task.taskId));
 const selected=[...props.reviewSelectionTaskIds??[],...(!props.onReviewSelectionChange&&appended.scope===scope?appended.ids:[])];
 const goal=practiceBudgetView(available,props.reviewTarget,extra,props.completedTaskIds,[...props.startedTaskIds??[],...props.finishedPassTaskIds??[]],selected,props.practiceBudgetGroups);
 const append=(ids:string[])=>{const next=[...new Set([...selected,...ids])];setAppended({scope,ids:next});props.onReviewSelectionChange?.(next);};
 const addReviews=(count:number)=>{
   if(props.practiceBudgetGroups?.length){append(goal.deferred.slice(0,Math.max(0,count-extra)).map(task=>task.taskId));return;}
   setAddition({scope,count});props.onReviewSelectionChange?.(practiceBudgetView(available,props.reviewTarget,count,props.completedTaskIds,[...props.startedTaskIds??[],...props.finishedPassTaskIds??[]],props.reviewSelectionTaskIds).visible.map(task=>task.taskId));
 };
 const groups=groupStudyTasks(goal.visible,props),indexes=new Map(props.tasks.map((task,index)=>[task.taskId,index]));
 return <div className="study-subject-task-groups" aria-label="按学科归组的今日任务">
  <PracticeBudgetStatus budgets={goal.budgets} tasks={available} subjects={props.subjects} onAppend={append} disabled={Boolean(props.busy||!props.ready)}/>
  {goal.reviewOverTarget>0&&<p role="status" className="study-review-goal">已完成、已开始或明确追加的复习超出每日数量目标 {goal.reviewOverTarget} 条，仍全部保留。</p>}
  {props.withheldTaskIds?.length ? <details className="study-review-goal"><summary>{props.withheldTaskIds.length} 项材料待完善，暂不自测</summary><p>材料与已有记录保留。可进入对应学科查看原文；补充明确问题和参考答案后再复习。</p><ul>{props.tasks.filter(task=>props.withheldTaskIds?.includes(task.taskId)).map(task=><li key={task.taskId}>{task.title}</li>)}</ul></details> : null}
  {props.reviewTarget!==undefined&&<section className="study-review-goal" aria-label="每日复习目标"><div><strong>今日先复习 {goal.target} 条</strong><span>{props.ready?`已完成 ${goal.completed} 条`:'完成情况待核对'} · {props.withheldTaskIds?.length?'可自测':'全部到期'} {goal.total} 条</span></div><p>默认目标 {props.reviewTarget} 条；少于目标时按实际到期数量安排。可追加，已开始的复习不会移出。</p>{goal.deferred.length>0&&<><p className="study-review-goal-pending">还有 {goal.deferred.length} 条到期复习未列入本次目标，仍保留在到期队列。</p><div className="study-review-goal-actions"><button type="button" disabled={props.busy||!props.ready} onClick={()=>addReviews(extra+10)}>再加 {Math.min(10,goal.deferred.length)} 条复习</button><button type="button" disabled={props.busy||!props.ready} onClick={()=>addReviews(goal.total)}>加入全部{props.withheldTaskIds?.length?'可练':'到期'}复习</button></div><details><summary>查看其余 {goal.deferred.length} 条到期复习</summary><ul>{goal.deferred.map(task=><li key={task.taskId}>{task.title}</li>)}</ul></details></>}{extra>0&&<small>追加仅作用于本次页面；默认目标可在长线计划中调整。</small>}</section>}
  {groups.map(group=><SubjectGroup key={group.subjectId} {...props} eligibleTaskIds={goal.visible.map(task=>task.taskId)} group={group} subject={props.subjects?.find(subject=>subject.subjectId===group.subjectId)} indexes={indexes}/>)}</div>;
}
function SubjectGroup<T extends StudyGroupTask>({group,subject,indexes,...props}:Props<T>&{group:StudyTaskGroup<T>;subject?:Subject;indexes:Map<string,number>}){
 const [open,setOpen]=useState(false),[limit,setLimit]=useState(20),id=useId();
 const name=subject?.name??'学习任务',complete=group.completed===group.tasks.length;
 const kind=subject?.kind??(group.newWords?'words':/python|代码|编程/i.test(name)?'code':/数学|计算|math/i.test(name)?'math':/论文|paper|reading|阅读/i.test(name)?'paper':'course');
 return <section className="study-subject-task-group" data-complete={complete||undefined}>
  <div className="study-subject-task-heading"><StudySubjectGlyph kind={kind}/><div className="study-subject-task-title"><h4>{name}</h4><p>{group.newWords>0&&<span>新词 {group.newWords}</span>}{group.reviews>0&&<span>复习 {group.reviews} 项</span>}{!group.newWords&&!group.reviews&&<span>{group.tasks.length} 项学习任务</span>}{group.blocked>0&&<span className="study-subject-blocked">{group.blocked} 项待核对</span>}</p></div><span className="study-subject-task-count">{group.completed===null?'待核对':<><strong>{group.completed}</strong> / {group.tasks.length}<small>任务完成</small></>}</span></div>
  <div className="study-subject-task-footer"><button type="button" className="study-subject-task-expand" aria-expanded={open} aria-controls={id} onClick={()=>setOpen(value=>!value)}>{open?'收起明细':`展开 ${group.tasks.length} 项任务`}<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" aria-hidden="true"><path d="m6 8 4 4 4-4"/></svg></button>{group.next&&props.onStart?<button type="button" className="study-subject-task-start" disabled={props.busy||!props.ready} onClick={()=>props.onStart?.(group.next!.taskId,props.eligibleTaskIds)}>{group.started?'继续学习':'开始学习'}<span aria-hidden="true">→</span></button>:complete?<span className="study-subject-task-done">✓ 本科目任务已完成</span>:<button type="button" className="study-subject-task-start" disabled={props.busy||!props.ready} onClick={()=>setOpen(true)}>查看任务 →</button>}</div>
  {open&&<div id={id} className="study-subject-task-items"><ol className="account-plan-execution-list">{group.tasks.slice(0,limit).map(task=>props.renderTask(task,indexes.get(task.taskId)!,props.eligibleTaskIds))}</ol>{group.tasks.length>limit&&<button type="button" className="study-subject-task-more" onClick={()=>setLimit(value=>value+20)}>继续展开 · 还有 {group.tasks.length-limit} 项</button>}</div>}
 </section>;
}
export function StudySubjectGlyph({kind}:{kind:NonNullable<Subject['kind']>}){
 const shapes:Record<NonNullable<Subject['kind']>,ReactNode>={
  words:<><path d="M5 6c4-2 7-1 9 1 2-2 5-3 9-1v18c-4-2-7-1-9 1-2-2-5-3-9-1V6Z" fill="currentColor" opacity=".12"/><path d="M4 5c4-2 7-1 10 1 3-2 6-3 10-1v18c-4-2-7-1-10 1-3-2-6-3-10-1V5Zm10 1v18M8 10h3m6 0h3M8 14h3m6 0h3"/></>,
  code:<><rect x="3" y="5" width="22" height="19" rx="4" fill="currentColor" opacity=".12"/><rect x="3" y="4" width="22" height="20" rx="4"/><path d="M3 9h22m-16 5-3 3 3 3m10-6 3 3-3 3m-4-8-2 10M7 6.5h.1m3 0h.1"/></>,
  paper:<><path d="M8 3h12l5 5v17H8z" fill="currentColor" opacity=".12"/><path d="M7 3h11l5 5v16H7V3Zm11 0v6h5M11 13h8m-8 4h8m-8 4h5M3 7v19h16"/></>,
  math:<><rect x="3" y="3" width="22" height="22" rx="5" fill="currentColor" opacity=".12"/><rect x="3" y="3" width="22" height="22" rx="5"/><path d="M8 8h5m-2.5-2.5v5M17 8h4M8 18l4 4m0-4-4 4M17 18h4m-4 4h4"/></>,
  course:<><path d="m3 10 11-6 11 6-11 6-11-6Z" fill="currentColor" opacity=".12"/><path d="m3 9 11-6 11 6-11 6L3 9Zm5 4v8c4 3 8 3 12 0v-8m5-4v11M14 7v.1"/></>,
 };
 return <span className="study-subject-task-icon" data-kind={kind} aria-hidden="true"><svg width="29" height="29" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round">{shapes[kind]}</svg></span>;
}
