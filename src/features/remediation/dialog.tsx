'use client';
import {useEffect,useLayoutEffect,useRef,useSyncExternalStore,type ReactNode} from 'react';
import type {TemporaryDraft} from '../../application/temporary-practice';

export type LeaveGuardPort = (guard:{message:()=>string|null;onLeave:()=>void;version:()=>unknown})=>()=>void;
const serverSnapshot=()=>0;
export function TemporaryDialog({draft,title,onClose,onStop,children,registerGuard}:{draft:TemporaryDraft;title:string;onClose:()=>void;onStop?:()=>void;children:ReactNode;registerGuard?:LeaveGuardPort}) {
    const dialog=useRef<HTMLDialogElement>(null),lifecycle=useRef(0),stop=useRef(onStop);
    useLayoutEffect(()=>{stop.current=onStop;},[onStop]);
    useSyncExternalStore(draft.subscribe,draft.getSnapshot,serverSnapshot);
    const leave=()=>{
        if(draft.hasUnsavedInput()&&!window.confirm('本次临时练习还有未确认的输入或运行。离开后不保留，仍要结束吗？'))return;
        stop.current?.();draft.dispose();onClose();
    };
    useEffect(()=>{
        const token=++lifecycle.current,node=dialog.current;
        if(node&&!node.open)node.showModal();
        const beforeUnload=(event:BeforeUnloadEvent)=>{if(draft.hasUnsavedInput()){event.preventDefault();event.returnValue='';}};
        window.addEventListener('beforeunload',beforeUnload);
        const unregister=registerGuard?.({message:()=>draft.hasUnsavedInput()?'临时练习尚未确认，离开后不保留。':null,onLeave:()=>{stop.current?.();draft.dispose();},version:draft.getSnapshot});
        // Read the latest generation deliberately: StrictMode re-setup must invalidate the queued cleanup.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        return()=>{window.removeEventListener('beforeunload',beforeUnload);unregister?.();node?.close();queueMicrotask(()=>{if(lifecycle.current===token){stop.current?.();draft.dispose();}});};
    },[draft,registerGuard]);
    return <dialog ref={dialog} className="study-temporary-dialog" aria-label={title} onCancel={event=>{event.preventDefault();leave();}}>
        <header><div><p className="study-meta">辅助练习 · 不新增正式成绩</p><h2>{title}</h2></div><button type="button" className="study-secondary-action" onClick={leave}>返回原反馈</button></header>
        {!draft.isActive()?<p role="status">原题或学习空间已变化，本次输入已失效。请返回后重新打开。</p>:children}
    </dialog>;
}
