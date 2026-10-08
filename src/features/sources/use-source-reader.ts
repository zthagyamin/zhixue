'use client';
import {useCallback,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {createSourceReader,type SourceReadFrame,type SourceReaderPorts} from '../../application/sources';
export function useSourceReader<F extends SourceReadFrame,I,V>(options:Omit<SourceReaderPorts<F,I,V>,'busy'>&{scope:string;resource?:object|null}){
  const binding=useMemo(()=>({scope:options.scope,resource:options.resource}),[options.scope,options.resource]),live=useRef(options);
  type Reader=ReturnType<typeof createSourceReader<F,I,V>>;
  const active=useRef<{binding:typeof binding;reader:Reader}|null>(null),[state,setState]=useState<{binding:typeof binding;busy:boolean}|null>(null);
  useLayoutEffect(()=>{live.current=options;});
  useLayoutEffect(()=>{
    let alive=true;
    const reader=createSourceReader<F,I,V>({capture:()=>{const frame=live.current.capture();return{...frame,current:()=>alive&&frame.current()};},
      read:(...args)=>live.current.read(...args),publish:(...args)=>live.current.publish(...args),error:(...args)=>live.current.error(...args),
      busy:value=>{if(alive)setState({binding,busy:value});}});
    active.current={binding,reader};return()=>{alive=false;reader.dispose();if(active.current?.reader===reader)active.current=null;};
  },[binding]);
  const get=useCallback(()=>active.current?.binding===binding?active.current.reader:null,[binding]);
  return{busy:state?.binding===binding?state.busy:false,read:useCallback(async(input:I,options?:{strict?:boolean})=>get()?.read(input,options)??null,[get]),cancel:useCallback(()=>get()?.cancel(),[get])};
}
