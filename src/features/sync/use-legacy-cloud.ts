'use client';
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef} from 'react';
import {createLegacyCloudSession,type LegacyCloudPorts} from '../../application/sync';
export function useLegacyCloud(options:LegacyCloudPorts&{scope:string;ready:boolean;retry:number}){
  const binding=useMemo(()=>({scope:options.scope}),[options.scope]),live=useRef(options);
  const active=useRef<{binding:typeof binding;session:ReturnType<typeof createLegacyCloudSession>}|null>(null);
  useLayoutEffect(()=>{live.current=options;});
  useLayoutEffect(()=>{
    let alive=true;
    const session=createLegacyCloudSession({capture:()=>{const frame=live.current.capture();return{...frame,current:()=>alive&&frame.current()};},
      read:signal=>live.current.read(signal),migrate:(...args)=>live.current.migrate(...args),restore:(...args)=>live.current.restore(...args),
      baselines:(...args)=>live.current.baselines(...args),bootstrap:()=>live.current.bootstrap(),status:value=>live.current.status(value),message:value=>live.current.message(value)});
    active.current={binding,session};return()=>{alive=false;session.dispose();if(active.current?.session===session)active.current=null;};
  },[binding]);
  const get=useCallback(()=>active.current?.binding===binding?active.current.session:null,[binding]);
  useEffect(()=>{if(!options.ready)return;const timer=window.setTimeout(()=>void get()?.read(),0);return()=>window.clearTimeout(timer);},[get,options.ready,options.retry]);
  return{migrate:useCallback(async()=>get()?.migrate(),[get]),invalidate:useCallback(()=>get()?.invalidate(),[get]),retry:useCallback(()=>{get()?.invalidate();void get()?.read();},[get])};
}
