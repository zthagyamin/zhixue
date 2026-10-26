'use client';
import {useEffect,useLayoutEffect,useRef} from 'react';
import {createStudyNavigationFocus,restoreStudyReturnFocus,studyFocusEntry} from './navigation-focus';

export function useStudyNavigationFocus(scope:string,identity:string|null,page:string,enabled=true){
  const state=useRef<ReturnType<typeof createStudyNavigationFocus>|null>(null);
  if(state.current===null){state.current=createStudyNavigationFocus();}
  useEffect(()=>{
    const remember=(event:Event)=>{if(enabled&&event.target instanceof Element)state.current?.remember(scope,studyFocusEntry(event.target));};
    document.addEventListener('focusin',remember);document.addEventListener('pointerdown',remember,true);
    return()=>{document.removeEventListener('focusin',remember);document.removeEventListener('pointerdown',remember,true);};
  },[scope,enabled]);
  useLayoutEffect(()=>{
    if(!enabled)return;
    const action=state.current!.transition(scope,identity,page);
    if(action.kind==='none')return;
    let frame=0,attempts=0,observer:MutationObserver|null=null;
    const stopWaiting=()=>{observer?.disconnect();observer=null;};
    const move=()=>{
      if(document.querySelector('dialog[open]')||document.activeElement?.closest('input,textarea,select,[contenteditable="true"]')){stopWaiting();return;}
      const root=document.querySelector<HTMLElement>('.study-app.app-shell');
      if(!root)return;
      if(action.kind==='return'){
        if(!restoreStudyReturnFocus(root,action.entry)&&++attempts<3)frame=requestAnimationFrame(move);
        return;
      }
      const target=root.querySelector<HTMLElement>('.study-primary-session')??root.querySelector<HTMLElement>('.workspace > section:not([hidden])');
      if(!target){
        // Lazy subject loading must not focus an empty workspace. Wait for the real view.
        if(!observer){observer=new MutationObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(move);});observer.observe(root,{childList:true,subtree:true});}
        return;
      }
      stopWaiting();
      target.tabIndex=-1;target.focus({preventScroll:true});target.scrollIntoView({block:'start',behavior:'instant'});
    };
    frame=requestAnimationFrame(move);
    return()=>{cancelAnimationFrame(frame);stopWaiting();};
  },[scope,identity,page,enabled]);
}
