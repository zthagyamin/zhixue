'use client';
import './paper-figure-panel.css';
import {useEffect,useRef,useState} from 'react';
import {figureCrop,type PaperFigure} from '../paper-figures';
import {verifiedPaperScope,type PaperOrigin} from '../paper-library-client';
import type {PaperServices} from '../plugins/plugin-paper';
export function PaperFigurePanel({figure,origin,services,onClose}:{figure:PaperFigure;origin?:PaperOrigin;services:PaperServices;onClose:()=>void}){
 const canvas=useRef<HTMLCanvasElement>(null),panel=useRef<HTMLElement>(null),[status,setStatus]=useState('正在读取已登记图表…'),[pinned,setPinned]=useState(true);
 useEffect(()=>{panel.current?.focus({preventScroll:true});},[]);
 useEffect(()=>{const node=panel.current;const close=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}};node?.addEventListener('keydown',close);return()=>node?.removeEventListener('keydown',close);},[onClose]);
 useEffect(()=>{
  const controller=new AbortController();
  let active=true,destroy:(()=>Promise<void>)|undefined;
  const current=()=>active&&services.isCurrent?.()!==false;
  async function render(){
   setStatus('正在读取已登记图表…');
   if(!origin||origin.kind!=='vault'||origin.version!==figure.sourceVersion||!services.libraryClient?.figure){setStatus('图表暂不可用。请连接对应学习库的新版 Companion，并重新读取来源。');return;}
   const client=services.libraryClient,scope=verifiedPaperScope(await client.catalog('',controller.signal),services);
   if(!current())return;
   const asset=await client.figure!({...scope,source:origin,assetId:figure.assetId,assetVersion:figure.assetVersion},controller.signal);
   if(!current())return;
   if(asset.assetId!==figure.assetId||asset.sourceVersion!==figure.sourceVersion||asset.assetVersion!==figure.assetVersion||typeof asset.data!=='string'||asset.data.length>27000000||!['image/png','image/jpeg','application/pdf'].includes(asset.mime))throw new Error('图表响应与来源不一致。');
   const bytes=Uint8Array.from(atob(asset.data),c=>c.charCodeAt(0)),hash=await crypto.subtle.digest('SHA-256',bytes);
   if(Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('')!==figure.assetVersion)throw new Error('图表版本已变化，请重新读取论文。');
   if(!current())return;
   let source:CanvasImageSource,width:number,height:number,bitmap:ImageBitmap|undefined;
   if(figure.kind==='pdf'){
    if(asset.mime!=='application/pdf')throw new Error('图表格式不一致。');
    const pdfjs=await import('pdfjs-dist');if(!current())return;
    pdfjs.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker-'+pdfjs.version+'.mjs';
    const task=pdfjs.getDocument({data:bytes,enableXfa:false});destroy=()=>task.destroy();
    const doc=await task.promise;if(!current())return;
    if(doc.numPages>200||!figure.page||figure.page>doc.numPages)throw new Error('图表页码不可用。');
    const page=await doc.getPage(figure.page),base=page.getViewport({scale:1});
    const viewport=page.getViewport({scale:Math.min(2,1800/Math.max(base.width,base.height),Math.sqrt(3000000/(base.width*base.height)))});
    const off=document.createElement('canvas');off.width=Math.ceil(viewport.width);off.height=Math.ceil(viewport.height);
    await page.render({canvas:off,viewport}).promise;if(!current())return;
    source=off;width=off.width;height=off.height;
   }else{
    if(asset.mime==='application/pdf')throw new Error('图表格式不一致。');
    bitmap=await createImageBitmap(new Blob([bytes],{type:asset.mime}));
    source=bitmap;width=bitmap.width;height=bitmap.height;
   }
   try{
    if(!current()||!canvas.current)return;
    if(width*height>12000000||width>8192||height>8192)throw new Error('图表像素过大，请缩小来源图片。');
    const crop=figureCrop(width,height,figure.region),scale=Math.min(1,1600/Math.max(crop.width,crop.height));
    canvas.current.width=Math.max(1,Math.floor(crop.width*scale));canvas.current.height=Math.max(1,Math.floor(crop.height*scale));
    canvas.current.getContext('2d')?.drawImage(source,crop.x,crop.y,crop.width,crop.height,0,0,canvas.current.width,canvas.current.height);
    setStatus('');
   }finally{bitmap?.close();}
  }
  void render().catch(error=>{if(current())setStatus(error instanceof Error?error.message:'图表读取失败，请重新连接来源。');}).finally(()=>{void destroy?.();});
  return()=>{active=false;controller.abort();void destroy?.();};
 },[figure,origin,services]);
 return <section ref={panel} role="dialog" aria-modal="false" tabIndex={-1} className={`paper-figure-panel${pinned?' is-pinned':''}`} aria-label={`${figure.label} 图表对照`}>
  <header><div><small>{figure.label}{figure.page?` · 第 ${figure.page} 页`:''}</small><h3>{figure.title}</h3></div><button type="button" aria-label="关闭图表" onClick={onClose}>×</button></header>
  <button type="button" aria-pressed={pinned} className="paper-figure-pin" onClick={()=>setPinned(v=>!v)}>{pinned?'已固定 · 解除固定':'固定图表'}</button>
  {status&&<p role="status">{status}</p>}<canvas ref={canvas} hidden={Boolean(status)} role="img" aria-label={`${figure.label}: ${figure.caption}`}/>
  <p className="paper-figure-caption">{figure.caption}</p>
 </section>;
}
