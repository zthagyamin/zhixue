'use client';
import {useEffect,useId,useLayoutEffect,useRef,useState,type RefObject} from 'react';
import type {PaperWord} from '../paper-study';
import {placePaperSelectionToolbar} from '../paper-selection-position';
import {speakWord} from '../plugins/speech';

type Props={word:PaperWord;raw:RefObject<HTMLParagraphElement|null>;selected:boolean;busy:boolean;pending:boolean;connected:boolean;focusOnOpen:boolean;
  message:string;error?:string;onMeaning:(value:string)=>void;onIngest:()=>void;onRetry:()=>void;onClose:(restoreFocus?:boolean)=>void;onTray:()=>void;onConnect?:()=>void};
export function PaperSelectionToolbar({word,raw,selected,busy,pending,connected,focusOnOpen,message,error,onMeaning,onIngest,onRetry,onClose,onTray,onConnect}:Props){
  const panel=useRef<HTMLElement>(null),input=useRef<HTMLInputElement>(null),id=useId();
  const [position,setPosition]=useState<ReturnType<typeof placePaperSelectionToolbar>>(null);
  useLayoutEffect(()=>{
    let frame=0;
    function measure(){
      frame=0;const source=raw.current,node=panel.current;
      if(!source||!node){setPosition(null);return;}
      const openDialog=document.querySelector('dialog[open]');
      if(openDialog&&!openDialog.contains(source)){setPosition(null);return;}
      const tokens=Array.from(source.querySelectorAll<HTMLElement>('button[data-paper-start]')).filter(token=>Number(token.dataset.paperStart)<word.end&&Number(token.dataset.paperEnd)>word.start);
      const rects=tokens.flatMap(token=>Array.from(token.getClientRects()));
      if(!rects.length){setPosition(null);return;}
      const view=window.visualViewport,reading=source.closest('.paper-reading')?.getBoundingClientRect(),dialog=source.closest('dialog')?.getBoundingClientRect();
      const left=view?.offsetLeft??0,top=view?.offsetTop??0,right=left+(view?.width??window.innerWidth),bottom=top+(view?.height??window.innerHeight);
      const bounds={left:Math.max(left,reading?.left??left,dialog?.left??left),right:Math.min(right,reading?.right??right,dialog?.right??right),top:Math.max(top,dialog?.top??top),bottom:Math.min(bottom,dialog?.bottom??bottom)};
      const anchor={left:Math.min(...rects.map(rect=>rect.left)),right:Math.max(...rects.map(rect=>rect.right)),top:Math.min(...rects.map(rect=>rect.top)),bottom:Math.max(...rects.map(rect=>rect.bottom))};
      const next=placePaperSelectionToolbar(anchor,{width:340,height:Math.max(node.scrollHeight,node.getBoundingClientRect().height)},bounds,node.contains(document.activeElement));
      setPosition(previous=>JSON.stringify(previous)===JSON.stringify(next)?previous:next);
    }
    const schedule=()=>{if(!frame)frame=window.requestAnimationFrame(measure);};
    measure();document.addEventListener('scroll',schedule,true);window.addEventListener('resize',schedule);
    window.visualViewport?.addEventListener('resize',schedule);window.visualViewport?.addEventListener('scroll',schedule);
    const size=typeof ResizeObserver==='undefined'?null:new ResizeObserver(schedule);if(panel.current)size?.observe(panel.current);if(raw.current)size?.observe(raw.current);
    const modal=typeof MutationObserver==='undefined'?null:new MutationObserver(schedule);modal?.observe(document.body,{subtree:true,attributes:true,attributeFilter:['open']});
    return()=>{if(frame)window.cancelAnimationFrame(frame);document.removeEventListener('scroll',schedule,true);window.removeEventListener('resize',schedule);window.visualViewport?.removeEventListener('resize',schedule);window.visualViewport?.removeEventListener('scroll',schedule);size?.disconnect();modal?.disconnect();};
  },[raw,word.id,word.start,word.end]);
  useEffect(()=>{if(focusOnOpen){const frame=window.requestAnimationFrame(()=>input.current?.focus({preventScroll:true}));return()=>window.cancelAnimationFrame(frame);}},[focusOnOpen,word.id]);
  useEffect(()=>{const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!panel.current?.contains(event.target)&&!raw.current?.contains(event.target))onClose(false);};document.addEventListener('pointerdown',outside,true);return()=>document.removeEventListener('pointerdown',outside,true);},[raw,onClose]);
  useEffect(()=>{
    const escape=(event:KeyboardEvent)=>{
      if(event.key!=='Escape'||event.defaultPrevented||event.isComposing||event.keyCode===229||event.ctrlKey||event.metaKey||event.altKey)return;
      const node=panel.current,source=raw.current,dialog=document.querySelector('dialog[open]');
      if(!node||!source||node.style.visibility==='hidden'||!node.getClientRects().length||dialog&&!dialog.contains(source))return;
      event.preventDefault();event.stopPropagation();onClose(true);
    };
    document.addEventListener('keydown',escape,true);return()=>document.removeEventListener('keydown',escape,true);
  },[raw,onClose]);
  return <section ref={panel} className="paper-selection-toolbar" role="group" aria-label="就地收词" aria-hidden={!position} style={position?{left:position.left,top:position.top,width:position.width,maxHeight:position.maxHeight}:{visibility:'hidden'}}>
    <header><strong lang="en">{word.term}</strong><div><button type="button" className="paper-selection-speak" onClick={()=>speakWord(word.term)} aria-label={`朗读 ${word.term}`}>朗读</button><button type="button" className="paper-selection-close" aria-label="关闭收词工具条" onClick={()=>onClose(true)}>×</button></div></header>
    <p className="paper-selection-source">{word.section} · {word.page?`第 ${word.page} 页`:word.locator??'当前微段'}</p>
    <label htmlFor={id}>这句话中的含义</label><input ref={input} id={id} value={word.meaning} maxLength={1000} readOnly={!selected} onChange={event=>onMeaning(event.target.value)} placeholder="补充语境释义后收录"/>
    {error&&<p className="paper-selection-status" role="alert">{error}</p>}
    {!connected&&<p className="paper-selection-status">Companion 未连接，所选词已保留。{onConnect&&<button type="button" onClick={onConnect}>连接资料助手</button>}</p>}
    {pending&&<p className="paper-selection-status">上次收词结果待确认，新选择继续保留。</p>}
    <div className="paper-selection-actions"><button type="button" onClick={onTray}>查看托盘</button>{pending?<button type="button" className="paper-selection-primary" disabled={busy||!connected||!!error} onClick={onRetry}>{busy?'正在核对…':'重试上次收词'}</button>:<button type="button" className="paper-selection-primary" disabled={busy||!connected||!selected||!word.meaning.trim()||!!error} onClick={onIngest}>{busy?'正在写入…':selected?'写入 Obsidian 词库':'已收录'}</button>}</div>
    {message&&<p className="paper-selection-status" role="status">{message}</p>}
  </section>;
}
