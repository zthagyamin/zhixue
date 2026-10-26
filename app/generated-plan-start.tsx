'use client';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import './ux-remedies.css';
import {mayStartGeneratedPlan,type GeneratedStartIntent} from './generated-start-model';

type Props={
  scope:string;
  hash?:string;
  visible:boolean;
  disabled:boolean;
  loading?:boolean;
  generate:()=>Promise<string|undefined>;
  onStart:()=>void;
};

/** Explicit intent only; this component never approves, writes back or starts on page load. */
export function GeneratedPlanStart({scope,hash,visible,disabled,loading=false,generate,onStart}:Props){
  const [intent,setIntent]=useState<GeneratedStartIntent|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const lock=useRef(false),alive=useRef(true),generation=useRef(0);
  const consumed=useRef<GeneratedStartIntent|null>(null);
  const current=useRef({scope,visible,onStart});
  const stale=Boolean(intent&&visible&&intent.scope===scope&&hash&&hash!==intent.hash);

  useLayoutEffect(()=>{
    // Loading belongs to this generation; only changed authority cancels it.
    if(current.current.scope!==scope||!visible||disabled||stale)generation.current++;
    current.current={scope,visible,onStart};
  },[scope,visible,disabled,stale,onStart]);
  useEffect(()=>{
    alive.current=true;
    const aliveRef=alive,generationRef=generation;
    return()=>{aliveRef.current=false;generationRef.current++;};
  },[]);
  useEffect(()=>{
    if(mayStartGeneratedPlan(intent,scope,hash,visible,disabled||loading,generation.current)&&consumed.current!==intent){
      consumed.current=intent;
      current.current.onStart();
    }
  },[scope,hash,visible,disabled,loading,intent]);

  async function start(){
    if(lock.current||!visible||disabled||loading)return;
    lock.current=true;
    setBusy(true);
    setError('');
    const token=++generation.current;
    try{
      const next=await generate();
      if(alive.current&&token===generation.current&&current.current.scope===scope&&current.current.visible){
        if(next)setIntent({scope,hash:next,generation:token});
        else setError('尚未生成可用安排，请查看提示或先自由学习。');
      }else if(alive.current&&current.current.scope===scope){
        setError('页面或学习资料已经变化，请重新开始。');
      }
    }catch{
      if(alive.current&&token===generation.current)setError('暂时无法生成安排，请重试；不会自动开始或写回笔记。');
    }finally{
      lock.current=false;
      if(alive.current)setBusy(false);
    }
  }

  return <>
    {!hash&&<button type="button" className="study-primary-action" disabled={disabled||loading||busy} onClick={()=>void start()}>
      {busy?'正在安排…':'开始今日练习'}
    </button>}
    {(error||stale)&&<p role="status" className="study-meta">{error||'安排已经变化，请核对当前计划后开始。'}</p>}
  </>;
}
