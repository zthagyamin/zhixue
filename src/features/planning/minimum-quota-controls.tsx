'use client';
import type {LongTermPlanSpec} from '../../domain/planning';
import {withMinimumWordTargets} from '../../domain/planning';

export function MinimumQuotaControls({spec,wordSubjects,busy,onChange}:{
  spec:LongTermPlanSpec;wordSubjects:string[];busy:boolean;onChange:(spec:LongTermPlanSpec)=>void;
}){
  const needsMinimum=wordSubjects.some(id=>spec.subjectsConfig.find(s=>s.subjectId===id)?.dailyMinimumTarget===undefined);
  return <section className="long-term-form-section" aria-label="数量与时间规则">
    <h4>数量与时间怎样安排</h4>
    {needsMinimum&&<><p>部分词库仍使用每日上限，不能保障最低词量。</p>
      <button type="button" disabled={busy||!wordSubjects.length} className="study-secondary-action"
        onClick={()=>onChange(withMinimumWordTargets(spec,wordSubjects))}>将词汇数量改为每日最低目标</button>
      <p className="long-term-helper">先预览再保存；原计划不会自动改变。</p></>}
    <label>时间安排方式<select disabled={busy} value={spec.timeBudgetMode??'limit'}
      onChange={event=>onChange({...spec,timeBudgetMode:event.target.value as 'advisory'|'limit'})}>
      <option value="advisory">词量优先 · 时间仅供参考</option>
      <option value="limit">按估算限制时间 · 可能达不到最低量</option>
    </select></label>
    <p className="long-term-helper">尚无个人有效耗时数据，用时待估。词量优先时，默认分钟数不会削减最低量；弹性任务参考剩余时间安排。缓冲日保留最低量。</p>
  </section>;
}

export function MinimumQuotaPreview({spec,counts,names,warnings}:{
  spec:LongTermPlanSpec;counts:Record<string,number>;names:Map<string,string>;warnings:string[];
}){
  const goals=spec.subjectsConfig.filter(s=>(s.dailyMinimumTarget??0)>0);
  if(!goals.length)return null;
  return <div className="long-term-notice" aria-label="最低目标核对">
    {goals.map(s=><p key={s.subjectId}>{names.get(s.subjectId)??s.subjectId}：已安排 {counts[s.subjectId]??0} / 最低 {s.dailyMinimumTarget}
      {(counts[s.subjectId]??0)<s.dailyMinimumTarget!&&<strong> · 仍有缺口，请核对可用资料、前置条件或时间限制</strong>}</p>)}
    {warnings.includes('estimate-over-budget')&&<p>默认估算超过参考时间，最低数量已保留。这不是实际耗时结论；可调整弹性任务或根据实际节奏继续。</p>}
  </div>;
}
