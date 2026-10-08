import {useId,useState} from 'react';
import type {CalculationSupport} from './calculation-support';
import {exploreExpression} from './symbolic-math';
export function CalculationExploration({config}:{config:NonNullable<CalculationSupport['exploration']>}){
 const uid=useId();const defaults=()=>Object.fromEntries(config.parameters.map(p=>[p.id,p.defaultValue]));
 const [values,setValues]=useState(defaults);const output=exploreExpression(config.expression,values);
 return <section className="mt-6 border-t border-[var(--line)] pt-4" aria-label="参数探索">
  <p className="font-semibold">参数探索</p><p className="text-sm text-[var(--muted)]">调节参数观察结果。提交答案仍按原题判分。</p>
  <code className="block my-3 break-all">{config.expression}</code>
  {config.parameters.map(p=><div key={p.id} className="block my-3"><div className="flex justify-between gap-3"><label htmlFor={`${uid}-${p.id}`}>{p.label}</label><output>{values[p.id]}</output></div><input id={`${uid}-${p.id}`} aria-label={p.label} className="w-full" type="range" min={p.min} max={p.max} step={p.step} value={values[p.id]} onChange={e=>setValues({...values,[p.id]:e.target.value})}/></div>)}
  <p aria-live="polite">探索结果：{output===null?'当前表达式暂不支持计算':Number(output.toPrecision(8)).toString()}</p>
  <button type="button" className="study-secondary-action mt-2" onClick={()=>setValues(defaults())}>恢复初始参数</button>
 </section>;
}
