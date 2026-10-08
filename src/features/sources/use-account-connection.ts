'use client';
import {useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {createAccountConnection,type AccountConnectionPorts,type AccountConnectionView} from '../../application/sources';
const initial:AccountConnectionView={label:'我的电脑',message:'',busy:false,replacement:false,grant:null};
export function useAccountConnection<L>(options:Omit<AccountConnectionPorts<L>,'view'|'publish'|'current'>&{client:object}){
  const binding=useMemo(()=>({client:options.client}),[options.client]),live=useRef(options);
  const [state,setState]=useState({binding,value:initial}),view=useRef(initial);
  const session=useRef<{binding:typeof binding;value:ReturnType<typeof createAccountConnection<L>>}|null>(null);
  useLayoutEffect(()=>{live.current=options;});
  useLayoutEffect(()=>{
    let active=true;view.current={...initial};
    const value=createAccountConnection<L>({current:()=>active,view:()=>view.current,publish:patch=>{view.current={...view.current,...patch};setState({binding,value:view.current});},
      status:()=>live.current.status(),prepare:(...args)=>live.current.prepare(...args),start:id=>live.current.start(id),stop:id=>live.current.stop(id),
      read:kind=>live.current.read(kind),loaded:value=>live.current.loaded?.(value),count:value=>live.current.count(value),replacementRequired:error=>live.current.replacementRequired(error)});
    session.current={binding,value};return()=>{active=false;value.dispose();if(session.current?.value===value)session.current=null;};
  },[binding]);
  const get=useCallback(()=>session.current?.binding===binding?session.current.value:null,[binding]);
  useEffect(()=>{void get()?.status();},[get]);
  return{...(state.binding===binding?state.value:initial),setLabel:useCallback((label:string)=>{if(!get())return;view.current={...view.current,label};setState({binding,value:view.current});},[get,binding]),
    refresh:useCallback(async()=>get()?.refresh(),[get]),rebuild:useCallback(async()=>get()?.rebuild(),[get]),adopt:useCallback(async()=>get()?.adopt(),[get]),
    prepare:useCallback(async(replace=false,rotate=false)=>get()?.prepare(replace,rotate),[get]),stop:useCallback(async()=>get()?.stop(),[get]),cancel:useCallback(()=>get()?.cancel(),[get])};
}
