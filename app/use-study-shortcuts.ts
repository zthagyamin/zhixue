'use client';
import {useEffect,type RefObject} from 'react';
import {handleStudyShortcut} from './study-shortcuts';
export function useStudyShortcuts(root:RefObject<HTMLElement|null>){
 useEffect(()=>{const handler=(event:KeyboardEvent)=>handleStudyShortcut(event,root.current);window.addEventListener('keydown',handler);return()=>window.removeEventListener('keydown',handler);},[root]);
}