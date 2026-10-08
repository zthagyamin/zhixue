'use client';
import {useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import type {TaskPlanningSession,TaskPlanningBundle,TaskPlanningState} from '../../application/planning';

export function useNativePlanningView(options:{
  sessionKey:unknown;enabled:boolean;storageReady:boolean;workspaceId:string;day:string;evidenceEpoch:string;
  loadBundle:(workspace:string,day:string,full:boolean)=>Promise<TaskPlanningBundle>;
  restoreCachedStudy?:(workspace:string,bundle:TaskPlanningBundle)=>Promise<TaskPlanningBundle|void>;
  createSession:(runtime:{
    loadBundle:(workspace:string,day:string,full:boolean)=>Promise<TaskPlanningBundle>;
    restoreCachedStudy:(workspace:string,bundle:TaskPlanningBundle)=>Promise<TaskPlanningBundle|void>;
    publish:(state:TaskPlanningState)=>void;
  })=>TaskPlanningSession;
}){
  const binding=useMemo(()=>({sessionKey:options.sessionKey,enabled:options.enabled,storageReady:options.storageReady,workspaceId:options.workspaceId,day:options.day}),
    [options.sessionKey,options.enabled,options.storageReady,options.workspaceId,options.day]);
  const [view,setView]=useState<{state:TaskPlanningState;session:TaskPlanningSession;binding:typeof binding}|null>(null);
  const sessionRef=useRef<{session:TaskPlanningSession;binding:typeof binding}|null>(null);
  const loader=useRef(options.loadBundle),restore=useRef(options.restoreCachedStudy),factory=useRef(options.createSession);
  useLayoutEffect(()=>{loader.current=options.loadBundle;restore.current=options.restoreCachedStudy;factory.current=options.createSession;},[options.loadBundle,options.restoreCachedStudy,options.createSession]);
  const seen=useRef(''),pending=useRef(false);
  useLayoutEffect(()=>{const old=sessionRef.current;if(old&&old.binding!==binding){old.session.invalidate();sessionRef.current=null;}},[binding]);
  useEffect(()=>{
    if(!binding.sessionKey||!binding.enabled||!binding.storageReady)return;
    let active=true;seen.current='';pending.current=false;
    const session=factory.current({
      loadBundle:(workspace,day,full)=>loader.current(workspace,day,full),
      restoreCachedStudy:async(workspace,bundle)=>active?restore.current?.(workspace,bundle):undefined,
      publish:state=>{if(active)setView({state,session,binding});},
    });
    sessionRef.current={session,binding};void session.open(binding.workspaceId,binding.day).catch(()=>{});
    return()=>{active=false;session.invalidate();if(sessionRef.current?.session===session)sessionRef.current=null;};
  },[binding]);
  useEffect(()=>{
    const session=sessionRef.current?.session;if(!session)return;
    if(!seen.current){seen.current=options.evidenceEpoch;return;}
    if(seen.current!==options.evidenceEpoch){seen.current=options.evidenceEpoch;pending.current=true;session.evidenceChanged();}
    if(pending.current&&!session.snapshot().busy&&!session.snapshot().loading){pending.current=false;void session.refresh(false).catch(()=>{});}
  },[options.evidenceEpoch,view?.state.busy,view?.state.loading]);
  const current=view?.binding===binding&&binding.enabled&&binding.storageReady&&binding.sessionKey?view:null;
  return {state:current?.state??null,session:current?.session??null};
}
