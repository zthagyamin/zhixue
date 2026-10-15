'use client';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {PaperServices} from '../plugins/plugin-paper';
import {createPaperReadingRecoveryService} from './recovery';
import type {PaperReadingRecoveryArtifact} from '../../src/application/paper-reading-recovery';

type Preview=Awaited<ReturnType<ReturnType<typeof createPaperReadingRecoveryService>['preview']>>;
function BoundReadingBackupControls({services,beforeChange,beforeExport}:{services:PaperServices;beforeChange:()=>Promise<void>;beforeExport?:()=>Promise<void>}){
    const live=useRef(true),flight=useRef(false),current=useRef(services);
    useLayoutEffect(()=>{current.current=services;},[services]);
    const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
    const [loaded,setLoaded]=useState<{artifact:PaperReadingRecoveryArtifact;preview:Preview}|null>(null);
    const service=()=>createPaperReadingRecoveryService({ownerId:services.owner,libraryId:services.library},{isCurrent:()=>live.current&&current.current.isCurrent?.()!==false});
    useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
    async function action(work:()=>Promise<void>){
        if(flight.current)return;flight.current=true;setBusy(true);setError('');setNotice('');
        try{await work();}catch{if(live.current)setError('操作未完成。已有内容保留，请检查文件、资料库和本机存储后重试。');}
        finally{flight.current=false;if(live.current)setBusy(false);}
    }
    async function download(){
        await beforeChange();if(!live.current||current.current.isCurrent?.()===false)return;
        await beforeExport?.();if(!live.current||current.current.isCurrent?.()===false)return;
        const artifact=await service().export();if(!live.current||current.current.isCurrent?.()===false)return;
        const url=URL.createObjectURL(new Blob([JSON.stringify(artifact,null,2)],{type:'application/json'}));
        const link=document.createElement('a');link.href=url;link.download='paper-reading-backup.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }
    async function preview(file:File){
        if(file.size>50_000_000||!file.name.toLowerCase().endsWith('.json'))throw Error('invalid-backup-file');
        const artifact=await service().check(await file.text()),result=await service().preview(artifact);
        if(live.current)setLoaded({artifact,preview:result});
    }
    async function restore(){
        if(!loaded?.preview.canRestore)return;await beforeChange();await service().restore(loaded.artifact,loaded.preview.artifactHash);
        if(live.current)setNotice('阅读备份已恢复到本机。刷新后读取；账号同步另行确认。');
    }
    return <details><summary>阅读备份与恢复</summary>
        <p>包含原答、必要原文和草稿；不包含原 PDF 或正式成绩。</p>
        <button type="button" disabled={busy} onClick={()=>void action(download)}>导出阅读备份</button>
        <label>选择阅读备份<input type="file" accept=".json,application/json" disabled={busy} onChange={event=>{
            const file=event.currentTarget.files?.[0];event.currentTarget.value='';setLoaded(null);if(file)void action(()=>preview(file));
        }}/></label>{busy&&<p role="status">正在处理…</p>}{error&&<p role="alert">{error}</p>}
        {loaded&&<section aria-label="阅读恢复预览"><p>{loaded.preview.recordCount} 条记录：新增 {loaded.preview.added} 条，重复 {loaded.preview.duplicates} 条。</p>
            {loaded.preview.conflicts.length>0?<p role="alert">有 {loaded.preview.conflicts.length} 条现有内容不同，本次不会覆盖。请保留备份与当前记录。</p>:
                <button type="button" disabled={busy} onClick={()=>void action(restore)}>确认恢复到本机</button>}
        </section>}{notice&&<p role="status">{notice}<button type="button" onClick={()=>window.location.reload()}>刷新读取</button></p>}
    </details>;
}
export function ReadingBackupControls(props:{services:PaperServices;beforeChange:()=>Promise<void>;beforeExport?:()=>Promise<void>}){
    return <BoundReadingBackupControls key={JSON.stringify([props.services.owner,props.services.library])} {...props}/>;
}
