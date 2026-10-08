'use client';
import {useId,useLayoutEffect,useRef,useSyncExternalStore,type ReactNode} from 'react';
import './ux-remedies.css';
const media='(max-width: 800px)';
const subscribe=(listener:()=>void)=>{const m=window.matchMedia(media);m.addEventListener('change',listener);return()=>m.removeEventListener('change',listener);};
const snapshot=()=>window.matchMedia(media).matches;
const serverSnapshot=()=>false;
/** Hide, never unmount, a panel when changing the mobile view. Both share the caller's draft. */
export function PaperWorkspacePanels({reading,board,active,onActiveChange}:{reading:ReactNode;board:ReactNode;active:0|1;onActiveChange:(index:0|1)=>void}){
 const narrow=useSyncExternalStore(subscribe,snapshot,serverSnapshot),id=useId();
 const workspace=useRef<HTMLDivElement>(null),lastActive=useRef(active);
 const tabs=useRef<(HTMLButtonElement|null)[]>([]),panels=useRef<(HTMLDivElement|null)[]>([]),scroll=useRef([0,0]),lastNarrow=useRef(narrow),tabHadFocus=useRef(false);
 useLayoutEffect(()=>{
  if(!narrow&&lastNarrow.current&&tabHadFocus.current)panels.current[active]?.focus({preventScroll:true});
  const changed=lastActive.current!==active;
  lastActive.current=active;
  lastNarrow.current=narrow;
  const root=workspace.current;
  if(!narrow||!root)return;
  // Mobile panels share the dialog/page scroller. Keep each position relative
  // to the workspace so collapsing document controls does not shift it.
  const container=root.closest<HTMLElement>('.paper-dialog')??document.scrollingElement as HTMLElement|null;
  if(!container)return;
  const page=container===document.scrollingElement,target=page?window:container;
  const origin=()=>root.getBoundingClientRect().top-(page?0:container.getBoundingClientRect().top+container.clientTop)+container.scrollTop;
  if(changed)container.scrollTop=Math.max(0,origin()+scroll.current[active]);
  const remember=()=>{scroll.current[active]=container.scrollTop-origin();};
  remember();target.addEventListener('scroll',remember,{passive:true});
  return()=>target.removeEventListener('scroll',remember);
 },[narrow,active]);
 return <div ref={workspace} className="paper-responsive-workspace" data-narrow={narrow}>
  {narrow&&<div className="paper-mobile-tabs" role="tablist" aria-label="论文工作区视图">{['文献阅读','主线填答'].map((label,index)=><button key={label} ref={node=>{tabs.current[index]=node;}} type="button" id={`${id}-tab-${index}`} role="tab" aria-selected={index===active} aria-controls={`${id}-panel-${index}`} tabIndex={index===active?0:-1} onFocus={()=>{tabHadFocus.current=true;}} onClick={()=>onActiveChange(index as 0|1)} onKeyDown={event=>{const next=event.key==='ArrowRight'||event.key==='ArrowLeft'?(index+1)%2:event.key==='Home'?0:event.key==='End'?1:null;if(next!==null){event.preventDefault();tabs.current[next]?.focus();}}}>{label}</button>)}</div>}
  <div className="paper-columns paper-responsive-columns">{[reading,board].map((panel,index)=><div key={index} ref={node=>{panels.current[index]=node;}} id={`${id}-panel-${index}`} className="paper-workspace-panel" onFocusCapture={()=>{tabHadFocus.current=false;if(!narrow&&active!==index)onActiveChange(index as 0|1);}} role={narrow?'tabpanel':undefined} aria-labelledby={narrow?`${id}-tab-${index}`:undefined} hidden={narrow&&index!==active} tabIndex={narrow?0:-1}>{panel}</div>)}</div>
 </div>;
}
