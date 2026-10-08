"use client";
import './ux-remedies.css';
import {accountLoadLabel,accountLoadDetail,type AccountLoadStatus} from './account-study-load-state';
import {accountReadNoticePlacement} from '../src/domain/sources';
type NoticeProps={state:AccountLoadStatus;onRefresh:()=>void;onResolveLibrary?:()=>void};

export function AccountReadNoticeSlot({at,hasSource,...props}:NoticeProps&{at:'above'|'details';hasSource:boolean}){
  return accountReadNoticePlacement(props.state,hasSource)===at?<AccountReadNotice {...props}/>:null;
}

export function StudyWorkspaceGate({phase,onRetry}:{phase:'checking-identity'|'loading-local'|'identity-error'|'storage-error';onRetry:()=>void}){
  const error=phase==='identity-error'||phase==='storage-error';
  const title=phase==='identity-error'?'暂时无法确认账号':phase==='storage-error'?'本机记录暂时无法读取':phase==='loading-local'?'正在恢复本机记录':'正在确认学习空间';
  const detail=phase==='identity-error'?'个人资料读取已暂停，没有把身份错误当成游客登录。':phase==='storage-error'?'原有记录没有被覆盖。请检查浏览器存储后重试。':phase==='loading-local'?'账号已确认，正在读取这个空间已保存的学习记录。':'确认身份之后，才会读取个人缓存。';
  return <main className="study-workspace-gate"><span className="study-gate-brand">知学</span><section role="status"><h1>{title}</h1><p>{detail}</p>{error&&<button type="button" onClick={onRetry}>重新检查</button>}</section></main>;
}
export function AccountReadNotice({state,onRefresh,onResolveLibrary}:NoticeProps){
  if(state.phase==='not-connected'&&!state.deferred)return <details className="study-account-read-note study-account-optional" data-phase={state.phase}><summary><span className="study-account-read-pill"><i aria-hidden="true"/>{accountLoadLabel(state)}</span> · 查看连接说明</summary><p>{accountLoadDetail(state)} <a href="/companion-guide" target="_blank" rel="noreferrer">查看启用步骤</a></p><button type="button" onClick={onRefresh}>刷新</button></details>;
  const compactCache=state.phase==='cached'&&!state.deferred;
  const standalone=state.phase==='not-connected'||state.phase==='failed';
  const showDetail=standalone||Boolean(state.deferred)||['cached','cleared','library-changed'].includes(state.phase);
  return <div className="study-account-read-note" data-phase={state.phase} role="status"><div>{standalone?<span className="study-account-read-pill">{accountLoadLabel(state)}</span>:<span>{compactCache?'已显示保存的资料':accountLoadLabel(state)}</span>}{showDetail&&<p>{compactCache?'正在检查账号更新。':accountLoadDetail(state)}{state.phase==='not-connected'&&<> <a href="/companion-guide" target="_blank" rel="noreferrer">查看启用步骤</a></>}</p>}</div>{state.phase!=='loading'&&<button type="button" onClick={state.phase==='library-changed'&&onResolveLibrary?onResolveLibrary:onRefresh}>{state.phase==='library-changed'?'确认学习库':state.phase==='failed'?'重试':'刷新'}</button>}</div>;
}
