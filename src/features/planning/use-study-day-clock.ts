'use client';
import {useEffect,useState} from 'react';
import {studyDay} from '../../domain/planning';
import {watchStudyDay} from '../../application/planning';

export function useStudyDayClock(){
  const [day,setDay]=useState(()=>studyDay(new Date().toISOString()));
  useEffect(()=>watchStudyDay({
    now:()=>new Date(),publish:setDay,
    schedule:(callback,delay)=>window.setTimeout(callback,delay),clear:handle=>window.clearTimeout(handle as number),
    onVisible:callback=>{const listener=()=>{if(!document.hidden)callback();};document.addEventListener('visibilitychange',listener);return()=>document.removeEventListener('visibilitychange',listener);},
  }),[]);
  return day;
}
