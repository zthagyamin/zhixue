'use client';
import {useCallback,useRef,useState,type SetStateAction} from 'react';
/** The connection identity changes synchronously, before a delayed response or React repaint can observe it. */
export function useConnectionValue<Connection>(initial:Connection){
  const [value,publish]=useState(initial),actual=useRef(value);
  const set=useCallback((update:SetStateAction<Connection>)=>{
    const next=typeof update==='function'?(update as (value:Connection)=>Connection)(actual.current):update;
    if(Object.is(next,actual.current))return;actual.current=next;publish(next);
  },[]);
  const read=useCallback(()=>actual.current,[]);
  return[value,set,read] as const;
}
