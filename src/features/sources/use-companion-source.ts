'use client';
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import type {CompanionSourcePayload} from '../../domain/sources';
import {createCompanionSession,type CompanionPorts,type CompanionOperation} from '../../application/sources';
const idle={detect:false,pair:false,refresh:false,poll:false};
type Options<Connection,Source extends CompanionSourcePayload>=Omit<CompanionPorts<Connection,Source>,'abort'|'busy'>&{
  scope:string;connection:Connection|null;retry:number;retryMs:number;
};
export function useCompanionSource<Connection,Source extends CompanionSourcePayload>(options:Options<Connection,Source>){
  const binding=useMemo(()=>({scope:options.scope,connection:options.connection}),[options.scope,options.connection]),live=useRef(options);
  type Session=ReturnType<typeof createCompanionSession<Connection,Source>>;
  const current=useRef<{binding:typeof binding;session:Session}|null>(null),launch=useRef<{binding:typeof binding;timer:number|null}|null>(null);
  const [view,setView]=useState<{binding:typeof binding;busy:Record<CompanionOperation,boolean>}|null>(null);
  useLayoutEffect(()=>{live.current=options;});
  useLayoutEffect(()=>{
    let active=true;const launchState={binding,timer:null as number|null};launch.current=launchState;
    const session:Session=createCompanionSession({capture:()=>{const frame=live.current.capture(),hostCurrent=frame.current;return{...frame,current:():boolean=>active&&current.current?.session===session&&hostCurrent()};},
      health:(...args)=>live.current.health(...args),pair:(...args)=>live.current.pair(...args),source:(...args)=>live.current.source(...args),
      publish:notice=>live.current.publish(notice),apply:(...args)=>live.current.apply(...args),flushActivities:()=>live.current.flushActivities(),
      busy:(operation,value)=>{if(active)setView(previous=>({binding,busy:{...(previous?.binding===binding?previous.busy:idle),[operation]:value}}));},abort:()=>new AbortController(),
    });current.current={binding,session};
    return()=>{active=false;session.dispose();if(current.current?.session===session)current.current=null;if(launchState.timer!==null)window.clearTimeout(launchState.timer);};
  },[binding]);
  const get=useCallback(()=>current.current?.binding===binding?current.current.session:null,[binding]);
  useEffect(()=>{
    if(!options.connection)return;let active=true,timer:number|undefined;
    const poll=async()=>{const ready=await get()?.poll();if(active)timer=window.setTimeout(()=>void poll(),ready?60000:options.retryMs);};
    timer=window.setTimeout(()=>void poll(),0);return()=>{active=false;if(timer!==undefined)window.clearTimeout(timer);};
  },[get,options.connection,options.retry,options.retryMs]);
  return {
    busy:view?.binding===binding?view.busy:idle,
    detect:useCallback(async()=>get()?.detect()??false,[get]),pair:useCallback(async()=>get()?.pair()??false,[get]),
    refresh:useCallback(async()=>get()?.refresh()??false,[get]),cancel:useCallback(()=>get()?.cancel(),[get]),
    detectAfterLaunch:useCallback(()=>{const state=launch.current;if(state?.binding!==binding)return;if(state.timer!==null)window.clearTimeout(state.timer);state.timer=window.setTimeout(()=>{state.timer=null;void get()?.detect();},2500);},[get,binding]),
  };
}
