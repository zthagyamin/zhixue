'use client';
import {useCallback,useLayoutEffect,useRef} from 'react';
import {createPlanningNavigator,type PlanningAccountEntry,type PlanningNavigationPorts,type PlanningNavigationLease,type PlanningNavigationScope} from '../../application/planning';
type Options<C,Q extends PlanningAccountEntry>={scope:PlanningNavigationScope;stamp:string;resetKey:string;active:()=>boolean;busy:boolean;pending:()=>boolean;captureBoundary:()=>()=>boolean;
  clock:{advance:()=>number;matches:(id:number)=>boolean};loading:(value:boolean)=>void;reset:()=>void;
  ports:Omit<PlanningNavigationPorts<C,Q>,'begin'|'finish'|'canContinue'|'setContinuing'>};
const scopeKey=(scope:PlanningNavigationScope)=>JSON.stringify([scope.owner,scope.libraryId,scope.day,scope.mode]);

/** React lifetime owns navigation leases; application code owns task selection and write order. */
export function usePlanningNavigation<C,Q extends PlanningAccountEntry>(options:Options<C,Q>){
  const resetBoundary=JSON.stringify([scopeKey(options.scope),options.resetKey]);
  const live=useRef(options),generation=useRef(0),binding=useRef(''),mounted=useRef(true);
  const ownership=useRef(new WeakMap<PlanningNavigationLease,()=>boolean>());
  useLayoutEffect(()=>{
    live.current=options;const next=JSON.stringify([scopeKey(options.scope),options.stamp]);
    if(binding.current!==next){binding.current=next;generation.current++;}
  });
  useLayoutEffect(()=>{const lifetime=generation;mounted.current=true;return()=>{mounted.current=false;lifetime.current++;};},[]);
  useLayoutEffect(()=>{
    const value=live.current,id=value.clock.advance();
    const timer=window.setTimeout(()=>{if(mounted.current&&value.clock.matches(id)){live.current.reset();live.current.loading(false);}},0);
    return()=>window.clearTimeout(timer);
  },[resetBoundary]);
  const session=useRef<ReturnType<typeof createPlanningNavigator<C,Q>>|null>(null);
  useLayoutEffect(()=>{
    const navigator=createPlanningNavigator<C,Q>({
    begin:kind=>{
      const value=live.current;if(!mounted.current||kind!=='subject'&&kind!=='continue'&&kind!==value.scope.mode)return null;
      const hostCurrent=value.captureBoundary();if(!hostCurrent())return null;
      const scope={...value.scope},key=scopeKey(scope),stamp=value.stamp,epoch=generation.current,id=value.clock.advance();
      const owns=()=>mounted.current&&scopeKey(live.current.scope)===key&&live.current.clock.matches(id);
      const lease={scope,current:()=>owns()&&hostCurrent()&&generation.current===epoch&&live.current.stamp===stamp&&(kind!=='continue'||live.current.active())};
      ownership.current.set(lease,owns);value.loading(true);value.ports.message('');return lease;
    },
    finish:lease=>{if(ownership.current.get(lease)?.())live.current.loading(false);ownership.current.delete(lease);},
    canContinue:()=>!live.current.busy&&!live.current.pending()&&live.current.active(),setContinuing:()=>{},
    prepareLeave:()=>live.current.ports.prepareLeave(),loadNative:(...args)=>live.current.ports.loadNative(...args),loadAccount:(...args)=>live.current.ports.loadAccount(...args),
    loadSubject:lease=>live.current.ports.loadSubject?.(lease)??(lease.scope.mode==='account'?live.current.ports.loadAccount(lease):live.current.ports.loadNative(lease,true)),
    groups:(...args)=>live.current.ports.groups(...args),verify:(...args)=>live.current.ports.verify(...args),persistStarted:(...args)=>live.current.ports.persistStarted(...args),
    groupItems:(...args)=>live.current.ports.groupItems(...args),getRound:(...args)=>live.current.ports.getRound(...args),activateRound:(...args)=>live.current.ports.activateRound(...args),
    enter:entry=>live.current.ports.enter(entry),returnToday:lease=>live.current.ports.returnToday(lease),openSubject:(...args)=>live.current.ports.openSubject?.(...args),openNote:note=>live.current.ports.openNote(note),message:message=>live.current.ports.message(message),
    });session.current=navigator;
    return()=>{if(session.current===navigator)session.current=null;};
  },[]);
  return {
    startSubject:useCallback(async(subjectId:string)=>session.current?.startSubject(subjectId),[]),
    startNative:useCallback(async(taskId:string,eligible?:string[],isCurrent?:()=>boolean)=>session.current?.startNative(taskId,eligible,isCurrent),[]),
    startAccount:useCallback(async(query:Q,isCurrent?:()=>boolean)=>session.current?.startAccount(query,isCurrent),[]),
    continueToday:useCallback(async()=>session.current?.continueToday(),[]),
  };
}
