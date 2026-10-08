"use client";
import {useCallback,useEffect,useLayoutEffect,useRef,useState,useSyncExternalStore,type Dispatch,type SetStateAction,type ReactNode} from 'react';
import type {LearningDraftAdapter,LearningDraftStore} from './learning-draft-store';

/** A mounted plugin pins one buffer generation; later stale callbacks cannot repopulate it. */
export function useLearningDraftState<T>(draft:LearningDraftAdapter|undefined,field:string,initial:T|(()=>T)):[T,Dispatch<SetStateAction<T>>]{
  const holder=useRef(draft);
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const [value,setValue]=useState<T>(()=>{const fallback=typeof initial==='function'?(initial as ()=>T)():initial;return draft?draft.read(field,fallback):fallback;});
  const current=useRef(value);
  const set=useCallback((update:SetStateAction<T>)=>{
    if(!mounted.current)return;
    const next=typeof update==='function'?(update as (old:T)=>T)(current.current):update;
    current.current=next;holder.current?.write(field,next);setValue(next);
  },[field]);
  return [value,set];
}
const serverSnapshot=()=>0;
export function LearningDraftLeaveGuard({store}:{store:LearningDraftStore}){
  useSyncExternalStore(store.subscribe,store.getSnapshot,serverSnapshot);
  const needsWarning=store.isPending()||store.hasUnrecoverableInput()||store.failureTitles().length>0;
  useEffect(()=>{
    if(!needsWarning)return;
    const beforeUnload=(event:BeforeUnloadEvent)=>{
      if(!store.isPending()&&!store.hasUnrecoverableInput()&&!store.failureTitles().length)return;
      event.preventDefault();event.returnValue='';
    };
    window.addEventListener('beforeunload',beforeUnload);
    return()=>window.removeEventListener('beforeunload',beforeUnload);
  },[store,needsWarning]);
  return null;
}
export function LearningDraftNotice({store}:{store:LearningDraftStore}){
  useSyncExternalStore(store.subscribe,store.getSnapshot,serverSnapshot);
  const pending=store.isPending(),failures=store.failureTitles();
  return <>
    {!pending&&!failures.length&&!store.isUnavailable()&&store.hasUnsavedInput()&&<p role="status" className="study-save-notice">{store.hasDurableRecovery?.()?'输入已保存在本机；账号同步状态见当前题目。':'输入仅暂存在当前页面，刷新或关闭后不会恢复；已保存的学习记录不受影响。'}</p>}
    {pending&&<p role="status" className="study-save-notice">{store.isGrading()?'上一份作答正在判定，完成后可继续答题…':'正在保存在本机，稍候继续…'}</p>}
    {failures.length>0&&<p role="status" className="study-save-notice">{failures.join('、')}尚未保存成功。输入暂留在当前页面；返回原题可重试，请勿关闭或刷新。</p>}
    {store.isUnavailable()&&<p role="status" className="study-save-notice">临时恢复暂不可用。当前输入仍可继续，切换前请先自行保留。</p>}
  </>;
}
export function LearningDraftBoundary({store,children,onVisibility,interactiveWhileGrading=false}:{store:LearningDraftStore;children:ReactNode;onVisibility?:(visible:boolean)=>void;interactiveWhileGrading?:boolean}){
  useLayoutEffect(()=>{onVisibility?.(true);return()=>onVisibility?.(false);},[onVisibility]);
  useSyncExternalStore(store.subscribe,store.getSnapshot,serverSnapshot);
  const pending=store.isPending();
  return <div className="study-draft-boundary">
    <LearningDraftNotice store={store}/>
    {/* Recall disables its own answer controls, leaving only its cancel action reachable. Writes still lock the entire boundary. */}
    <fieldset disabled={pending&&!(interactiveWhileGrading&&store.isGrading())} aria-busy={pending}>{children}</fieldset>
  </div>;
}
