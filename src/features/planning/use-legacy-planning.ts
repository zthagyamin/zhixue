'use client';
import {useCallback,useLayoutEffect,useRef} from 'react';
import {createLegacyPlanActions,type LegacyPlanFrame,type LegacyPlanPorts} from '../../application/planning';
type Options={frame:LegacyPlanFrame;ports:Omit<LegacyPlanPorts,'readFrame'>};
export function useLegacyPlanning(options:Options){
  const live=useRef(options),mounted=useRef(true);
  useLayoutEffect(()=>{live.current=options;});
  const session=useRef<ReturnType<typeof createLegacyPlanActions>|null>(null);
  useLayoutEffect(()=>{
    const actions=createLegacyPlanActions({
    readFrame:()=>live.current.frame,isCurrent:()=>mounted.current&&live.current.ports.isCurrent(),
    readInput:current=>live.current.ports.readInput(current),replaceCandidate:(...args)=>live.current.ports.replaceCandidate(...args),
    publishAuthority:value=>live.current.ports.publishAuthority(value),message:value=>live.current.ports.message(value),
    loading:value=>live.current.ports.loading(value),resetSelection:()=>live.current.ports.resetSelection(),
    });
    session.current=actions;mounted.current=true;live.current.ports.loading(false);
    return()=>{mounted.current=false;actions.invalidate();if(session.current===actions)session.current=null;};
  },[options.frame.scope,options.frame.day,options.frame.transport,options.frame.enabled]);
  return {
    refresh:useCallback(async()=>session.current?.refresh()??null,[]),
    generate:useCallback(async()=>session.current?.generate(),[]),approve:useCallback(async()=>session.current?.approve(),[]),
    remove:useCallback(async(key:string)=>session.current?.remove(key),[]),reject:useCallback(async()=>session.current?.reject(),[]),
    restore:useCallback(async(revision:number)=>session.current?.restore(revision),[]),
  };
}
