'use client';
import {useMemo,useState} from 'react';
import {simulateSandboxPacing,type SandboxScenario} from './sandbox-pacing';

export function SandboxPacingSimulator({today,canApply,onApply,onConnect}:{today:string;canApply:boolean;onApply?:(ids:string[]|null)=>void;onConnect?:()=>void}){
 const [days,setDays]=useState(7),[wordQuota,setWordQuota]=useState(4),[practiceQuota,setPracticeQuota]=useState(2),[reviewTarget,setReviewTarget]=useState(6),[scenario,setScenario]=useState<SandboxScenario>('normal'),[selected,setSelected]=useState(0);
 const {snapshot,baseline,playableIds,missedDate}=useMemo(()=>simulateSandboxPacing({today,days,quota:6,wordQuota,practiceQuota,reviewTarget,scenario}),[today,days,wordQuota,practiceQuota,reviewTarget,scenario]);
 const active=snapshot.schedule[Math.min(selected,snapshot.schedule.length-1)];
 const peak=Math.max(1,...snapshot.schedule.map(s=>s.learningMinutes+s.reviewMinutes));
 const newTotal=snapshot.schedule.filter(s=>s.date!==missedDate).reduce((sum,s)=>sum+s.newItemIds.length,0);
 return <div className="long-term-workspace sandbox-pacing">
  <header className="long-term-intro"><p className="long-term-eyebrow">公开样例 · 交互沙盒</p><h3>试试每天背多少、复习多少。</h3><p>12 个 IELTS 词汇 + 6 个 Python 练习。调整下面的数量，看看每天会怎样安排。</p></header>
  <div className="sandbox-controls">
   <label>目标完成周期 <strong>{days} 天</strong><input type="range" min="0" max="2" step="1" value={[3,7,14].indexOf(days)} aria-valuetext={`${days} 天`} onChange={e=>{setDays([3,7,14][Number(e.target.value)]);setSelected(0);}}/><span>3 天冲刺 · 7 天稳固 · 14 天长线</span></label>
   <label>每天背新词 <strong>{wordQuota} 个</strong><input aria-label="演示每天背新词" type="number" min="0" max="12" value={wordQuota} onChange={e=>setWordQuota(Math.min(12,Math.max(0,Math.trunc(Number(e.target.value)))))}/><span>公开词汇共 12 个，复习另算</span></label>
   <label>每天新学 Python <strong>{practiceQuota} 题</strong><input aria-label="演示每天新学Python" type="number" min="0" max="6" value={practiceQuota} onChange={e=>setPracticeQuota(Math.min(6,Math.max(0,Math.trunc(Number(e.target.value)))))}/><span>公开 Python 共 6 题</span></label>
   <label>每天先复习 <strong>{reviewTarget} 条</strong><input aria-label="演示每日复习目标" type="number" min="0" max="30" value={reviewTarget} onChange={e=>setReviewTarget(Math.min(30,Math.max(0,Math.trunc(Number(e.target.value)))))}/><span>演示复习目标；实际学习时可以追加</span></label>
  </div>
  <fieldset className="sandbox-scenarios"><legend>试试计划中途发生变化</legend>{([['normal','按原计划'],['add','第 2 天新增 6 项'],['miss','第 2 天请假']] as const).map(([value,label])=><button key={value} type="button" aria-pressed={scenario===value} onClick={()=>setScenario(value)}>{label}</button>)}</fieldset>
  <p className="long-term-helper">{scenario==='normal'?'先完成新学，再按预计到期日复习。上限不是必须凑满的任务量。':scenario==='add'?'假设第 1 天已完成，第 2 天新增 4 个词汇与 2 个 Python 练习；从第 2 天重新分配。新增项仅为预测占位。':'假设第 1 天已完成、第 2 天未学习；从第 3 天重新安排未完成内容。灰色请假日不计为完成。'}</p>
  <div className="sandbox-summary" aria-live="polite"><strong>{snapshot.backlog.length?`${snapshot.backlog.length} 项新学超出期限`:'新学可排入期限'}</strong><span>可安排新学 {newTotal} 项 · 每天最多 45 分钟</span>{scenario!=='normal'&&<small>原计划期限外 {baseline.backlog.length} 项 → 本情景 {snapshot.backlog.length} 项</small>}</div>
  <div className="sandbox-legend"><span><i/>新学</span><span><i/>预计复习</span><small>柱高为预计分钟</small></div>
  <div className="sandbox-chart" style={{gridTemplateColumns:`repeat(${days},minmax(0,1fr))`}} aria-label="每日新学与复习预测">
   {snapshot.schedule.map((slot,index)=>{const missed=slot.date===missedDate;return <button type="button" key={slot.date} aria-pressed={active.date===slot.date} aria-label={`第 ${index+1} 天，${missed?'请假':`新学 ${slot.newItemIds.length} 项，预计复习 ${slot.reviewItemIds.length} 项`}`} onClick={()=>setSelected(index)}><span className="sandbox-bar">{!missed&&<><i className="sandbox-review" style={{height:`${slot.reviewMinutes/peak*100}%`}}/><i className="sandbox-new" style={{height:`${slot.learningMinutes/peak*100}%`}}/></>}{missed&&<small>休</small>}</span><span>{index+1}</span></button>;})}
  </div>
  <div className="long-term-day"><strong>第 {active.dayIndex} 天 · {active.date.slice(5)}</strong><p>{active.date===missedDate?'请假，未完成当日任务。':`新词 ${active.expectedNewItems['ielts-vocabulary']??0} 个 + Python ${active.expectedNewItems['python-basics']??0} 题 · 预计复习 ${active.reviewItemIds.length} 项 · 约 ${Math.round((active.learningMinutes+active.reviewMinutes)*10)/10} 分钟`}</p>{active.unservedReviewMinutes>0&&<p>另有约 {Math.round(active.unservedReviewMinutes)} 分钟复习未列入当天目标。</p>}</div>
  <details className="long-term-assumptions"><summary>算法怎样预测？</summary><p>使用正式排期引擎与 ts-fsrs，假设每次回答 Good、目标留存率 90%，关闭随机扰动。词汇新学 / 复习按 1 / 0.5 分钟，Python 按 4 / 2 分钟估算，每日预留 30% 时间供复习。实际复习间隔由记忆状态决定，并非固定的第 1、2、4、7 天。</p><p>这不是你的记忆曲线或掌握记录。新增笔记和缺课后，系统会在剩余预算内重新排期；放不下的任务会显示在期限外，不承诺自动完成。</p></details>
  <footer className="long-term-actions"><button type="button" className="study-primary-action" disabled={!canApply||playableIds.length===0} onClick={()=>onApply?.(playableIds)}>在演示模式中体验此节奏</button><button type="button" className="study-secondary-action" onClick={onConnect}>连接我的笔记库，开始定制真实计划 →</button><button type="button" disabled={!canApply} onClick={()=>onApply?.(null)}>恢复全部演示题</button></footer>
  <p className="long-term-helper">{canApply&&playableIds.length===0?'这个演示日没有新题。可调整新词或 Python 数量；复习情景仅展示预测。':canApply?'体验将今天切换为本节奏第 1 天的公开样例；情景中的假设完成不计入记录。刷新页面恢复全部样例。':'当前不是公开样例，或还有未提交的作答；可先预览节奏。'}</p>
 </div>;
}
