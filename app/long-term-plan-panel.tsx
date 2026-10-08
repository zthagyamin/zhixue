"use client";
import {MinimumQuotaPreview} from '../src/features/planning';
import {useEffect,useEffectEvent,useRef,useState} from 'react';
import type {LongTermPlanSpec,LongTermPlanSnapshot,DailyScheduleSlot} from './long-term-plan-types';
import type {LongTermEditorSource} from './long-term-editor-model';
import type {useLongTermPlan} from './use-long-term-plan';
import {defaultLongTermSpec,previewLongTermPlan,longTermMessage} from './long-term-editor-model';
import {dateOffset} from './long-term-plan-types';
import {calendarDay} from '../src/domain/planning';
import {StudyPanel} from './study-session-shell';
import {SandboxPacingSimulator} from './sandbox-pacing-simulator';
import {LongTermPlanForm} from './long-term-plan-form';
import './long-term-plan.css';

type Model=ReturnType<typeof useLongTermPlan>;
const phases={learning:'初学',consolidation:'巩固','final-sprint':'收尾'};
const count=(values:Record<string,number>)=>Object.values(values).reduce((sum,value)=>sum+value,0);
const minutes=(value:number)=>Math.round(value*10)/10;
function DayLabel({slot}:{slot:DailyScheduleSlot}){return <><span>{slot.date.slice(5).replace('-',' / ')}</span><small>{slot.isBufferDay?'缓冲日':phases[slot.phase]}</small></>;}

export function LongTermPlanPanel({scopeKey,today,model,loadSource,currentSourceStamp,onEditingChange,onSaved,canApplyDemo=false,onApplyDemo,onConnectSources,onAISettings,openRequest=0,onOpenRequestHandled}:{
  scopeKey:string|null;today:string;model:Model;loadSource:()=>Promise<LongTermEditorSource>;currentSourceStamp:()=>string;
  onEditingChange?:(editing:boolean)=>void;onSaved?:()=>void;
  canApplyDemo?:boolean;onApplyDemo?:(ids:string[]|null)=>void;onConnectSources?:()=>void;onAISettings?:()=>void;
  openRequest?:number;onOpenRequestHandled?:(request:number)=>void;
}){
  const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [aiBusy,setAiBusy]=useState(false);
  const [source,setSource]=useState<LongTermEditorSource|null>(null),[spec,setSpec]=useState<LongTermPlanSpec|null>(null);
  const [preview,setPreview]=useState<{snapshot:LongTermPlanSnapshot;revision:number;stamp?:string}|null>(null);
  const [selectedDay,setSelectedDay]=useState<string|null>(null),[allDays,setAllDays]=useState(false);
  const epoch=useRef(0);
  const previewHeading=useRef<HTMLHeadingElement>(null);
  const showRequested=useEffectEvent(()=>{void show();onOpenRequestHandled?.(openRequest);});
  useEffect(()=>{if(openRequest)showRequested();},[openRequest]);
  useEffect(()=>()=>{epoch.current++;onEditingChange?.(false);},[scopeKey,onEditingChange]);
  useEffect(()=>{if(!preview)return;const frame=window.requestAnimationFrame(()=>{previewHeading.current?.focus({preventScroll:true});previewHeading.current?.scrollIntoView({block:'start',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});});return()=>window.cancelAnimationFrame(frame);},[preview]);
  const saved=model.state?.snapshot??null,candidate=preview?.snapshot??saved;
  const tomorrow=dateOffset(today,1);
  function close(){epoch.current++;setOpen(false);setPreview(null);onEditingChange?.(false);}
  async function show(){
    setOpen(true);setMessage('');setPreview(null);onEditingChange?.(true);
    if(!scopeKey)return;
    const token=++epoch.current;setBusy(true);
    try{const [state,nextSource]=await Promise.all([model.refresh(),loadSource()]);if(token!==epoch.current)return;
      setSource(nextSource);setSpec(state.snapshot?.spec??defaultLongTermSpec(today,nextSource.subjects,crypto.randomUUID()));setSelectedDay(null);
    }catch(error){if(token===epoch.current)setMessage(longTermMessage(error));}finally{if(token===epoch.current)setBusy(false);}
  }
  async function calculate(nextSpec=spec){
    if(!nextSpec||!model.state||aiBusy)return;
    const token=++epoch.current;setBusy(true);setMessage('');
    try{const nextSource=await loadSource();await new Promise(resolve=>window.setTimeout(resolve,0));if(token!==epoch.current)return;
      const snapshot=previewLongTermPlan({spec:nextSpec,previous:saved,source:nextSource,today,generatedAt:new Date().toISOString()});
      setSource(nextSource);setSpec(snapshot.spec);setPreview({snapshot,revision:model.state.revision,stamp:nextSource.stamp});
      setSelectedDay(snapshot.asOfDate);setMessage('预览已生成，保存后才会应用到每日计划。');
    }catch(error){if(token===epoch.current){setPreview(null);setMessage(longTermMessage(error));}}finally{if(token===epoch.current)setBusy(false);}
  }
  async function save(){
    if(!preview||aiBusy)return;const token=epoch.current;setBusy(true);setMessage('');
    try{if(preview.stamp!==undefined&&preview.stamp!==currentSourceStamp())throw new Error('long-term-source-changed');
      await model.save({expectedRevision:preview.revision,enabled:true,snapshot:preview.snapshot});if(token!==epoch.current)return;setPreview(null);setMessage('长线计划已保存。今天的安排保留，新节奏从明天起应用。');onSaved?.();
    }catch(error){if(token===epoch.current){setMessage(longTermMessage(error));if(error instanceof Error&&['long-term-stale','long-term-source-changed'].includes(error.message))setPreview(null);}}finally{if(token===epoch.current)setBusy(false);}
  }
  async function toggle(){
    if(!model.state?.snapshot)return;const token=epoch.current;setBusy(true);setMessage('');
    try{const enabled=!model.state.enabled;if(enabled&&model.state.snapshot.spec.targetDeadline<tomorrow)throw new Error('long-term-deadline-future');await model.save({expectedRevision:model.state.revision,enabled,snapshot:model.state.snapshot});if(token!==epoch.current)return;setMessage(enabled?'已恢复长线节奏；已批准的今日任务仍保留。':'已暂停长线节奏，目标与历史排期保留。');onSaved?.();}
    catch(error){if(token===epoch.current)setMessage(longTermMessage(error));}finally{if(token===epoch.current)setBusy(false);}
  }
  function change(next:LongTermPlanSpec){setSpec(next);setPreview(null);setMessage('设置尚未保存，请重新预览。');}
  const upcoming=candidate?.schedule.filter(slot=>slot.date>=today).slice(0,14)??[];
  const peak=Math.max(1,...upcoming.map(slot=>slot.learningMinutes+slot.reviewMinutes+slot.unservedReviewMinutes));
  const day=candidate?.schedule.find(slot=>slot.date===selectedDay)??upcoming[0]??candidate?.schedule[0];
  const names=new Map(source?.bindings.map(binding=>[binding.itemId,binding.title])??[]);
  return <>
    <button type="button" className="long-term-launch" onClick={()=>void show()}><span aria-hidden="true">↗</span>长线计划{model.state?.enabled&&<small>{model.state.snapshot?.backlog.length?'待调整':'已启用'}</small>}</button>
    <StudyPanel open={open} onClose={close} title="长线学习计划" variant="center" dismissible={!busy}>
      {!scopeKey?<SandboxPacingSimulator today={today} canApply={canApplyDemo} onApply={ids=>{onApplyDemo?.(ids);close();}} onConnect={()=>{close();onConnectSources?.();}}/>:
      <div className="long-term-workspace" aria-busy={busy}>
        <header className="long-term-intro"><p className="long-term-eyebrow">你的学习节奏</p><h3>每天学多少，一眼看清。</h3><p>这里设置以后每天的数量、优先级与时间。今日安排负责具体任务；今天已生成的配额保留，后续安排采用新设置。</p></header>
        {(message||model.error)&&<p className="long-term-notice" role="status">{message||model.error}</p>}
        {busy&&!source&&<p className="long-term-loading" role="status">正在核对学习资料与已保存计划…</p>}
        {spec&&source&&<>
          <div className="long-term-form-head"><strong>{saved?'调整未来安排':'建立一个新目标'}</strong><span>{source.inventory.length} 项资料</span></div>
          <LongTermPlanForm key={`${spec.planId}:${open}`} spec={spec} source={source} tomorrow={tomorrow} startLocked={saved?.spec.planId===spec.planId} busy={busy} active={open} onChange={change} onAISettings={()=>{close();onAISettings?.();}} currentSourceStamp={currentSourceStamp} onAIBusyChange={setAiBusy}/>
          <div className="long-term-actions"><button type="button" className="study-primary-action" disabled={busy||aiBusy} onClick={()=>void calculate()}>{busy?'正在处理…':'看看每天怎么学'}</button>
            {saved&&<button type="button" className="study-secondary-action" disabled={busy||aiBusy} onClick={()=>{change(defaultLongTermSpec(today,source.subjects,crypto.randomUUID()));}}>另建目标</button>}
          </div>
        </>}
        {candidate&&<section className="long-term-preview" aria-label="排期预览">
          <header><div><span className="long-term-eyebrow">{preview?'预览 · 尚未保存':model.state?.enabled?'已保存 · 正在使用':'已保存 · 已暂停'}</span><h4 ref={previewHeading} tabIndex={-1}>{candidate.spec.startDate.replaceAll('-',' / ')} <span>—</span> {candidate.spec.targetDeadline.replaceAll('-',' / ')}</h4></div><span className="long-term-days">{candidate.estimatedTotalDays}<small>天</small></span></header>
          <div className="long-term-metrics"><div><strong>{candidate.totalInventoryCount}</strong><span>待规划内容</span></div><div data-alert={candidate.backlog.length>0}><strong>{candidate.backlog.length}</strong><span>超出当前安排</span></div><div><strong>{candidate.spec.dailyReviewTarget??candidate.learningCompletedItemIds.length}</strong><span>{candidate.spec.dailyReviewTarget===undefined?'已有完成记录':'每日复习目标 · 可追加'}</span></div></div>
          <p className="long-term-helper">排期核对日期：{calendarDay(candidate.lastRebalancedAt)}。新作答在下次核对时纳入；此处的预测不作为完成记录。</p>
          {candidate.backlog.length>0&&<div className="long-term-overflow"><strong>有资料尚未排入当前预览。</strong><p>默认耗时、资料状态或前置条件可能限制了弹性安排；这不是实际学习速度的结论。截止日期保持不变。</p>
            {candidate.adjustmentProposals.map((proposal,index)=><button type="button" className="study-secondary-action" key={index} disabled={busy||!proposal.feasible||!spec} onClick={()=>{
              if(!spec)return;const next=structuredClone(spec);if(proposal.kind==='extend-deadline'&&proposal.targetDeadline)next.targetDeadline=proposal.targetDeadline;
              else if(proposal.extraDailyMinutes!==undefined){next.dailyMinutesBudget.workdayMax+=proposal.extraDailyMinutes;next.dailyMinutesBudget.weekendMax+=proposal.extraDailyMinutes;}
              void calculate(next);
            }}>{proposal.kind==='extend-deadline'?`延至 ${proposal.targetDeadline}`:`每天增加 ${proposal.extraDailyMinutes} 分钟`}{!proposal.feasible?' · 仍不足':''}</button>)}
            <details><summary>查看未排入的内容</summary><ul>{candidate.backlog.slice(0,30).map(item=><li key={item.itemId}>{names.get(item.itemId)??'待核对的历史内容'}<small>{item.reason==='insufficient-learning-capacity'?'当前时间不足':item.reason}</small></li>)}</ul>{candidate.backlog.length>30&&<p>另有 {candidate.backlog.length-30} 项未排入。</p>}</details>
          </div>}
          {upcoming.length>0&&<><div className="long-term-chart-heading"><h5>每天的新学与复习</h5><span><i/>新学 <i/>复习</span></div><div className="long-term-chart-scroll"><div className="long-term-chart" role="group" aria-label="选择日期查看预计学习量">
            {upcoming.map(slot=><button type="button" key={slot.date} aria-pressed={day?.date===slot.date} aria-label={`${slot.date}，新学 ${count(slot.expectedNewItems)} 项，预计复习 ${count(slot.projectedReviews)} 项${slot.unservedReviewMinutes>0?'，复习超量':''}`} onClick={()=>setSelectedDay(slot.date)}>
              <span className="long-term-bar-track"><i className="long-term-bar-new" style={{height:`${slot.learningMinutes/peak*100}%`}}/><i className="long-term-bar-review" style={{height:`${slot.reviewMinutes/peak*100}%`}}/>{slot.unservedReviewMinutes>0&&<i className="long-term-bar-overflow" style={{height:`${slot.unservedReviewMinutes/peak*100}%`}}/>}</span><span>{slot.date.slice(8)}</span>
            </button>)}
          </div></div><p className="long-term-helper">按后续回答“良好”进行条件预测；实际到期时间由每次真实复习更新。</p></>}
          {day&&<div className="long-term-day">{day.date>=candidate.asOfDate?<MinimumQuotaPreview spec={candidate.spec} counts={day.expectedNewItems} names={new Map(source?.subjects.map(s=>[s.subjectId,s.name]))} warnings={day.warnings}/>:<p className="long-term-helper">这一天的已发安排保留；可回到今日页，手动核对并补齐最低词量。</p>}<header><DayLabel slot={day}/><b>用时待估 · 参考时间 {minutes(day.budgetMinutes)} 分钟</b></header><p>新学 {count(day.expectedNewItems)} 项 · 预计复习 {count(day.projectedReviews)} 项{day.unservedReviewMinutes>0?` · 另有约 ${minutes(day.unservedReviewMinutes)} 分钟复习待消化`:''}</p><ul className="long-term-day-breakdown">{source?.subjects.filter(subject=>(day.expectedNewItems[subject.subjectId]??0)+(day.projectedReviews[subject.subjectId]??0)>0).map(subject=><li key={subject.subjectId}><strong>{subject.name}</strong><span>新学 {day.expectedNewItems[subject.subjectId]??0} {source.bindings.filter(b=>b.subjectId===subject.subjectId).every(b=>b.kind==='vocabulary')?'词':'项'} · 复习 {day.projectedReviews[subject.subjectId]??0} 条</span></li>)}</ul>
            {day.newItemIds.length>0&&<details className="long-term-day-items"><summary>查看当天新学内容 · {day.newItemIds.length} 项</summary><ul>{day.newItemIds.slice(0,30).map(id=><li key={id}>{names.get(id)??'历史资料'}</li>)}</ul>{day.newItemIds.length>30&&<p>另有 {day.newItemIds.length-30} 项。</p>}</details>}
          </div>}
          <details className="long-term-calendar" onToggle={event=>setAllDays(event.currentTarget.open)}><summary>查看完整 {candidate.schedule.length} 天排期</summary>{allDays&&<div role="region" aria-label="完整排期表"><table><thead><tr><th>日期</th><th>阶段</th><th>新学</th><th>复习预测</th><th>分钟</th></tr></thead><tbody>{candidate.schedule.map(slot=><tr key={slot.date}><td><button type="button" onClick={()=>setSelectedDay(slot.date)}>{slot.date.slice(5)}</button></td><td>{slot.isBufferDay?'缓冲':phases[slot.phase]}</td><td>{count(slot.expectedNewItems)}</td><td>{count(slot.projectedReviews)}</td><td>{minutes(slot.learningMinutes+slot.reviewMinutes)}</td></tr>)}</tbody></table></div>}</details>
          {source&&<details className="long-term-assumptions"><summary>默认估算依据与待核对项（尚未个人校准）</summary><ul>{[...source.assumptions,...source.diagnostics.map(item=>item.message)].map((text,index)=><li key={index}>{text}</li>)}</ul><p>默认分钟数不是实际用时；图表仅为条件估算。排入日程不表示已经掌握；“正式掌握”需要知识库中的对应记录。</p></details>}
        </section>}
        {(preview||saved)&&<footer className="long-term-footer">{preview?<><span>明天起应用；今日任务与学习记录保留。</span><button type="button" className="study-primary-action" disabled={busy||aiBusy} onClick={()=>void save()}>保存并启用</button></>:<><span>{saved?.spec.targetDeadline&&saved.spec.targetDeadline<today?'目标日期已结束，可调整后继续。':`上次保存 ${saved?calendarDay(saved.lastRebalancedAt):''}`}</span><button type="button" className="study-secondary-action" disabled={busy||aiBusy} onClick={()=>void toggle()}>{model.state?.enabled?'暂停长线节奏':'恢复长线节奏'}</button></>}</footer>}
      </div>}
    </StudyPanel>
  </>;
}
