'use client';
import {useCallback,useLayoutEffect,useRef,useState} from 'react';
import type {LongTermPlanSpec} from './long-term-plan-types';
import type {AdviceSubject} from './long-term-ai-advice';
import {applyLongTermAIAdvice,longTermAdvicePrompt} from './long-term-ai-advice';
import {useOptionalStudyAIWorkspace} from './components/ai-sidebar/study-ai-workspace';
import {studyAIErrorMessage} from './ai/study-ai-errors';

export function LongTermAIPlanner({spec,subjects,planningStart,active,disabled,onApply,onSettings,currentSourceStamp,onBusyChange}:{spec:LongTermPlanSpec;subjects:AdviceSubject[];planningStart:string;active:boolean;disabled:boolean;onApply:(value:LongTermPlanSpec)=>void;onSettings?:()=>void;currentSourceStamp:()=>string;onBusyChange?:(busy:boolean)=>void}){
 const workspace=useOptionalStudyAIWorkspace(),settings=workspace?.settings;
 const [goal,setGoal]=useState(''),[requestState,setRequestState]=useState<{identity:string;token:number}|null>(null),[message,setMessage]=useState('');
 const request=useRef<AbortController|null>(null),epoch=useRef(0);
 const identity=JSON.stringify([spec,subjects,planningStart,settings?.revision,workspace?.scope,active]);
 const busy=requestState?.identity===identity;
 const identityRef=useRef(identity);
 const invalidate=useCallback(()=>{epoch.current++;const pending=request.current;request.current=null;setRequestState(null);pending?.abort();onBusyChange?.(false);},[onBusyChange]);
 useLayoutEffect(()=>{identityRef.current=identity;return invalidate;},[identity,invalidate]);
 const ready=Boolean(workspace&&settings?.enabled&&settings.configured&&settings.model&&settings.serverAvailable!==false);
 async function generate(){
  if(!workspace||!settings||!ready||!goal.trim()||busy||disabled)return;
  const token=++epoch.current,stamp=currentSourceStamp(),born=identity;
  const controller=new AbortController();request.current=controller;setRequestState({identity,token});onBusyChange?.(true);setMessage('正在根据你的目标和资料数量建议节奏…');
  try{
   const prompt=longTermAdvicePrompt(goal,spec,subjects,planningStart);
   let answer='';
   for await(const event of workspace.service.chat({requestId:`long-term-advice:${crypto.randomUUID()}`,provider:settings.provider,model:settings.model,settingsRevision:settings.revision,context:{id:'long-term-planning',title:'长线学习节奏建议'},messages:[{role:'user',content:prompt}]},controller.signal)){
    if(token!==epoch.current||identityRef.current!==born)return;
    if(event.type==='delta'){answer+=event.text;if(answer.length>20000)throw new Error('AI 建议过长，已保留原设置，请简化需求后重试。');}
   }
   if(token!==epoch.current||identityRef.current!==born)return;
   if(stamp!==currentSourceStamp())throw new Error('资料或进度刚刚变化，请重新生成建议；你的设置已保留。');
   const next=applyLongTermAIAdvice(answer,spec,planningStart);
   onApply(next);setMessage('AI 建议已填入下方。你可以修改，再预览实际能否排下。尚未保存。');
  }catch(error){if(token===epoch.current&&!controller.signal.aborted)setMessage(error instanceof Error&&error.message.startsWith('AI ')?error.message:error instanceof Error&&error.message.startsWith('资料')?error.message:studyAIErrorMessage(error));}
  finally{controller.abort();if(request.current===controller){request.current=null;setRequestState(null);onBusyChange?.(false);}}
 }
 return <details className="long-term-ai"><summary><span aria-hidden="true">✦</span><strong>让 AI 帮我制订计划</strong><span>先建议，再由你决定</span></summary><div>
  <label>你的目标与偏好<textarea value={goal} maxLength={2000} rows={3} disabled={disabled||busy} onChange={e=>setGoal(e.target.value)} placeholder="例如：两个月备考雅思，工作日每天 40 分钟，优先背词；复习先安排 20 条，有余力再追加。"/></label>
  <p>只发送你填写的需求、学科名称和资料数量，不发送笔记正文。使用当前已配置模型；点击生成才会调用 API。</p>
  <div className="long-term-actions">{ready?<button type="button" className="study-primary-action" disabled={disabled||busy||!goal.trim()} onClick={()=>void generate()}>{busy?'AI 正在规划…':'生成 AI 计划建议'}</button>:<><span>先配置并启用 AI，即可自动生成建议；下方也可以直接手动设置。</span><button type="button" className="study-secondary-action" onClick={onSettings}>配置 AI</button></>}{busy&&<button type="button" className="study-secondary-action" onClick={()=>{epoch.current++;request.current?.abort();request.current=null;setRequestState(null);onBusyChange?.(false);setMessage('已停止生成，原设置保留。');}}>停止生成</button>}</div>
  {message&&<p role="status" className="long-term-ai-message">{!busy&&message.startsWith('正在根据')?'设置已变化，之前的 AI 请求已取消。':message}</p>}
 </div></details>;
}
