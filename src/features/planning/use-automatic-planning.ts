'use client';
import {useEffect,useLayoutEffect,useRef} from 'react';
import type {LongTermPlanState} from '../../domain/planning';
import {createAutomaticPlanningCoordinator,type AutomaticPlanningInput,type AutomaticPlanningPorts} from '../../application/planning';
type Input=Omit<AutomaticPlanningInput,'scope'|'state'>&{scope:string|null;state:LongTermPlanState|null};
type Options={input:Input;editing:boolean;historyReady:boolean;blocked:boolean;canContinue:()=>boolean;ports:Omit<AutomaticPlanningPorts,'isCurrent'>};

/** Source identity excludes the temporary busy state produced by our own daily preparation. */
export function useAutomaticPlanning(options:Options){
  const live=useRef(options),binding=useRef('');
  const coordinator=useRef<ReturnType<typeof createAutomaticPlanningCoordinator>|null>(null);
  useLayoutEffect(()=>{
    live.current=options;
    const input=options.input,next=JSON.stringify([input.scope,input.mode,input.day,input.sourceStamp]);
    if(binding.current!==next||options.editing||options.blocked||!options.historyReady||!input.state?.enabled)coordinator.current?.invalidate();
    binding.current=next;
  });
  useEffect(()=>{
    const current=createAutomaticPlanningCoordinator({
      isCurrent:request=>{
        const value=live.current,input=value.input;
        return request.scope===input.scope&&request.mode===input.mode&&request.day===input.day&&request.sourceStamp===input.sourceStamp
          &&Boolean(input.state?.enabled)&&value.historyReady&&!value.editing&&!value.blocked&&value.canContinue();
      },
      loadSource:request=>live.current.ports.loadSource(request),preview:input=>live.current.ports.preview(input),
      save:(request,mutation)=>live.current.ports.save(request,mutation),
      prepareDaily:(request,state,isCurrent)=>live.current.ports.prepareDaily(request,state,isCurrent),
      refreshGoals:request=>live.current.ports.refreshGoals(request),now:()=>live.current.ports.now(),
    });
    coordinator.current=current;
    return()=>{current.dispose();if(coordinator.current===current)coordinator.current=null;};
  },[]);
  const {scope,mode,day,sourceStamp,trigger,state,ready}=options.input;
  const {editing,historyReady,blocked}=options;
  useEffect(()=>{
    if(!scope||!state||!ready||editing||blocked||!historyReady)return;
    const timer=window.setTimeout(()=>{
      void coordinator.current?.request({scope,mode,day,sourceStamp,trigger,state,ready});
    },1000);
    return()=>window.clearTimeout(timer);
  },[scope,mode,day,sourceStamp,trigger,state,ready,editing,historyReady,blocked]);
}
