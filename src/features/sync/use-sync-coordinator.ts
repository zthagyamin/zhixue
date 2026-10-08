'use client';
import {useCallback,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {createSyncCoordinator,type SyncFrame,type SyncNotice,type SyncOperation} from '../../application/sync';
const idle:Record<SyncOperation,boolean>={legacy:false,activities:false,account:false,journal:false,targets:false,manual:false};
type Options<Activity extends {eventId:string}>={scope:string;connection?:object|null;capture:()=>SyncFrame<Activity>;publish:(notice:SyncNotice)=>void;now:()=>string};

/** A method retained by an older render may never dispatch against the replacement owner. */
export function useSyncCoordinator<Activity extends {eventId:string}>(options:Options<Activity>){
  const binding=useMemo(()=>({scope:options.scope,connection:options.connection}),[options.scope,options.connection]),live=useRef(options);
  const current=useRef<{binding:typeof binding;session:ReturnType<typeof createSyncCoordinator<Activity>>}|null>(null);
  const [view,setView]=useState<{binding:typeof binding;busy:typeof idle}|null>(null);
  useLayoutEffect(()=>{live.current=options;});
  useLayoutEffect(()=>{
    let active=true;
    const session:ReturnType<typeof createSyncCoordinator<Activity>>=createSyncCoordinator<Activity>({capture:()=>{
      const frame=live.current.capture(),hostCurrent=frame.current;
      return{...frame,current:():boolean=>active&&current.current?.session===session&&hostCurrent()};
    },publish:notice=>live.current.publish(notice),now:()=>live.current.now(),busy:(operation,value)=>{
      if(active)setView(previous=>({binding,busy:{...(previous?.binding===binding?previous.busy:idle),[operation]:value}}));
    }});
    current.current={binding,session};
    return()=>{active=false;session.dispose();if(current.current?.session===session)current.current=null;};
  },[binding]);
  const get=useCallback(()=>current.current?.binding===binding?current.current.session:null,[binding]);
  return {
    busy:view?.binding===binding?view.busy:idle,
    flushLegacy:useCallback(async()=>get()?.flushLegacy(),[get]),flushActivities:useCallback(async()=>get()?.flushActivities(),[get]),
    flushAccount:useCallback(async()=>get()?.flushAccount(),[get]),flushJournal:useCallback(async()=>get()?.flushJournal(),[get]),
    flushTargets:useCallback(async()=>get()?.flushTargets(),[get]),manual:useCallback(async()=>get()?.manual(),[get]),
    invalidate:useCallback(()=>{get()?.invalidate();setView({binding,busy:idle});},[binding,get]),
  };
}
