"use client";
import {useEffect,useLayoutEffect} from 'react';
import type {LearningDraftAdapter} from './learning-draft-store';
import type {AssistanceObserver} from './assistance-observer';
import type {AssistanceAction} from './assistance-summary';

/** Only a mounted, instrumented built-in declares observation coverage. */
export function useAssistance(draft:LearningDraftAdapter|undefined):AssistanceObserver|undefined{
  const observer=draft?.assistance;useLayoutEffect(()=>{observer?.cover();},[observer]);return observer;
}
/** Call with the exact render condition. Successful-but-hidden requests are not aid. */
export function useAssistanceDisplay(observer:AssistanceObserver|undefined,action:AssistanceAction,displayId:string|null|undefined,active=true):void{
  useEffect(()=>{
    if(!observer||!active||!displayId)return;
    const shown=()=>{if(document.visibilityState!=='hidden')observer.shown(action,displayId);};
    shown();document.addEventListener('visibilitychange',shown);
    return()=>document.removeEventListener('visibilitychange',shown);
  },[observer,action,displayId,active]);
}
