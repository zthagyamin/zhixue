'use client';
import {useState} from 'react';
import type {ChatRecoveryEntry} from '../../application/ai';

export function ChatRecoveryNotice({entries,disabled,onRestore}:{entries:ChatRecoveryEntry[];disabled:boolean;onRestore:(id:string)=>void}){
 const [selection,setSelection]=useState('');
 const row=entries.find(value=>value.request.requestId===selection)??entries.at(-1);
 if(!row)return null;
 return <div className="study-ai-recovery" role="status">
  {entries.length>1?<select aria-label="选择待核对的回答" value={row.request.requestId} onChange={event=>setSelection(event.target.value)}>
   {entries.map(value=><option key={value.request.requestId} value={value.request.requestId}>{value.request.context.title} · {value.user.content.slice(0,40)}</option>)}
  </select>:<span>{row.request.context.title} · 待核对</span>}
  <button type="button" disabled={disabled} onClick={()=>onRestore(row.request.requestId)}>恢复回答</button>
 </div>;
}
