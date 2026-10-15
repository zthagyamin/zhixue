'use client';
import {useEffect,useRef,useState} from 'react';
export type OriginalPageDocument={bytes:Uint8Array;sourceVersion:string;pageToRender:number};
export function PaperOriginalPage({physicalPage,sourceVersion,load,onClose}:{
    physicalPage:number;sourceVersion:string;load:(signal:AbortSignal)=>Promise<OriginalPageDocument>;onClose:()=>void;
}){
    const canvas=useRef<HTMLCanvasElement>(null),panel=useRef<HTMLElement>(null);
    const [status,setStatus]=useState('正在读取原页…');
    const [fit,setFit]=useState(false);
    useEffect(()=>{panel.current?.focus({preventScroll:true});},[]);
    useEffect(()=>{
        const node=panel.current;
        const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();onClose();}};
        node?.addEventListener('keydown',onKey);
        return()=>node?.removeEventListener('keydown',onKey);
    },[onClose]);
    useEffect(()=>{
        let active=true,destroy:(()=>Promise<void>)|undefined;
        const controller=new AbortController();
        const current=()=>active&&!controller.signal.aborted;
        async function render(){
            setStatus('正在读取原页…');
            const document=await load(controller.signal);
            if(!current())return;
            if(document.sourceVersion!==sourceVersion||document.bytes.byteLength>20000000)throw Error('原页与材料版本不一致。');
            const pdfjs=await import('pdfjs-dist');
            if(!current())return;
            pdfjs.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker-'+pdfjs.version+'.mjs';
            const task=pdfjs.getDocument({data:document.bytes.slice(),enableXfa:false});destroy=()=>task.destroy();
            const pdf=await task.promise;
            if(!current())return;
            if(pdf.numPages>200||!Number.isInteger(document.pageToRender)||document.pageToRender<1||document.pageToRender>pdf.numPages)throw Error('原文件没有对应物理页。');
            const page=await pdf.getPage(document.pageToRender),base=page.getViewport({scale:1});
            const viewport=page.getViewport({scale:Math.min(2,1800/Math.max(base.width,base.height),Math.sqrt(3000000/(base.width*base.height)))});
            if(!current()||!canvas.current)return;
            const target=canvas.current;target.width=Math.ceil(viewport.width);target.height=Math.ceil(viewport.height);
            await page.render({canvas:target,viewport}).promise;
            if(current())setStatus('');
        }
        void render().catch(error=>{if(current())setStatus(error instanceof Error?error.message:'原页暂不可用，原文与草稿保留。');})
            .finally(()=>{void destroy?.();});
        return()=>{active=false;controller.abort();void destroy?.();};
    },[load,sourceVersion]);
    return <section ref={panel} tabIndex={-1} className="paper-original-page" aria-label={`PDF 第 ${physicalPage} 页原页对照`}>
        <header><strong>PDF 第 {physicalPage} 页 · 原页对照</strong><button type="button" onClick={onClose}>关闭原页</button></header>
        {status&&<p role="status">{status}</p>}
        <button type="button" aria-pressed={fit} onClick={()=>setFit(value=>!value)}>{fit?'按原尺寸查看':'适合页面宽度'}</button>
        <div className="paper-original-scroll"><canvas hidden={Boolean(status)} style={{width:fit?'100%':undefined}} ref={canvas} role="img" aria-label={`原始 PDF 第 ${physicalPage} 页完整内容`}/></div>
    </section>;
}
