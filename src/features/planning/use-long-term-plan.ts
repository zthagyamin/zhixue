'use client';
import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {LongTermPlanMutation} from '../../domain/planning';
import {createLongTermPlanSession,type LongTermPlanSession,type LongTermPlanTransport,type LongTermPlanView} from '../../application/planning';

/** Timers and React publication only; revision and request ownership belong to the session. */
export function useLongTermPlanView(scope:string|null,transport:LongTermPlanTransport|null,options:{newId:()=>string;message:(error:unknown)=>string}){
  const [view,setView]=useState<LongTermPlanView|null>(null);
  const current=useRef<{scope:string;transport:LongTermPlanTransport;session:LongTermPlanSession}|null>(null);
  const latest=useRef<LongTermPlanView|null>(null);
  const {newId,message}=options;
  useLayoutEffect(()=>{
    const bound=current.current;
    if(bound&&(bound.scope!==scope||bound.transport!==transport)){bound.session.dispose();current.current=null;}
  },[scope,transport]);
  useEffect(()=>{
    if(!scope||!transport)return;
    const session=createLongTermPlanSession({scope,transport,newId,initialState:latest.current?.scope===scope?latest.current.state:null,
      publish:value=>{latest.current=value;setView(value);}});
    current.current={scope,transport,session};
    const timer=window.setTimeout(()=>{void session.refresh().catch(()=>{});},0);
    return()=>{session.dispose();window.clearTimeout(timer);if(current.current?.session===session)current.current=null;};
  },[scope,transport,newId]);
  const requireCurrent=useCallback(()=>{
    if(!scope||!transport||current.current?.scope!==scope||current.current.transport!==transport)throw Error('long-term-planning-unavailable');
    return current.current.session;
  },[scope,transport]);
  const refresh=useCallback(async()=>requireCurrent().refresh(),[requireCurrent]);
  const save=useCallback(async(value:Omit<LongTermPlanMutation,'operationId'>)=>requireCurrent().save(value),[requireCurrent]);
  const visible=view?.scope===scope?view:null;
  return {state:visible?.state??null,loading:visible?.loading??Boolean(scope),saving:visible?.saving??false,
    error:visible?.error?message(new Error(visible.error)):'',refresh,save};
}
