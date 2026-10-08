'use client';
import {useEffect} from 'react';
type Work=()=>Promise<unknown>;
export function useSyncTriggers(options:{ready:boolean;accountActive:boolean;journal:Work;account:Work;
  legacy:{pending:number;synced:boolean;lastSyncedAt?:string;intervalMs:number;flush:Work};
  bootstrap?:{needed:boolean;run:Work};
}){
  const {ready,accountActive,journal,account}=options;
  useEffect(()=>{
    if(!ready)return;
    const run=()=>{if(navigator.onLine&&!document.hidden){void journal();if(accountActive)void account();}};
    const initial=window.setTimeout(run,0),timer=window.setInterval(run,60000);
    window.addEventListener('online',run);document.addEventListener('visibilitychange',run);
    return()=>{window.clearTimeout(initial);window.clearInterval(timer);window.removeEventListener('online',run);document.removeEventListener('visibilitychange',run);};
  },[ready,accountActive,journal,account]);
  const {pending,synced,lastSyncedAt,intervalMs,flush}=options.legacy;
  useEffect(()=>{
    if(!synced||!pending)return;
    const last=lastSyncedAt?new Date(lastSyncedAt).getTime():0,elapsed=Number.isFinite(last)?Date.now()-last:intervalMs;
    const timer=window.setTimeout(()=>void flush(),Math.min(intervalMs,Math.max(0,intervalMs-elapsed)));
    return()=>window.clearTimeout(timer);
  },[pending,synced,lastSyncedAt,intervalMs,flush]);
  const needed=options.bootstrap?.needed,bootstrap=options.bootstrap?.run;
  useEffect(()=>{
    if(!needed||!bootstrap)return;
    const timer=window.setTimeout(()=>void bootstrap(),0);return()=>window.clearTimeout(timer);
  },[needed,bootstrap]);
}
