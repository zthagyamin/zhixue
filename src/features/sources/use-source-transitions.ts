'use client';
import {useCallback,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {createSourceTransitions,type SourceTransitionPorts} from '../../application/sources';
type Options<C,L,A>=Omit<SourceTransitionPorts<C,L,A>,'busy'>&{scope:string;connection:C|null;client:object};
export function useSourceTransitions<C,L,A>(options:Options<C,L,A>){
  const binding=useMemo(()=>({scope:options.scope,connection:options.connection,client:options.client}),[options.scope,options.connection,options.client]),live=useRef(options);
  type Session=ReturnType<typeof createSourceTransitions<C,L,A>>;
  const current=useRef<{binding:typeof binding;session:Session}|null>(null),[view,setView]=useState<{binding:typeof binding;busy:boolean}|null>(null);
  useLayoutEffect(()=>{live.current=options;});
  useLayoutEffect(()=>{
    let active=true;const session:Session=createSourceTransitions({
      capture:()=>{const frame=live.current.capture(),host=frame.current;return{...frame,current:():boolean=>active&&current.current?.session===session&&host()};},
      confirm:message=>live.current.confirm(message),begin:()=>live.current.begin(),readLocal:frame=>live.current.readLocal(frame),adoptAccount:frame=>live.current.adoptAccount(frame),
      clearDrafts:frame=>live.current.clearDrafts(frame),commitLocal:(...args)=>live.current.commitLocal(...args),commitAccount:frame=>live.current.commitAccount(frame),
      reloadAccount:frame=>live.current.reloadAccount(frame),message:message=>live.current.message(message),busy:value=>{if(active)setView({binding,busy:value});},
    });current.current={binding,session};
    return()=>{active=false;session.dispose();if(current.current?.session===session)current.current=null;};
  },[binding]);
  const get=useCallback(()=>current.current?.binding===binding?current.current.session:null,[binding]);
  return{busy:view?.binding===binding?view.busy:false,isBusy:useCallback(()=>get()?.isBusy()??false,[get]),
    switchLocal:useCallback(async()=>get()?.switchLocal()??false,[get]),adoptAccount:useCallback(async()=>get()?.adoptAccount()??null,[get])};
}
