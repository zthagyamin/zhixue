'use client';
import {useRef,useState,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import type {PaperServices} from './plugins/plugin-paper';
import {createLazyComponent} from './plugins/lazy-plugin';
import {useManagedDialog} from './use-managed-dialog';
import {companionEndpointFromSearch} from './companion-endpoint';
import {confirmStudyNavigation} from './study-navigation-guard';
import './plugins/paper.css';
const Workshop=createLazyComponent<{services:PaperServices}>(async()=>({default:(await import('./plugins/plugin-paper')).PaperWorkshop}),'论文精读工坊');

function readingHref(){
 const query=new URLSearchParams(window.location.search);
 if(query.has('companionPort')||query.get('pair')==='1'){
  try{return '/study/paper?companionPort='+new URL(companionEndpointFromSearch(query.toString())).port;}catch{return '/study/paper';}
 }
 return '/study/paper';
}
function subscribeLocation(listener:()=>void){window.addEventListener('popstate',listener);return()=>window.removeEventListener('popstate',listener);}
/** Default navigation is light; the legacy dialog remains lazy-loaded. */
export function PaperWorkshopLauncher({services,legacyDialog=false}:{services:PaperServices;legacyDialog?:boolean}){
 const [open,setOpen]=useState(false),dialog=useRef<HTMLDialogElement>(null);
 const href=useSyncExternalStore(subscribeLocation,readingHref,()=>'/study/paper');
 const managed=useManagedDialog(dialog,open,()=>setOpen(false));
 if(!legacyDialog)return <a className="paper-launch" href={href} onClick={event=>{if(!confirmStudyNavigation())event.preventDefault();}}>论文精读</a>;
 return <><button className="paper-launch" onClick={event=>{const menu=event.currentTarget.closest('details');menu?.removeAttribute('open');menu?.querySelector('summary')?.focus();setOpen(true);}}>论文精读工坊</button>{open&&createPortal(<div className="study-app study-modal-host" style={{display:'contents'}}><dialog ref={dialog} className="paper-dialog" aria-label="论文精读工坊" onClose={managed.onNativeClose} onCancel={event=>{event.preventDefault();managed.close();}}><button className="paper-close" onClick={managed.close} aria-label="关闭论文精读工坊">关闭工坊 ×</button><Workshop key={JSON.stringify([services.owner,services.library])} services={services}/></dialog></div>,document.body)}</>;
}
