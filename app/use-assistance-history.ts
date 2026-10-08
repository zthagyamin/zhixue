"use client";
import {useEffect,useState} from 'react';
import type {AccountStudyLoaded} from './account-study-client';
import type {AssistanceReadView} from './assistance-read-cache';
import {createSubmissionJournal} from './study-submission-journal';
import {createAssistanceReadClient,reconcileAssistanceJournal} from './assistance-read-client';
import {readRecoverableStudyEvents} from './study-submission-history';
import {assistanceHistoryEntries,type AssistanceHistoryEntry,type AssistanceHistoryPhase} from './assistance-history';

type State={scope:string;phase:AssistanceHistoryPhase;entries:AssistanceHistoryEntry[]};
export function useAssistanceHistory({workspaceId,ready,account,revision}:{workspaceId:string;ready:boolean;account:AccountStudyLoaded|null;revision:number}){
  const scope=JSON.stringify([workspaceId,account?.bundle.snapshot.libraryId??'native']);
  const [state,setState]=useState<State>({scope:'',phase:'loading',entries:[]}),[retry,setRetry]=useState(0);
  useEffect(()=>{
    if(!ready)return;
    let active=true,running=false;const controller=new AbortController(),journal=createSubmissionJournal();
    const client=account?createAssistanceReadClient({workspaceId,libraryId:account.bundle.snapshot.libraryId}):null;
    const run=async()=>{
      if(running||!active)return;running=true;
      try{
        const all=await journal.list(workspaceId);if(!active)return;
        const rows=all.filter(row=>account?row.payload.route.kind==='account'&&row.payload.route.record.libraryId===account.bundle.snapshot.libraryId:row.payload.route.kind==='local');
        const accountIds=new Set(all.filter(row=>row.payload.route.kind==='account').map(row=>row.eventId));
        const events=account?account.records.filter(row=>row.record.provenanceMode!=='task').map(row=>row.record.event).filter(event=>event.schemaVersion===3):(await readRecoverableStudyEvents(workspaceId,journal)).filter(row=>!accountIds.has(row.eventId)).map(row=>row.event);
        const publish=(view:AssistanceReadView|null,phase:AssistanceHistoryPhase)=>{if(active)setState({scope,phase,entries:assistanceHistoryEntries(events,view,rows)});};
        if(client&&account){
          const cached=await client.cached();if(!active)return;publish(cached,'cached');
          const parents=new Map(account.records.map(row=>[row.record.event.eventId,row.record]));
          for(const row of rows)if(row.payload.route.kind==='account')parents.set(row.eventId,row.payload.route.record);
          const loaded=await client.load([...parents.values()],{signal:controller.signal});if(!active)return;
          const reconciliation=loaded.view?await reconcileAssistanceJournal(loaded.view,journal):null;if(!active)return;
          publish(loaded.view,reconciliation?.failed?'failed':loaded.supported?'ready':'unsupported');
        }else publish(null,'ready');
      }catch{if(active)setState(current=>({scope,phase:'failed',entries:current.scope===scope?current.entries:[]}));}
      finally{running=false;}
    };
    const refresh=()=>{if(!document.hidden)void run();};
    const initial=window.setTimeout(refresh,0),timer=window.setInterval(refresh,60000);
    window.addEventListener('online',refresh);document.addEventListener('visibilitychange',refresh);
    return()=>{active=false;controller.abort();window.clearTimeout(initial);window.clearInterval(timer);window.removeEventListener('online',refresh);document.removeEventListener('visibilitychange',refresh);};
  },[ready,workspaceId,scope,account,revision,retry]);
  return{phase:ready&&state.scope===scope?state.phase:'loading' as AssistanceHistoryPhase,entries:ready&&state.scope===scope?state.entries:[],refresh:()=>setRetry(value=>value+1)};
}
