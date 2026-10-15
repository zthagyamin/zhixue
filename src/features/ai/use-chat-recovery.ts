'use client';
import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
// @ts-expect-error TS5097: standalone Node contracts.
import {mergeChatRecovery} from '../../application/ai/index.ts';
import type {ChatRecoveryJournal,ChatRecoveryEntry,ChatRecoveryCandidate,StudyAIService} from '../../application/ai';
import type {StudyAIMessage} from '../../domain/ai';

type Task={signal:AbortSignal;current:()=>boolean};
export function useChatRecovery(journal:ChatRecoveryJournal|null,enabled:boolean,
 setMessages:React.Dispatch<React.SetStateAction<StudyAIMessage[]>>){
 const [loaded,setLoaded]=useState<ChatRecoveryJournal|null>(null),[entries,setEntries]=useState<ChatRecoveryEntry[]>([]),[error,setError]=useState('');
 const active=useRef(journal);
 useLayoutEffect(()=>{active.current=journal;return()=>{if(active.current===journal)active.current=null;};},[journal]);
 const refresh=useCallback(async()=>{
  if(!journal)return;
  try{const rows=await journal.load();if(active.current!==journal)return;
   setEntries(rows);setMessages(current=>mergeChatRecovery(current,rows));setLoaded(journal);setError('');
  }catch(error){if(active.current===journal){setLoaded(null);setError(error instanceof Error?error.message:'ai-chat-storage-unavailable');}}
 },[journal,setMessages]);
 useEffect(()=>{if(!enabled||!journal)return;let current=true;
  void journal.load().then(rows=>{if(!current||active.current!==journal)return;
   setEntries(rows);setMessages(history=>mergeChatRecovery(history,rows));setLoaded(journal);setError('');
  }).catch(error=>{if(current&&active.current===journal){setLoaded(null);setError(error instanceof Error?error.message:'ai-chat-storage-unavailable');}});
  return()=>{current=false;};
 },[journal,enabled,setMessages]);
 const prepare=async(candidate:ChatRecoveryCandidate,task:Task)=>{
  if(!journal||loaded!==journal)throw Error('ai-chat-storage-unavailable');
  const row=await journal.prepare(candidate);task.signal.throwIfAborted();
  if(!task.current()||active.current!==journal)throw new DOMException('Cancelled','AbortError');
  setMessages(history=>mergeChatRecovery(history,[row]));return row;
 };
 const run=async(requestId:string,service:StudyAIService,task:Task)=>{
  if(!journal||loaded!==journal)throw Error('ai-chat-storage-unavailable');
  try{for await(const row of journal.run(requestId,service,task.signal)){
    if(!task.current()||active.current!==journal)return;
    setMessages(history=>mergeChatRecovery(history,[row]));
   }}finally{
    if(task.current()&&active.current===journal){const rows=await journal.load();
     if(task.current()&&active.current===journal)setEntries(rows);}
   }
 };
 return {ready:!journal||(enabled&&loaded===journal),pending:journal&&loaded===journal?entries.filter(row=>row.state!=='done'):[],error:journal?error:'',refresh,prepare,run};
}
