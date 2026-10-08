'use client';
import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {LearningDraftAdapter} from './learning-draft-store';
import type {FSRSRating} from './plugins/registry';
import {openRecallAttempt,recordRecallHint,type RecallAttemptScope,type RecallAttemptState} from './recall-attempt-state';
import {createSubmissionJournal} from './study-submission-journal';
import {capRecallRating} from './learning-support';

export type RecallHintRecovery = {recover:()=>RecallAttemptState|null;persist:(state:RecallAttemptState)=>Promise<void>};
function controlledState(raw:RecallAttemptState):RecallAttemptState {
 if(!raw||Object.keys(raw).length!==3||Object.keys(raw).some(key=>!['schemaVersion','attemptId','maxPreHintLevel'].includes(key))||raw.schemaVersion!==1||typeof raw.attemptId!=='string'||!/^[a-zA-Z0-9:_.-]{1,120}$/.test(raw.attemptId)||!Number.isInteger(raw.maxPreHintLevel)||raw.maxPreHintLevel<0||raw.maxPreHintLevel>3)throw Error('recall-hint-state-invalid');
 return structuredClone(raw);
}

/** Only hint-use metadata persists. Answers and reference displays remain page drafts. */
export function useRecallSupport(enabled:boolean,draft:LearningDraftAdapter|undefined,scope:RecallAttemptScope|undefined,persistenceRequired=false,recovery?:RecallHintRecovery){
 const [state,setState]=useState<RecallAttemptState|null>(null),[error,setError]=useState(''),[pending,setPending]=useState(0),[retryNonce,setRetryNonce]=useState(0),[loadedKey,setLoadedKey]=useState('');
 const holder=useRef(draft);
 const live=useRef(true),value=useRef<RecallAttemptState|null>(null),waiting=useRef(0),earlyLevel=useRef(0),epoch=useRef(0);
 let recoveredId:string|null=null;try{recoveredId=recovery?.recover()?.attemptId??null;}catch{/* The async opener exposes recovery failure without rendering a hint. */}
 const key=recovery?JSON.stringify(['controlled',recoveredId]):scope?JSON.stringify(scope):'demo';
 const scopeRef=useRef(scope),lastKey=useRef(key),keyRef=useRef(key),recoveryRef=useRef(recovery);
 useLayoutEffect(()=>{holder.current=draft;scopeRef.current=scope;keyRef.current=key;recoveryRef.current=recovery;},[draft,scope,key,recovery]);
 const publish=useCallback((next:RecallAttemptState)=>{value.current=next;holder.current?.write('recallAttempt',next);if(live.current){setState(next);setLoadedKey(keyRef.current);}},[]);
 async function record(level:number){
  if(recoveryRef.current&&(!Number.isInteger(level)||level<0||level>3))throw Error('invalid-recall-hint-level');
  earlyLevel.current=Math.max(earlyLevel.current,level);
  const current=value.current;if(!current){earlyLevel.current=Math.max(earlyLevel.current,level);throw new Error('提示记录尚未就绪。');}
  const generation=epoch.current,target=scopeRef.current,originKey=keyRef.current,controlled=recoveryRef.current;
  waiting.current++;holder.current?.write('recallPolicyPending',true);if(live.current)setPending(waiting.current);
  try{
   const next=controlled?controlledState({...current,maxPreHintLevel:Math.max(current.maxPreHintLevel,earlyLevel.current)}):target?await recordRecallHint(target,current.attemptId,earlyLevel.current):{...current,maxPreHintLevel:Math.max(current.maxPreHintLevel,level)};
   if(controlled)await controlled.persist(next);
   if(!live.current||generation!==epoch.current||originKey!==keyRef.current)throw new Error('回忆题已变化。');publish(next);if(controlled){setError('');holder.current?.write('recallPolicyError',false);}return next;
  }catch(cause){if(live.current&&generation===epoch.current){setError('提示记录未能保存，请重试；当前答案继续保留。');holder.current?.write('recallPolicyError',true);}throw cause;}
  finally{if(generation===epoch.current){waiting.current--;holder.current?.write('recallPolicyPending',waiting.current>0);if(live.current)setPending(waiting.current);}}
 }
 useEffect(()=>{
  live.current=true;const generation=++epoch.current;value.current=null;waiting.current=0;
  if(lastKey.current!==key){lastKey.current=key;earlyLevel.current=0;}
  if(!enabled)return()=>{live.current=false;epoch.current=generation+1;};
  const target=scopeRef.current,controlled=recoveryRef.current;
  void (async()=>{
   await Promise.resolve();if(!live.current||generation!==epoch.current)return;setPending(0);setError('');setState(null);
   if(persistenceRequired&&!target&&!controlled)throw new Error('recall-attempt-identity-unavailable');
   let next=controlled?controlledState(controlled.recover()??{schemaVersion:1 as const,attemptId:crypto.randomUUID(),maxPreHintLevel:0}):target?await openRecallAttempt(target,async id=>(await createSubmissionJournal().list(target.workspaceId)).some(row=>row.coreStored&&row.payload.summary?.recallPolicy?.attemptId===id)):{schemaVersion:1 as const,attemptId:crypto.randomUUID(),maxPreHintLevel:0};
   if(!live.current||generation!==epoch.current)return;
   if(controlled){next=controlledState({...next,maxPreHintLevel:Math.max(next.maxPreHintLevel,earlyLevel.current)});await controlled.persist(next);}
   else if(earlyLevel.current&&target)next=await recordRecallHint(target,next.attemptId,earlyLevel.current);
   if(!live.current||generation!==epoch.current)return;publish(next);holder.current?.write('recallPolicyError',false);
  })().catch(()=>{if(live.current&&generation===epoch.current){setError('提示记录暂时无法读取，请保留页面并重试。');holder.current?.write('recallPolicyError',true);}});
  return()=>{live.current=false;epoch.current=generation+1;};
 },[enabled,key,retryNonce,publish,persistenceRequired]);
 useEffect(()=>{
  if(!enabled)return;
  return draft?.assistance?.onPreAssistance?.(action=>{
   const level=action==='ai-hint'?1:['ai-tutor','reference-answer'].includes(action)?3:0;
   if(!level)return;if(!value.current){earlyLevel.current=Math.max(earlyLevel.current,level);return;}
   void record(level).catch(()=>{});
  });
 // record uses current refs; subscribing depends on the observer instance.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[enabled,draft?.assistance]);
 return{state,error,retry:()=>setRetryNonce(value=>value+1),pending:pending>0,ready:!enabled||Boolean(state&&!error&&loadedKey===key),record,
  async grade(rating:FSRSRating,onGrade:(rating:FSRSRating)=>void){if(!enabled){onGrade(rating);return;}const next=await record(0);holder.current?.write('recallRequestedRating',rating);onGrade(capRecallRating(rating,next.maxPreHintLevel));},
 };
}
