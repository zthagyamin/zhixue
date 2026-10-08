'use client';
import {useSyncExternalStore} from 'react';
import {reviewContextText,type ReviewContextData} from './review-context-model';
import './ux-remedies.css';
const subscribe=()=>()=>{};
const clientReady=()=>true;
const serverReady=()=>false;
export function ReviewContext(props:ReviewContextData){
 // Avoid server/device timezone differences in the hydration frame.
 const ready=useSyncExternalStore(subscribe,clientReady,serverReady);
 const text=reviewContextText({...props,due:ready?props.due:undefined});
 return <details className="study-review-context"><summary>{text.label} · 为什么练这题？</summary><p>{text.detail}</p></details>;
}
