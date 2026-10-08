'use client';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {verifiedPaperScope} from '../paper-library-client';
import {drawFlashcardMasks,verifyFlashcardImage,type OcclusionSupport} from '../flashcard-occlusion';
import type {PaperServices} from '../plugins/plugin-paper';
export function FlashcardImage({support,revealed,services,onReady}:{support:OcclusionSupport;revealed:boolean;services?:PaperServices;onReady:(ready:boolean)=>void}){
 const canvas=useRef<HTMLCanvasElement>(null),bitmap=useRef<ImageBitmap|null>(null),[status,setStatus]=useState('正在读取遮挡图片…'),[retry,setRetry]=useState(0),[revision,setRevision]=useState(0);
 const latest=useRef({support,revealed,services,onReady});useLayoutEffect(()=>{latest.current={support,revealed,services,onReady};});
 const identity=JSON.stringify(support),client=services?.libraryClient;
 useEffect(()=>{
  const controller=new AbortController();let active=true;const current=()=>active&&latest.current.services?.isCurrent?.()!==false;
  // Canvas/source changes must immediately close the reveal and grading gate.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  onReady(false);setStatus('正在读取遮挡图片…');bitmap.current?.close();bitmap.current=null;
  async function load(){
   if(!client?.figure||!services)throw Error('请连接对应学习库的新版 Companion，读取遮挡图片。');
   const scope=verifiedPaperScope(await client.catalog('',controller.signal),services);if(!current())return;
   const asset=await client.figure({...scope,sourceKey:support.sourceKey,sourceVersion:support.sourceVersion,assetId:support.assetId,assetVersion:support.assetVersion},controller.signal);if(!current())return;
   const blob=await verifyFlashcardImage(asset,support);if(!current())return;
   const image=await createImageBitmap(blob);if(!current()){image.close();return;}
   if(image.width>8192||image.height>8192||image.width*image.height>12000000){image.close();throw Error('图片像素过大，请缩小来源图片。');}
   bitmap.current=image;setRevision(v=>v+1);
  }
  void load().catch(error=>{if(current())setStatus(error instanceof Error?error.message:'图片暂不可用，请重试。');});
  return()=>{active=false;controller.abort();bitmap.current?.close();bitmap.current=null;};
  // Values are bound to immutable content + source owner; latest callbacks avoid reload loops.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[identity,client,services?.owner,services?.library,retry]);
 // Publish readiness only after the synchronous canvas paint succeeds.
 // eslint-disable-next-line react-hooks/set-state-in-effect
 useLayoutEffect(()=>{if(!bitmap.current||!canvas.current)return;try{drawFlashcardMasks(canvas.current,bitmap.current,bitmap.current.width,bitmap.current.height,support,revealed);setStatus('');latest.current.onReady(true);}catch(error){setStatus(error instanceof Error?error.message:'图片不可用。');latest.current.onReady(false);}},[revision,revealed,support]);
 return <div className="flashcard-image">
  <canvas ref={canvas} hidden={Boolean(status)} style={{maxWidth:'100%',height:'auto'}} role="img" aria-label={revealed?'当前目标区域已揭示，其余区域保持遮挡':'图片回忆题，请回忆问号遮挡区域的内容'}/>
  {status&&<div role="status"><p>{status}</p><button type="button" onClick={()=>setRetry(v=>v+1)}>重试图片</button>{services?.onSources&&<button type="button" onClick={services.onSources}>检查来源连接</button>}</div>}
 </div>;
}
