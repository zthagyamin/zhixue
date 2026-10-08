'use client';
import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createDailyPlanSession,type DailyRevision,type DailyPlanPorts,type DailyPlanView} from '../../application/planning';

export function useDailyPlanView<State extends DailyRevision,Source>(scope:string|null,day:string,ports:DailyPlanPorts<State,Source>|null){
  type Session=ReturnType<typeof createDailyPlanSession<State,Source>>;
  const [view,setView]=useState<DailyPlanView<State,Source>|null>(null);
  const latest=useRef<DailyPlanView<State,Source>|null>(null);
  const current=useRef<{scope:string;day:string;ports:DailyPlanPorts<State,Source>;session:Session}|null>(null);
  useLayoutEffect(()=>{
    const bound=current.current;
    if(bound&&(bound.scope!==scope||bound.day!==day||bound.ports!==ports)){bound.session.dispose();current.current=null;}
  },[scope,day,ports]);
  useEffect(()=>{
    if(!scope||!ports)return;
    const session=createDailyPlanSession({...ports,scope,day,initialView:latest.current,
      publish:value=>{latest.current=value;setView(value);}});
    current.current={scope,day,ports,session};
    const run=()=>{void session.refresh().catch(()=>{});};
    const initial=window.setTimeout(run,0),timer=window.setInterval(()=>{if(!document.hidden)run();},30000);
    const visible=()=>{if(!document.hidden)run();};document.addEventListener('visibilitychange',visible);
    return()=>{
      session.dispose();if(current.current?.session===session)current.current=null;
      window.clearTimeout(initial);window.clearInterval(timer);document.removeEventListener('visibilitychange',visible);
    };
  },[scope,day,ports]);
  const refresh=useCallback(async(revision?:number,isCurrent?:()=>boolean)=>{
    if(!scope||!ports||current.current?.scope!==scope||current.current.day!==day||current.current.ports!==ports)throw Error('账号题库尚未就绪。');
    return current.current.session.refresh(revision,isCurrent);
  },[scope,day,ports]);
  const visible=view?.scope===scope&&view.day===day?view:null;
  return {state:visible?.state??null,source:visible?.source??null,ready:visible?.ready??false,error:visible?.error??null,refresh,prepare:refresh};
}
