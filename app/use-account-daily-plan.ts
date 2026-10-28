'use client';
import {useMemo,useState} from 'react';
import type {AccountStudyLoaded,createAccountStudyClient} from './account-study-client';
import {prepareAccountPlanSource,type AccountPlanSource,type AccountPlanState} from './account-study-runtime';
import {prepareAutomaticAccountDay} from './automatic-account-day';
import {createSubmissionJournal} from './study-submission-journal';
import {useDailyPlanView} from '../src/features/planning';
import type {DailyPlanPorts} from '../src/application/planning';
/** Account transport and immutable-source adapters; lifecycle belongs to the planning feature. */
export function useAccountDailyPlan(client:ReturnType<typeof createAccountStudyClient>,loaded:AccountStudyLoaded|null,day:string,workspaceId:string|null,options:{canPrepare?:()=>boolean}={}){
  const journal=useMemo(()=>createSubmissionJournal(),[]),{canPrepare}=options;
  const scope=loaded&&workspaceId?JSON.stringify([workspaceId,loaded.bundle.snapshot.libraryId,day]):null;
  const binding=useMemo(()=>({scope}),[scope]);
  const [origin,setOrigin]=useState<{binding:typeof binding;revision:number;hash:string}|null>(null);
  const ports=useMemo<DailyPlanPorts<AccountPlanState,AccountPlanSource>|null>(()=>!loaded||!workspaceId?null:{
    read:async()=>{setOrigin(value=>value?.binding===binding?null:value);return await client.getPlanState(day) as unknown as AccountPlanState;},
    project:state=>prepareAccountPlanSource(loaded,state,day),canPrepare,
    prepare:(state,expectedLongTermRevision,isCurrent)=>prepareAutomaticAccountDay({client,loaded,state,day,workspaceId,journal,expectedLongTermRevision,isCurrent,onCreated:value=>{if(scope&&isCurrent())setOrigin({binding,...value});}}),
  },[client,loaded,day,workspaceId,journal,canPrepare,scope,binding]);
  const view=useDailyPlanView(scope,day,ports);
  const draftOrigin:'automatic'|null=view.ready&&scope&&origin?.binding===binding&&view.state?.revision===origin.revision&&view.state.currentPlan?.cloudPlanHash===origin.hash?'automatic':null;
  return {...view,draftOrigin};
}
