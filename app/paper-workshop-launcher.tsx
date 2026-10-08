'use client';
import {useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {PaperServices} from './plugins/plugin-paper';
import {createLazyComponent} from './plugins/lazy-plugin';
import {useManagedDialog} from './use-managed-dialog';
import './plugins/paper.css';
const Workshop=createLazyComponent<{services:PaperServices}>(async()=>({default:(await import('./plugins/plugin-paper')).PaperWorkshop}),'论文精读工坊');

/** Keep the launch button light; opening the dialog is the module-load boundary. */
export function PaperWorkshopLauncher({services}:{services:PaperServices}){
 const [open,setOpen]=useState(false),dialog=useRef<HTMLDialogElement>(null);
 const managed=useManagedDialog(dialog,open,()=>setOpen(false));
 return <><button className="paper-launch" onClick={event=>{const menu=event.currentTarget.closest('details');menu?.removeAttribute('open');menu?.querySelector('summary')?.focus();setOpen(true);}}>论文精读工坊</button>{open&&createPortal(<div className="study-app study-modal-host" style={{display:'contents'}}><dialog ref={dialog} className="paper-dialog" aria-label="论文精读工坊" onClose={managed.onNativeClose} onCancel={event=>{event.preventDefault();managed.close();}}><button className="paper-close" onClick={managed.close} aria-label="关闭论文精读工坊">关闭工坊 ×</button><Workshop key={JSON.stringify([services.owner,services.library])} services={services}/></dialog></div>,document.body)}</>;
}
