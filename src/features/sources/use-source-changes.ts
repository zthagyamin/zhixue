'use client';
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef} from 'react';
import {createSourceChanges,type SourceChangesPorts} from '../../application/sources';
export function useSourceChanges<C,S>(options:SourceChangesPorts<C,S>&{scope:string;connection:object|null}){
  const binding=useMemo(()=>({scope:options.scope,connection:options.connection}),[options.scope,options.connection]),live=useRef(options);
  const active=useRef<{binding:typeof binding;value:ReturnType<typeof createSourceChanges<C,S>>}|null>(null);
  useLayoutEffect(()=>{live.current=options;});
  useLayoutEffect(()=>{
    live.current.loading(false);live.current.deciding(null);live.current.message('');live.current.publish({changes:[],scannedAt:null});
    let alive=true;const value=createSourceChanges<C,S>({current:()=>alive&&live.current.current(),connected:()=>live.current.connected(),account:()=>live.current.account(),
      list:()=>live.current.list(),scan:()=>live.current.scan(),decide:(...args)=>live.current.decide(...args),source:()=>live.current.source(),apply:value=>live.current.apply(value),
      publish:value=>live.current.publish(value),loading:value=>live.current.loading(value),deciding:id=>live.current.deciding(id),message:value=>live.current.message(value),scanError:value=>live.current.scanError(value)});
    active.current={binding,value};return()=>{alive=false;value.dispose();if(active.current?.value===value)active.current=null;};
  },[binding]);
  const get=useCallback(()=>active.current?.binding===binding?active.current.value:null,[binding]);
  useEffect(()=>{
    if(!options.connection)return;const read=()=>void get()?.read(),visible=()=>{if(!document.hidden)read();};
    const initial=window.setTimeout(read,0),timer=window.setInterval(visible,60000);document.addEventListener('visibilitychange',visible);
    return()=>{window.clearTimeout(initial);window.clearInterval(timer);document.removeEventListener('visibilitychange',visible);};
  },[get,options.connection]);
  return{read:useCallback(async()=>get()?.read(),[get]),scan:useCallback(async()=>get()?.scan(),[get]),decide:useCallback(async(id:string,choice:'approved'|'rejected'|'later')=>get()?.decide(id,choice),[get])};
}
