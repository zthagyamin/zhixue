import {useCallback,useState} from 'react';

/** A scoped overlay keeps the practice tree mounted and never starts delivery. */
export function useSyncDetails(scope:string,onOpen:()=>void) {
  const [opened,setOpened]=useState<string|null>(null);
  const open=opened===scope;
  const focusTarget=useCallback((node:HTMLDivElement|null)=>{
    if(!node)return;
    const focus=()=>{
      const target=node.querySelector<HTMLElement>('#study-sync-details');
      if(!target||!target.closest('dialog')?.open)return false;
      target.focus({preventScroll:true});target.scrollIntoView({block:'start'});return true;
    };
    const observer=new MutationObserver(()=>{if(focus())observer.disconnect();});
    observer.observe(node.closest('dialog')??node,{childList:true,subtree:true,attributes:true,attributeFilter:['open']});
    const frame=requestAnimationFrame(()=>{if(focus())observer.disconnect();});
    return()=>{cancelAnimationFrame(frame);observer.disconnect();};
  },[]);
  return {open,show:()=>{onOpen();setOpened(scope);},close:()=>setOpened(null),focusTarget};
}
