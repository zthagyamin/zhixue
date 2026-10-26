'use client';
import {useEffect} from 'react';
import {StudyAISettings} from '../components/ai-sidebar';
import {useOptionalStudyAIWorkspace} from '../components/ai-sidebar/study-ai-workspace';
import {useSettingsAiRead} from '../../src/features/sources/use-settings-ai-read';
import {settingsAiConnection,type SettingsStatus} from '../study-settings-model';
import type {AccountAiSettingsResponse} from '../account-study-client';

type Props={scope:string;resource:object;account:boolean;signedIn:boolean;localOnline:boolean;read:()=>Promise<AccountAiSettingsResponse>;fallback:SettingsStatus;onOpen:()=>void};
export function SettingsAiOverview(props:Props){
 const workspace=useOptionalStudyAIWorkspace();
 const reading=useSettingsAiRead({scope:props.scope,resource:props.resource,enabled:props.account&&props.signedIn,active:true,revision:workspace?.settings?.revision,read:props.read});
 const localWorkspace=!props.account&&workspace?.scope.mode==='local'?workspace:null;
 const localReading=useSettingsAiRead({scope:props.scope,resource:localWorkspace?.service??props.resource,enabled:Boolean(localWorkspace&&props.localOnline),active:true,read:async()=>{await localWorkspace?.reload();}});
 const checking=props.account?reading.phase==='loading':localReading.phase==='loading';
 const status=props.account
  ?reading.phase==='loading'?{label:'正在核对',detail:'正在读取当前账号的 AI 配置，不会调用模型。',tone:'muted' as const}
   :reading.phase==='failed'?{label:'暂无法核对',detail:'配置读取失败，原配置保留。请重新核对。',tone:'warning' as const}
    :settingsAiConnection({mode:'account',signedIn:props.signedIn,accountAi:reading.value,companionOnline:false})
  :localWorkspace?checking&&!localWorkspace.settings?{label:'正在核对',detail:'正在读取本机 AI 配置，不会调用模型。',tone:'muted' as const}
    :settingsAiConnection({mode:'local',signedIn:props.signedIn,accountAi:null,companionOnline:props.localOnline,localSettings:localWorkspace.settings,localSettingsFailed:localReading.phase==='failed'||Boolean(localWorkspace.error)})
   :props.fallback;
 return <div>
  <button type="button" className="c-settings-connection-row flex items-center justify-between p-4 rounded-2xl border border-[var(--line)] bg-[var(--surface)] text-left w-full" onClick={props.onOpen} aria-busy={checking}>
   <div><h5 className="font-bold text-sm text-[var(--ink)]">{props.account?'账号 AI':'本机 AI'}</h5><p className="text-xs text-[var(--ink)] opacity-60">智能辅助服务</p></div>
   <div className="text-right"><span className={status.tone==='good'?'text-emerald-600 dark:text-emerald-400':'text-amber-600 dark:text-amber-400'}>{status.label}</span><p className="text-xs text-[var(--ink)] opacity-60">{status.detail}</p></div><span aria-hidden="true">›</span>
  </button>
  {(props.account&&props.signedIn||Boolean(localWorkspace&&props.localOnline))&&<div className="mt-2 text-xs"><button type="button" className="study-secondary-action" disabled={checking} onClick={()=>props.account?reading.refresh():localReading.refresh()}>重新核对 AI 状态</button><p role="status">{status.label} · {status.detail}</p>{(props.account?reading.checkedAt:localReading.checkedAt)&&<p>最近核对：{new Date((props.account?reading.checkedAt:localReading.checkedAt)!).toLocaleString('zh-CN')}</p>}</div>}
 </div>;
}
export function SettingsAiSection({available,onOpen}:{available:boolean;onOpen:()=>void}){
 const workspace=useOptionalStudyAIWorkspace();
 const reload=workspace?.reload;
 useEffect(()=>{if(available&&reload)void reload();},[available,reload]);
 return available?<StudyAISettings/>:<div><h4 className="font-bold text-sm text-[var(--ink)] mb-1">AI 学习助手</h4><p className="text-xs text-[var(--ink)] opacity-60 mb-4">按当前账号或本机连接方式配置 AI。读取配置不会调用模型。</p><button type="button" className="study-primary-action" onClick={onOpen}>打开 AI 与 API Key 设置</button></div>;
}
