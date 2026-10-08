'use client';
import {useCallback,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {createSourceMaintenance,createSignOut,type MaintenancePorts,type SignOutPorts,type RecoveryPack,type RecoveryActionResult} from '../../application/sources';
type Modal='exporting'|'clearing'|'export-done'|'clear-done'|'export-partial'|'blocked'|'failed'|'confirm-clear'|null;
type Options<P extends RecoveryPack>=MaintenancePorts<P>&Omit<SignOutPorts<P>,keyof MaintenancePorts<P>>&{scope:string;client:object};
export function useSourceMaintenance<P extends RecoveryPack>(options:Options<P>){
  const binding=useMemo(()=>({scope:options.scope}),[options.scope]),live=useRef(options);
  type Active={binding:typeof binding;maintenance:ReturnType<typeof createSourceMaintenance<P>>;signOut:ReturnType<typeof createSignOut<P>>;busy:boolean};
  const active=useRef<Active|null>(null),[view,setView]=useState<{binding:typeof binding;modal:Modal;message:string}|null>(null);
  useLayoutEffect(()=>{live.current=options;});
  useLayoutEffect(()=>{
    let alive=true;
    const capture=()=>{const frame=live.current.capture();return{...frame,current:()=>alive&&frame.current()};};
    const maintenance=createSourceMaintenance<P>({capture:()=>{const frame=capture(),client=live.current.client;return{...frame,current:()=>frame.current()&&live.current.client===client};},confirm:message=>live.current.confirm(message),export:owner=>live.current.export(owner),
      download:value=>live.current.download(value),clearLibrary:(...args)=>live.current.clearLibrary(...args),clearRead:()=>live.current.clearRead(),
      clearWorkspace:owner=>live.current.clearWorkspace(owner),cancelRead:()=>live.current.cancelRead(),pauseRead:()=>live.current.pauseRead(),message:message=>live.current.message(message)});
    const signOut=createSignOut<P>({capture,prepareNavigation:()=>live.current.prepareNavigation(),confirm:message=>live.current.confirm(message),
      export:owner=>live.current.export(owner),clearViews:(...args)=>live.current.clearViews(...args),retire:()=>live.current.retire(),
      captureConnection:()=>live.current.captureConnection(),redirect:()=>live.current.redirect()});
    const entry={binding,maintenance,signOut,busy:false};active.current=entry;
    return()=>{alive=false;maintenance.dispose();signOut.dispose();if(active.current===entry)active.current=null;};
  },[binding]);
  const get=useCallback(()=>active.current?.binding===binding?active.current:null,[binding]);
  const run=useCallback(async(operation:'export'|'clear')=>{
    const session=get();if(!session||session.busy)return;session.busy=true;
    setView({binding,modal:operation==='export'?'exporting':'clearing',message:''});
    try{
      const result=await (operation==='export'?session.maintenance.exportData():session.maintenance.clearCache(true));
      if(get()!==session)return;
      const modal:Modal=result.status==='stale'||result.status==='cancelled'?null:result.status==='succeeded'?(operation==='export'?'export-done':'clear-done'):result.status==='partial'?'export-partial':result.status==='blocked'?'blocked':'failed';
      setView({binding,modal,message:modal?result.message:''});
    }catch{if(get()===session)setView({binding,modal:'failed',message:'操作未完成，请检查本机存储后重试。'});}
    finally{session.busy=false;}
  },[get,binding]);
  const updateModal=useCallback((modal:Modal)=>{if(!get()||get()?.busy)return;setView({binding,modal,message:''});},[get,binding]);
  const blocked=():RecoveryActionResult=>({status:'stale',message:'学习空间已变化，已忽略旧操作结果。'});
  return{modal:view?.binding===binding?view.modal:null,message:view?.binding===binding?view.message:'',
    exportData:useCallback(async()=>get()?.maintenance.exportData()??blocked(),[get]),clearCache:useCallback(async(skip=false)=>get()?.maintenance.clearCache(skip)??blocked(),[get]),
    run,requestClear:useCallback(()=>updateModal('confirm-clear'),[updateModal]),dismiss:useCallback(()=>updateModal(null),[updateModal]),
    signOut:useCallback(async()=>get()?.signOut.run(),[get])};
}
