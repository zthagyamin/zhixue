'use client';
import {useEffect,useRef,useState} from 'react';
import type {RecoveryControlPort,RestoreControlPreview as RestorePreview} from '../../application/nonword-recovery';

type Props={workspaceId:string|null;ready:boolean;port:RecoveryControlPort;onChanged?:()=>void};
type Scope={workspaceId:string|null;ready:boolean;flight:boolean};
type Loaded={file:File;raw:string|null;package:unknown;preview:RestorePreview|null;needsPreview:boolean;completed:boolean};
type Archives=Awaited<ReturnType<RecoveryControlPort['archives']>>;
type View={scope:Scope;busy:boolean;error:string;notice:string;loaded:Loaded|null;archives:Archives|null};
const empty=(scope:Scope):View=>({scope,busy:false,error:'',notice:'',loaded:null,archives:null});

/** Only raw answer/source excerpts are shown; imported evaluation is never authority. */
function archiveExcerpts(source:unknown):string[]{
    const excerpts:string[]=[],allowed=new Set(['answer','code','text','sourceQuote','front','back','prompt','question','content']);
    const excluded=new Set(['evaluation','formal','diagnostic','assessment','feedback','hint']);
    let visited=0;
    function visit(value:unknown,depth:number){
        if(excerpts.length>=8||depth>16||visited++>1000)return;
        if(Array.isArray(value)){for(const child of value)visit(child,depth+1);return;}
        if(!value||typeof value!=='object')return;
        for(const [key,child]of Object.entries(value)){
            if(excluded.has(key))continue;
            if(allowed.has(key)&&typeof child==='string'&&child.trim()){
                excerpts.push(child.slice(0,1600));if(excerpts.length>=8)return;
            }else visit(child,depth+1);
        }
    }
    visit(source,0);return excerpts;
}

export function NonwordRecoveryRestore({workspaceId,ready,port,onChanged}:Props){
    const live=useRef(true),scopeRef=useRef<Scope>({workspaceId,ready,flight:false});
    // Invalidate promises and old event closures during render, before effects run.
    // This ref is a cancellation epoch, never rendered data. Deferring its update
    // would let a previous account's promise remain authorized between render and effects.
    /* eslint-disable react-hooks/refs */
    if(scopeRef.current.workspaceId!==workspaceId||scopeRef.current.ready!==ready)
        scopeRef.current={workspaceId,ready,flight:false};
    const scope=scopeRef.current,callbacks=useRef(onChanged);callbacks.current=onChanged;
    const [state,setState]=useState<View>(()=>empty(scope));
    /* eslint-enable react-hooks/refs */
    const view=state.scope===scope?state:empty(scope);
    const eligible=ready&&Boolean(workspaceId?.startsWith('account:')&&workspaceId.length>8);
    const current=()=>live.current&&scopeRef.current===scope&&scope.ready&&eligible;
    const update=(change:Partial<View>)=>{if(current())setState(old=>({...((old.scope===scope)?old:empty(scope)),...change}));};
    useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);

    async function action(work:()=>Promise<void>){
        if(!current()||scope.flight)return;
        scope.flight=true;update({busy:true,error:'',notice:''});
        try{await work();}
        catch{update({error:'操作未完成。原文件与已有记录保留，可检查文件和本机存储后重试。'});}
        finally{scope.flight=false;update({busy:false});}
    }
    async function previewFile(loaded:Loaded){
        if(loaded.file.size>32*1024*1024||!loaded.file.name.toLowerCase().endsWith('.json')){
            update({loaded:null,error:'请选择不超过 32 MB 的 JSON 恢复包。'});return;
        }
        const raw=loaded.raw??await loaded.file.text();if(!current())return;
        update({loaded:{...loaded,raw}});
        const next={...loaded,raw,package:JSON.parse(raw) as unknown,completed:false,needsPreview:true};
        update({loaded:next});
        const preview=await port.preview(workspaceId!,next.package,{current});
        update({loaded:{...next,preview,needsPreview:false}});
    }
    async function restore(){
        const loaded=view.loaded;
        if(!loaded?.preview||loaded.needsPreview||loaded.completed)return;
        let result;
        try{result=await port.restore(workspaceId!,loaded.package,loaded.preview.previewHash,{current});}
        catch(reason){
            if(reason instanceof Error&&/重新预览/.test(reason.message)){
                update({loaded:{...loaded,needsPreview:true},error:'本机记录已有变化，请重新预览备份后恢复。'});return;
            }
            throw reason;
        }
        if(!current())return;
        if(result.status==='stale'){
            update({loaded:{...loaded,needsPreview:true},error:'恢复暂未完成，请重新预览。已保存的记录和原备份保留。'});
            if(result.restored>0)callbacks.current?.();return;
        }
        const held=result.conflicts+result.review;
        update({loaded:{...loaded,completed:true},notice:`已恢复 ${result.restored} 条记录，已有 ${result.existing} 条。非词汇备份副本已保留。${held?`冲突 ${result.conflicts} 条、待核对 ${result.review} 条已保留供核对。`:''}${result.status==='partial'?'仍有记录未恢复，可重新预览后继续。':''}`});
        callbacks.current?.();
    }
    async function archives(){
        const saved=await port.archives(workspaceId!);update({archives:saved});
    }
    const loaded=view.loaded,locked=!eligible||view.busy;
    return <section className="settings-card" aria-label="非词汇作答恢复" data-ai-private>
        <h3>恢复非词汇作答</h3>
        <p className="text-sm text-[var(--muted)]">选择原账号导出的备份，先核对可恢复的记录。冲突和需要核对的内容会保留，原备份不会覆盖已有记录。</p>
        {!eligible&&<p role="status">请登录原账号并等待本机记录准备完成后恢复。</p>}
        <label className="block mt-3 text-sm">选择恢复包
            <input key={JSON.stringify([workspaceId,ready])} className="block mt-2 max-w-full" type="file" accept=".json,application/json" disabled={locked}
                onChange={event=>{
                    const file=event.currentTarget.files?.[0];event.currentTarget.value='';
                    if(!file||!current()||scope.flight)return;
                    const selected:Loaded={file,raw:null,package:null,preview:null,needsPreview:true,completed:false};
                    update({loaded:selected});void action(()=>previewFile(selected));
                }}/>
        </label>
        {loaded&&<p className="mt-2 text-sm">已选择：{loaded.file.name}</p>}
        {view.busy&&<p role="status">正在核对与保存…</p>}
        {loaded?.preview&&<section className="mt-3" aria-label="恢复预览">
            <p>可恢复 {loaded.preview.restorable} 条，已有 {loaded.preview.existing} 条，冲突 {loaded.preview.conflicts} 条，待核对 {loaded.preview.review} 条。</p>
            {(loaded.preview.conflicts>0||loaded.preview.review>0)&&<p className="text-sm text-[var(--muted)]">冲突记录保留原内容；来源、评价与正式成绩需要核对后才能使用。</p>}
            <button type="button" className="study-primary-action mt-3" disabled={locked||loaded.needsPreview||loaded.completed}
                onClick={()=>void action(restore)}>恢复可核对的记录</button>
        </section>}
        {loaded&&(loaded.needsPreview||loaded.completed)&&<button type="button" className="study-secondary-action mt-3" disabled={locked}
            onClick={()=>void action(()=>previewFile(loaded))}>重新预览备份</button>}
        {view.error&&<p role="alert" className="mt-3">{view.error}</p>}
        {view.notice&&<p role="status" className="mt-3">{view.notice}</p>}
        <details className="mt-4">
            <summary>保留的原备份 · 待核对</summary>
            <p className="text-sm text-[var(--muted)]">只读查看部分原回答与来源文字；这里的内容仍待核对。</p>
            <button type="button" className="study-secondary-action mt-2" disabled={locked} onClick={()=>void action(archives)}>查看保留的原备份</button>
            {view.archives?.length===0&&<p role="status">当前账号暂无保留的原备份。</p>}
            {view.archives?.slice(0,10).map((archive,index)=><details key={archive.sourceHash} className="mt-3">
                <summary>备份 {index+1} · 待核对（只读）</summary>
                {archiveExcerpts(archive.source).map((excerpt,i)=><pre key={i} className="whitespace-pre-wrap break-words text-sm mt-2">{excerpt}</pre>)}
            </details>)}
            {view.archives&&view.archives.length>10&&<p>当前展示前 10 份备份。</p>}
        </details>
    </section>;
}
