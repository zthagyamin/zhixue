'use client';
import {useEffect,useState} from 'react';
export function useAccountAILibrary(userId:string|null,client:{currentLibrary:(signal?:AbortSignal)=>Promise<string|null>}){
  const [revision,setRevision]=useState(0),[state,setState]=useState<{userId:string|null;libraryId:string|null;phase:'ready'|'missing'|'failed'}|null>(null);
  useEffect(()=>{if(!userId)return;const controller=new AbortController();void client.currentLibrary(controller.signal).then(libraryId=>{if(!controller.signal.aborted)setState({userId,libraryId,phase:libraryId?'ready':'missing'});}).catch(()=>{if(!controller.signal.aborted)setState({userId,libraryId:null,phase:'failed'});});return()=>controller.abort();},[userId,client,revision]);
  return {libraryId:state?.userId===userId?state.libraryId:null,phase:state?.userId===userId?state.phase:'loading',refresh:()=>setRevision(value=>value+1)};
}
