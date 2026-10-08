'use client';
import {useLayoutEffect,useMemo,useState,useSyncExternalStore,type ReactNode} from 'react';
import {createTemporaryDraft,createTemporaryRun,type TemporaryDraft} from '../../application/temporary-practice';
import {codeRunSuccess,codeRunFailure} from '../../domain/remediation';
import {TemporaryDialog,type LeaveGuardPort} from './dialog';
import type {TemporaryFactory} from './source-review';

export type CodeExecutionPort={
    ready:boolean;error:string|null;
    run:(code:string,stdin:string,testCode?:string)=>Promise<{output:string;result?:unknown;assertionsPassed?:number}>;
    retry:()=>void;cancel:()=>void;
};
type Props={binding:string;initialCode:string;originalCode:string;originalOutput:string;firstResultKnown?:boolean;testCode:string;createDraft?:TemporaryFactory;registerGuard?:LeaveGuardPort;runner:CodeExecutionPort;onOpenChange?:(open:boolean)=>void;renderEditor?:(props:{value:string;onChange:(value:string)=>void;readOnly:boolean})=>ReactNode};
/** The session receives the committed UI port in a layout effect, never during rendering. */
function codeExecution(draft:TemporaryDraft,testCode:string){
    let port:CodeExecutionPort|null=null,mode:'tests'|'trial'='tests';
    const execution=createTemporaryRun(draft,{
        async run(input){
            const requestedMode=mode,runner=port;
            if(!runner?.ready)return codeRunFailure(Object.assign(new Error('执行环境尚未就绪。'),{name:'RuntimeError'}));
            try{return codeRunSuccess(await runner.run(input.code,input.stdin,requestedMode==='tests'?testCode:undefined),requestedMode);}
            catch(error){return codeRunFailure(error);}
        },cancel:()=>port?.cancel(),
    });
    return {...execution,attach(next:CodeExecutionPort){port=next;},startMode(next:'tests'|'trial'){
        if(!port?.ready||draft.isBusy()||!draft.isActive())return;
        mode=next;void execution.start();
    }};
}
export function CodeRewriteLauncher(props:Props){
    const [draft,setDraft]=useState<TemporaryDraft|null>(null),[notice,setNotice]=useState('');
    const open=()=>{
        const initial={code:props.initialCode,stdin:''};
        const next=props.createDraft?props.createDraft(initial):createTemporaryDraft({initial,binding:props.binding});
        if(!next){setNotice('原题正在保存或已变化，请稍后重试。');return;}
        setDraft(next);props.onOpenChange?.(true);setNotice('');
    };
    return <div className="study-remedy-entry"><button type="button" className="study-secondary-action" onClick={open}>关闭题解后重写（辅助练习）</button>{notice&&<p role="status">{notice}</p>}{draft&&<CodeRewrite {...props} draft={draft} onClose={()=>{props.onOpenChange?.(false);setDraft(null);}}/>}</div>;
}
function CodeRewrite({draft,onClose,...props}:Props&{draft:TemporaryDraft;onClose:()=>void}){
    useSyncExternalStore(draft.subscribe,draft.getSnapshot,()=>0);
    const execution=useMemo(()=>codeExecution(draft,props.testCode),[draft,props.testCode]);
    useLayoutEffect(()=>{execution.attach(props.runner);},[execution,props.runner]);
    useSyncExternalStore(execution.subscribe,execution.getSnapshot,()=>0);
    const [acknowledged,setAcknowledged]=useState(false),state=execution.snapshot();
    const start=(next:'tests'|'trial')=>{setAcknowledged(false);execution.startMode(next);};
    const setCode=(value:string)=>{if(draft.write('code',value)){execution.clearResult();setAcknowledged(false);}};
    return <TemporaryDialog draft={draft} title="关闭题解后重写" onClose={onClose} onStop={execution.dispose} registerGuard={props.registerGuard}>
        <p>Python 3 · 这是独立的临时代码副本。多次运行不会改变原代码、首次结果或复习安排。</p>
        <details><summary>{props.firstResultKnown?'核对原始作答与本页首次结果':'核对原题现有作答与反馈'}</summary><pre>{props.originalCode||'原作答为空'}</pre><pre>{props.originalOutput||'原题尚未运行测试'}</pre>{!props.firstResultKnown&&<p>旧页面未单独记录首轮结果，这里保留当前已有反馈，不补造历史。</p>}</details>
        <label>临时代码{props.renderEditor?props.renderEditor({value:draft.read('code'),onChange:setCode,readOnly:draft.isBusy()}):<textarea aria-label="临时代码" rows={10} spellCheck={false} value={draft.read('code')} readOnly={draft.isBusy()} onChange={event=>setCode(event.target.value)}/>}</label>
        <label>临时标准输入<textarea aria-label="临时标准输入" rows={2} value={draft.read('stdin')} readOnly={draft.isBusy()} onChange={event=>{if(draft.write('stdin',event.target.value)){execution.clearResult();setAcknowledged(false);}}}/></label>
        <details><summary>题目提供的公开测试</summary><pre>{props.testCode||'本题没有可运行的测试，只能试运行。'}</pre></details>
        {props.runner.error&&<div role="status"><p>运行环境尚未就绪，输入仍保留。</p><button type="button" className="study-secondary-action" onClick={props.runner.retry}>重试运行环境</button></div>}
        <div className="study-temporary-actions"><button type="button" className="study-primary-action" disabled={!props.runner.ready||draft.isBusy()||!props.testCode.trim()} onClick={()=>start('tests')}>测试临时代码</button><button type="button" className="study-secondary-action" disabled={!props.runner.ready||draft.isBusy()} onClick={()=>start('trial')}>仅试运行</button>{draft.isBusy()&&<button type="button" className="study-secondary-action" onClick={execution.cancel}>停止本次运行</button>}</div>
        {state.phase==='running'&&<p role="status">正在隔离环境运行…</p>}
        {state.phase==='cancelled'&&<p role="status">本次运行已停止，输入仍保留。</p>}
        {state.result&&<section aria-label="辅助运行结果"><p role="status">{state.result.message}</p><pre>{state.result.details}</pre><button type="button" className="study-secondary-action" disabled={draft.isBusy()} onClick={()=>{draft.acknowledge();setAcknowledged(true);}}>已核对本次运行结果</button>{acknowledged&&<p>原题的首次结果保持不变，可以返回原反馈。</p>}</section>}
    </TemporaryDialog>;
}
