'use client';
import {useEffect,useState} from 'react';
import packageInfo from '../package.json';
import {parseRelease,makeDiagnosticReport} from './release-support-model';
import './release-support.css';

async function checkRelease(signal?:AbortSignal):Promise<string>{
  const response=await fetch('/api/release',{cache:'no-store',signal:signal??AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error('release-unavailable');
  const version=parseRelease(await response.json());
  if(!version)throw new Error('release-invalid');
  return version;
}
export function ReleaseNotice(){
  const [available,setAvailable]=useState<string|null>(null);
  const [dismissed,setDismissed]=useState<string|null>(null);
  useEffect(()=>{
    let stopped=false,lastCheck=0;
    const controller=new AbortController();
    async function check(){
      if(document.visibilityState==='hidden'||Date.now()-lastCheck<300000)return;
      lastCheck=Date.now();
      try{const next=await checkRelease(AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]));if(!stopped)setAvailable(next!==packageInfo.version?next:null);}catch{/* An unavailable check never triggers a reload. */}
    }
    void check();document.addEventListener('visibilitychange',check);
    const timer=setInterval(()=>void check(),300000);
    return()=>{stopped=true;controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',check);};
  },[]);
  if(!available||dismissed===available)return null;
  return <aside className="release-notice" aria-label="网站更新" role="status"><span>网站已更新至 v{available}。请先完成并确认保存当前作答，再手动刷新。</span><a href="/updates" target="_blank" rel="noreferrer">查看更新</a><button type="button" onClick={()=>setDismissed(available)}>稍后处理</button></aside>;
}
export function ReleaseSupport({companionVersion,digest}:{companionVersion?:string|null;digest?:string}){
  const [report,setReport]=useState('');
  const [message,setMessage]=useState('');
  const [checking,setChecking]=useState(false);
  async function check(){setChecking(true);try{const version=await checkRelease();setMessage(version===packageInfo.version?'当前页面已是最新版本。':`网站现为 v${version}。请确认作答已保存，再手动刷新。`);}catch{setMessage('暂时无法检查更新，请稍后重试。');}finally{setChecking(false);}}
  function generate(){setReport(makeDiagnosticReport({version:packageInfo.version,companionVersion,digest,pathname:window.location.pathname,userAgent:navigator.userAgent,now:new Date()}));setMessage('报告已生成，请预览后自行分享。');}
  async function copy(){try{await navigator.clipboard.writeText(report);setMessage('报告已复制。');}catch{setMessage('自动复制不可用，请选中下方报告手动复制。');}}
  return <section className="release-support" aria-label="版本与帮助"><h2>版本与帮助</h2><p>当前网页 v{packageInfo.version} · Companion {companionVersion?`v${companionVersion}`:'版本未读取'}</p><div className="release-actions"><button type="button" disabled={checking} onClick={()=>void check()}>{checking?'正在检查…':'检查更新'}</button><a href="/updates" target="_blank" rel="noreferrer">更新说明</a><a href="/help" target="_blank" rel="noreferrer">使用帮助</a><button type="button" onClick={generate}>生成诊断报告</button></div><p>报告只包含版本、页面类别、浏览器类别和故障编号；生成前不读取笔记、作答或登录凭据，不自动发送。</p>{report&&<><label htmlFor="zhixue-diagnostic">诊断报告预览</label><textarea id="zhixue-diagnostic" readOnly value={report} rows={9}/><button type="button" onClick={()=>void copy()}>复制报告</button></>}{message&&<p role="status">{message}</p>}</section>;
}
