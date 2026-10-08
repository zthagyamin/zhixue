'use client';
import {useCallback,useState,type SetStateAction} from 'react';
import type {PlanCandidate,CurrentPlanPayload} from '../../domain/planning';
const empty:CurrentPlanPayload={revision:0,candidate:null,history:[]};
/** Scope-tagged view values never become command input for another owner or source library. */
export function useLegacyPlanState(scope:string,transport:object|null){
  const [draft,setDraft]=useState<{scope:string;value:PlanCandidate|null}|null>(null);
  const [saved,setSaved]=useState<{scope:string;transport:object|null;value:CurrentPlanPayload}|null>(null);
  const candidate=draft?.scope===scope?draft.value:null;
  const authority=saved?.scope===scope&&saved.transport===transport?saved.value:empty;
  const setCandidate=useCallback((update:SetStateAction<PlanCandidate|null>)=>setDraft(previous=>({scope,
    value:typeof update==='function'?update(previous?.scope===scope?previous.value:null):update})),[scope]);
  const publishAuthority=useCallback((value:CurrentPlanPayload)=>setSaved({scope,transport,value}),[scope,transport]);
  return {candidate,authority,setCandidate,publishAuthority};
}
