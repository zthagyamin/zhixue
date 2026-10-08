'use client';
import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {TemporaryDraft} from '../../application/temporary-practice';
import type {LeaveGuardPort} from './dialog';
import {RecallSourceCaption} from './recall-source-caption';

type Props={sourceLabel?:string;prompt:string;reference:string;draft:TemporaryDraft;onContinue:()=>boolean;onExit:()=>void;notice?:string;registerGuard?:LeaveGuardPort};
type Phase='reference'|'answer'|'compare';

/** Inline, ungraded retry. The host alone owns the original save and continuation. */
export function PaperRecallPractice({sourceLabel,prompt,reference,draft,onContinue,onExit,notice,registerGuard}:Props) {
    useSyncExternalStore(draft.subscribe,draft.getSnapshot,()=>0);
    const [phase,setPhase]=useState<Phase>('answer');
    const heading=useRef<HTMLHeadingElement>(null);
    const active=draft.isActive()&&!draft.isBusy();
    useEffect(()=>{heading.current?.focus();},[phase]);
    useEffect(()=>{
        const beforeUnload=(event:BeforeUnloadEvent)=>{if(draft.hasUnsavedInput()){event.preventDefault();event.returnValue='';}};
        window.addEventListener('beforeunload',beforeUnload);
        const unregister=registerGuard?.({message:()=>draft.hasUnsavedInput()?'这次回答还没完成，确定离开吗？':null,onLeave:()=>draft.dispose(),version:draft.getSnapshot});
        return()=>{window.removeEventListener('beforeunload',beforeUnload);unregister?.();};
    },[draft,registerGuard]);
    if(!draft.isActive())return <section aria-label="补练已失效"><p role="status">题目已切换。</p><button type="button" className="study-secondary-action" onClick={onExit}>返回题目</button></section>;
    const retry=()=>{if(active&&draft.write('answer','')){draft.acknowledge();setPhase('answer');}};
    const repeat=()=>{if(active&&draft.write('answer','')){draft.acknowledge();setPhase('reference');}};
    return <section className="paper-recall-practice" data-phase={phase} aria-label="论文再练一次">
        <p className="paper-recall-caption">{phase==='reference'?'看要点':phase==='answer'?'再试一次':'对照答案'}</p>
        <RecallSourceCaption label={sourceLabel} prompt={prompt}/>
        <h2 className="study-question" ref={heading} tabIndex={-1}>{prompt}</h2>
        {phase==='answer'?<textarea aria-label="简短回答" placeholder="用一两句话回答" rows={3} maxLength={12000} value={draft.read('answer')} disabled={!active} onChange={e=>draft.write('answer',e.target.value)}/>:<>
            {phase==='compare'&&<div className="paper-recall-answer"><span>你的回答</span><p>{draft.read('answer')}</p></div>}
            <div className="paper-recall-reference"><span>要点</span><p>{reference}</p></div>
        </>}
        {notice&&<p role="status">{notice}</p>}
        <div className="paper-recall-actions">
            {phase==='compare'?<>
                <button type="button" className="study-primary-action" disabled={!active} onClick={()=>{if(active)onContinue();}}>记住了</button>
                <button type="button" className="study-secondary-action" disabled={!active} onClick={repeat}>再来一遍</button>
            </>:<>
                <button type="button" className="study-primary-action" disabled={!active||(phase==='answer'&&!draft.read('answer').trim())} onClick={()=>{if(!active)return;if(phase==='reference')retry();else if(draft.read('answer').trim())setPhase('compare');}}>{phase==='reference'?'再试一次':'看答案'}</button>
                <button type="button" className="study-secondary-action" disabled={!active} onClick={()=>{if(active)onContinue();}}>先下一题</button>
            </>}
        </div>
    </section>;
}
