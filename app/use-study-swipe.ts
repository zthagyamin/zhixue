'use client';
import {useEffect,useRef,type PointerEvent} from 'react';
import {classifyStudySwipe,studySwipeAction,type SwipePoint} from './study-swipe';

export function useStudySwipe({revealed,ready,busy,isCurrent,onReveal,onGrade}:{revealed:boolean;ready:boolean;busy:boolean;isCurrent?:()=>boolean;onReveal:()=>void;onGrade:(rating:'again'|'good')=>void}){
 const gesture=useRef<(SwipePoint&{id:number;vertical:boolean})|null>(null);
 useEffect(()=>{const cancelOther=(event:globalThis.PointerEvent)=>{if(gesture.current&&gesture.current.id!==event.pointerId)gesture.current=null;};window.addEventListener('pointerdown',cancelOther,true);return()=>window.removeEventListener('pointerdown',cancelOther,true);},[]);
 const selectionActive=()=>typeof window!=='undefined'&&window.getSelection()?.isCollapsed===false;
 const isBlocked=(element:HTMLElement)=>{const modal=document.querySelector('dialog[open]');return Boolean(element.closest('fieldset:disabled,[inert],[aria-disabled="true"]')||modal&&!modal.contains(element));};
 return {
  onPointerDown(event:PointerEvent<HTMLElement>){
   gesture.current=null;
   if(!event.isPrimary||event.button!==0||busy||!ready||isBlocked(event.currentTarget)||selectionActive())return;
   const target=event.target instanceof Element?event.target:null;
   if(target?.closest('button,a,input,textarea,select,summary,[contenteditable]'))return;
   const vertical=Boolean(target?.closest('[data-swipe-reveal]'));
   // Mouse text selection stays native; the explicit handle supports desktop drag testing.
   if(event.pointerType==='mouse'&&!vertical)return;
   gesture.current={id:event.pointerId,x:event.clientX,y:event.clientY,time:event.timeStamp,vertical};
   event.currentTarget.setPointerCapture(event.pointerId);
  },
  onPointerCancel(){gesture.current=null;},
  onLostPointerCapture(){gesture.current=null;},
  onPointerUp(event:PointerEvent<HTMLElement>){
   const start=gesture.current;gesture.current=null;
   if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
   if(!start||start.id!==event.pointerId||isBlocked(event.currentTarget)||selectionActive())return;
   const direction=classifyStudySwipe(start,{x:event.clientX,y:event.clientY,time:event.timeStamp},start.vertical);
   const action=studySwipeAction(direction,{revealed,ready,busy,current:isCurrent?.()!==false});
   if(!action)return;
   if(action==='reveal')onReveal();else onGrade(action);
   if(event.pointerType!=='mouse'&&!window.matchMedia('(prefers-reduced-motion: reduce)').matches){try{navigator.vibrate?.(10);}catch{/* Optional hardware feedback never affects the action. */}}
  },
 };
}
