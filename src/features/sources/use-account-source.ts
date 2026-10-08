'use client';
import {useCallback,useLayoutEffect,useMemo,useRef} from 'react';
import {createAccountSourceSession,type AccountSourcePorts} from '../../application/sources';
type Options<Loaded,Projection,Receipt>=Omit<AccountSourcePorts<Loaded,Projection,Receipt>,'abort'>&{scope:string;client:object};
export function useAccountSource<Loaded,Projection,Receipt>(options:Options<Loaded,Projection,Receipt>){
  const binding=useMemo(()=>({scope:options.scope,client:options.client}),[options.scope,options.client]),live=useRef(options);
  type Session=ReturnType<typeof createAccountSourceSession<Loaded,Projection,Receipt>>;
  const current=useRef<{binding:typeof binding;session:Session}|null>(null);
  useLayoutEffect(()=>{live.current=options;});
  useLayoutEffect(()=>{
    let active=true;
    const session:Session=createAccountSourceSession({
      capture:()=>{const frame=live.current.capture(),hostCurrent=frame.current;return{...frame,current:():boolean=>active&&current.current?.session===session&&hostCurrent()};},
      version:value=>live.current.version(value),prepare:(...args)=>live.current.prepare(...args),project:(...args)=>live.current.project(...args),
      publish:(...args)=>live.current.publish(...args),receipts:(...args)=>live.current.receipts(...args),status:(...args)=>live.current.status(...args),
      clear:frame=>live.current.clear(frame),identityChanged:frame=>live.current.identityChanged(frame),now:()=>live.current.now(),abort:()=>new AbortController(),
    });current.current={binding,session};
    return()=>{active=false;session.dispose();if(current.current?.session===session)current.current=null;};
  },[binding]);
  const get=useCallback(()=>current.current?.binding===binding?current.current.session:null,[binding]);
  return {
    apply:useCallback(async(value:Loaded|null,expected?:number)=>get()?.apply(value,expected)??false,[get]),
    read:useCallback(async(choice?:{enable?:boolean})=>get()?.read(choice)??null,[get]),
    getPending:useCallback(()=>get()?.pending()??null,[get]),clearPending:useCallback(()=>get()?.clearPending(),[get]),cancel:useCallback(()=>get()?.cancel(),[get]),
  };
}
