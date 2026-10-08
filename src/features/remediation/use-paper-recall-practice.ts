'use client';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {TemporaryDraft} from '../../application/temporary-practice';
import type {TemporaryFactory} from './source-review';

type Options = {
    binding:string;
    enabled:boolean;
    disabled:boolean;
    createDraft?:TemporaryFactory;
    beforeOpen:(signal:AbortSignal)=>Promise<boolean>;
    onContinue:()=>boolean;
};
type Session={binding:string;draft:TemporaryDraft;resume:()=>boolean};

export function usePaperRecallPractice(options:Options) {
    const [session,setSession]=useState<Session|null>(null);
    const [preparing,setPreparing]=useState(false),[notice,setNotice]=useState('');
    const current=useRef<Session|null>(null),pending=useRef<AbortController|null>(null);
    const mounted=useRef(false),lifecycle=useRef(0),finishing=useRef(false);
    const binding=useRef(options.binding);
    useLayoutEffect(()=>{binding.current=options.binding;},[options.binding]);
    useEffect(()=>{
        mounted.current=true;
        const token=++lifecycle.current,scope=options.binding;
        return()=>{
            mounted.current=false;pending.current?.abort();
            queueMicrotask(()=>{
                // StrictMode re-setup must invalidate queued disposal using the latest generation.
                // eslint-disable-next-line react-hooks/exhaustive-deps
                if((lifecycle.current===token||binding.current!==scope)&&current.current?.binding===scope){
                    current.current.draft.dispose();current.current=null;
                }
            });
        };
    },[options.binding]);
    const start=async()=>{
        if(!options.enabled||options.disabled||pending.current||current.current)return;
        const controller=new AbortController(),scope=options.binding;
        const factory=options.createDraft,resume=options.onContinue;
        pending.current=controller;setPreparing(true);setNotice('');
        try{
            if(!await options.beforeOpen(controller.signal)){
                if(mounted.current&&!controller.signal.aborted)setNotice('还没保存成功，请再试一次。');
                return;
            }
            if(!mounted.current||controller.signal.aborted||binding.current!==scope)return;
            const draft=factory?.({answer:''});
            if(!draft){setNotice('题目已变化，请返回后重试。');return;}
            const next={binding:scope,draft,resume};
            current.current=next;setSession(next);
        }catch{
            if(mounted.current&&!controller.signal.aborted)setNotice('暂时无法继续，请重试。');
        }finally{
            if(pending.current===controller)pending.current=null;
            if(mounted.current)setPreparing(false);
        }
    };
    const complete=()=>{
        const entry=current.current;
        if(!entry||finishing.current||entry.binding!==binding.current||!entry.draft.isActive()||entry.draft.isBusy())return false;
        finishing.current=true;
        try{
            // This consumes the first attempt's existing receipt; it never grades again.
            entry.draft.acknowledge();
            if(!entry.resume()){setNotice('暂时无法继续，请再点一次。');return false;}
            entry.draft.dispose();current.current=null;setSession(null);return true;
        }finally{finishing.current=false;}
    };
    const cancel=()=>{current.current?.draft.dispose();current.current=null;setSession(null);setNotice('');};
    return{draft:session?.binding===options.binding?session.draft:null,preparing,notice,start,complete,cancel};
}

