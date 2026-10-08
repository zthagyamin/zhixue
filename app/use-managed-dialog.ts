'use client';
import {useEffect,useRef,type RefObject} from 'react';
import {createModalCoordinator} from './modal-coordinator';
const coordinator=createModalCoordinator();
export function useManagedDialog(dialog:RefObject<HTMLDialogElement|null>,open:boolean,onClose:()=>void,dismissible=true){
 const registration=useRef<{node:HTMLDialogElement;dispose:()=>void;setBlocked:(value:boolean)=>void;restore:()=>void}|null>(null);
 const blocked=useRef(!dismissible);
 useEffect(()=>{blocked.current=!dismissible;registration.current?.setBlocked(!dismissible);},[dismissible]);
 useEffect(()=>{
  const node=dialog.current;if(!node||!open)return;
  const opener=document.activeElement instanceof HTMLElement?document.activeElement:null;let lastFocus:HTMLElement|null=null;
  const handle=coordinator.register({id:node,blocked:blocked.current,
   hide(){if(node.contains(document.activeElement))lastFocus=document.activeElement as HTMLElement;if(node.open)node.close();},
   show(){if(!node.isConnected)return;if(!node.open)node.showModal();if(lastFocus?.isConnected)lastFocus.focus({preventScroll:true});},
  });
  const restore=()=>{const current=coordinator.current()?.id;if(opener?.isConnected&&(!current||current instanceof HTMLDialogElement&&current.contains(opener)))opener.focus({preventScroll:true});};
  const current={node,dispose:handle.dispose,setBlocked:handle.setBlocked,restore};registration.current=current;
  return()=>{if(registration.current===current)registration.current=null;handle.dispose();restore();};
 },[dialog,open]);
 const close=()=>{if(!dismissible)return;const current=registration.current;current?.dispose();onClose();current?.restore();};
 // Programmatic suspension is not a user close. Reopened nodes may still have an older queued close event.
 const onNativeClose=()=>{const node=dialog.current;if(node&&!node.open&&coordinator.current()?.id===node)close();};
 return {close,onNativeClose};
}