'use client';
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {useSourceReader} from './use-source-reader';

type Options<T>={scope:string;resource:object;enabled:boolean;active:boolean;revision?:number;read:()=>Promise<T>};
type View<T>={binding:object;phase:'loading'|'ready'|'failed';value:T|null;checkedAt:string|null};
/** A configuration read is independent of recovery export and never tests a model. */
export function useSettingsAiRead<T>(options:Options<T>){
 const binding=useMemo(()=>({scope:options.scope,resource:options.resource,enabled:options.enabled}),[options.scope,options.resource,options.enabled]);
 const current=useRef(binding);useLayoutEffect(()=>{current.current=binding;},[binding]);
 const [view,setView]=useState<View<T>|null>(null);
 const reader=useSourceReader({scope:options.scope,resource:options.resource,
  capture:()=>({ready:options.enabled,current:()=>current.current===binding}),
  read:()=>options.read(),
  publish:value=>setView({binding,phase:'ready',value,checkedAt:new Date().toISOString()}),
  error:()=>setView({binding,phase:'failed',value:null,checkedAt:null}),
 });
 const read=reader.read,cancel=reader.cancel;
 const refresh=useCallback(async()=>{
  if(!binding.enabled||current.current!==binding)return;
  setView({binding,phase:'loading',value:null,checkedAt:null});
  await read(undefined);
 },[binding,read]);
 useEffect(()=>{if(options.active&&options.enabled)void refresh();return cancel;},[options.active,options.enabled,options.revision,refresh,cancel]);
 const visible=view?.binding===binding?view:null;
 return{phase:visible?.phase??'idle',value:visible?.value??null,checkedAt:visible?.checkedAt??null,refresh};
}
