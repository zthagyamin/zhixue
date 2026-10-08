'use client';
import type {LongTermPlanSpec,PracticeBudgetGroup,PracticeBudgetSummary} from '../../domain/planning';

export function PracticeBudgetControls({spec,subjects,busy,onChange}:{spec:LongTermPlanSpec;subjects:readonly {subjectId:string;name:string}[];busy:boolean;onChange:(spec:LongTermPlanSpec)=>void}){
  const groups=spec.practiceBudgetGroups??[];
  const update=(next:PracticeBudgetGroup[])=>onChange({...spec,practiceBudgetGroups:next});
  const change=(index:number,patch:Partial<PracticeBudgetGroup>)=>update(groups.map((group,i)=>i===index?{...group,...patch}:group));
  const add=()=>{let n=1;while(groups.some(group=>group.id===`practice-budget-${n}`))n++;update([...groups,{id:`practice-budget-${n}`,title:'共享练习',subjectIds:[],minutes:15,defaultItemMinutes:3}]);};
  return <section className="long-term-form-section" aria-label="可选共享练习预算">
    <h4>共享练习预算 <small>可选 · 默认不启用</small></h4>
    <p className="long-term-helper">所选学科共用每天的练习时间，先复习再做新练习。新词最低量和自由阅读不受影响。保存预览后用于后续每日安排。</p>
    {groups.map((group,index)=><fieldset key={group.id} className="my-3 border border-[var(--line)] p-3">
      <legend>{group.title||'共享练习'}</legend>
      <div className="long-term-fields">
        <label>组名称<input aria-label={`预算组 ${index+1} 名称`} value={group.title} disabled={busy} onChange={event=>change(index,{title:event.target.value})}/></label>
        <label>每天共用分钟<input type="number" min="0" max="180" step="1" value={group.minutes} disabled={busy} onChange={event=>change(index,{minutes:Number(event.target.value)})}/></label>
        <label>缺少估时按每项<input type="number" min="1" max="30" step="1" value={group.defaultItemMinutes} disabled={busy} onChange={event=>change(index,{defaultItemMinutes:Number(event.target.value)})}/><small>分钟 · 无效估时也使用此值</small></label>
      </div>
      <div className="flex flex-wrap gap-3 py-3">{subjects.map(subject=><label key={subject.subjectId} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={group.subjectIds.includes(subject.subjectId)} disabled={busy||groups.some((other,i)=>i!==index&&other.subjectIds.includes(subject.subjectId))} onChange={event=>change(index,{subjectIds:event.target.checked?[...group.subjectIds,subject.subjectId]:group.subjectIds.filter(id=>id!==subject.subjectId)})}/>{subject.name}</label>)}</div>
      {!group.subjectIds.length&&<p role="status">请选择至少一个学科，才能预览保存。</p>}
      <button type="button" disabled={busy} className="min-h-11 text-sm underline disabled:opacity-40 focus-visible:outline hover:text-[var(--blue)]" onClick={()=>update(groups.filter((_,i)=>i!==index))}>删除此预算组</button>
    </fieldset>)}
    <button type="button" disabled={busy||groups.length>=8} onClick={add} className="min-h-11 text-sm font-bold text-[var(--blue)] disabled:opacity-40 focus-visible:outline hover:underline">添加共享预算组</button>
  </section>;
}

export function PracticeBudgetStatus({budgets,tasks,subjects,onAppend,disabled}:{budgets:readonly PracticeBudgetSummary[];tasks:readonly {taskId:string;title:string}[];subjects?:readonly {subjectId:string;name:string}[];onAppend:(ids:string[])=>void;disabled:boolean}){
  return <>{budgets.map(budget=><section key={budget.group.id} className="study-review-goal" aria-label={`${budget.group.title}共享预算`}>
    <strong>{budget.group.title} · 预计 {budget.estimatedMinutes} / {budget.group.minutes} 分钟</strong>
    <p>共享范围：{budget.group.subjectIds.map(id=>subjects?.find(subject=>subject.subjectId===id)?.name??id).join('、')}</p>
    <p>缺少或无效估时按每项 {budget.group.defaultItemMinutes} 分钟；当前 {budget.defaultEstimateCount} 项使用默认估时。</p>
    {budget.overMinutes>0&&<p role="status">已完成、已开始或明确保留的任务超出预算 {budget.overMinutes} 分钟，仍全部保留。</p>}
    {budget.deferredTaskIds.length>0&&<details><summary>还有 {budget.deferredTaskIds.length} 项未列入今日目标</summary><p>共享时间或复习数量目标已满；原任务和到期时间保留，可继续自由学习。</p><ul>{tasks.filter(task=>budget.deferredTaskIds.includes(task.taskId)).map(task=><li key={task.taskId} className="flex items-center justify-between gap-3"><span>{task.title}</span><button type="button" className="min-h-11 shrink-0 text-[var(--blue)] underline disabled:opacity-40" disabled={disabled} onClick={()=>onAppend([task.taskId])}>明确追加</button></li>)}</ul></details>}
  </section>)}</>;
}
