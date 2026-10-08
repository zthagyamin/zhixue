"use client";
import {useEffect,useState} from 'react';
import type {AccountStudyLoaded} from './account-study-client';
import type {CloudTaskPlanV1} from './account-study-planning';
import type {SubmissionJournal} from './study-submission-journal';
import {readAccountLocalPractice} from './study-submission-history';
import {accountTaskActivity} from './account-study-planning-projection';

export type AccountProgressPlanInput={workspaceId:string;loaded:AccountStudyLoaded;plan:CloudTaskPlanV1|null;journal:SubmissionJournal;revision:number};
type View={scope:string;phase:'ready'|'failed';counts:Record<string,{completed:number;total:number}>};
/** Read-only presentation, using the same validated task activity as Today. */
export function useProgressPlanScope(input:AccountProgressPlanInput|null|undefined){
  const [view,setView]=useState<View|null>(null);
  const loaded=input?.loaded,plan=input?.plan,journal=input?.journal,workspaceId=input?.workspaceId;
  const scope=input&&plan?JSON.stringify([workspaceId,loaded?.bundle.snapshot.libraryId,plan.cloudPlanHash,loaded?.eventThrough,input.revision]):null;
  useEffect(()=>{
    if(!loaded||!plan||!journal||!workspaceId||!scope)return;
    let active=true;
    void (async()=>{
      try{
        const catalog=loaded.catalogs.find(value=>value.catalogHash===plan.catalogHash);
        if(!catalog)throw new Error('Plan source unavailable');
        const local=await readAccountLocalPractice(workspaceId,loaded.bundle.snapshot.libraryId,journal);
        const bundles=new Map(loaded.bundles.map(bundle=>[bundle.snapshot.snapshotId,bundle]));
        for(const bundle of local.bundles){const prior=bundles.get(bundle.snapshot.snapshotId);if(prior&&prior.snapshot.snapshotHash!==bundle.snapshot.snapshotHash)throw new Error('Conflicting historical source');bundles.set(bundle.snapshot.snapshotId,bundle);}
        const activity=await accountTaskActivity(plan,catalog,[...bundles.values()],loaded.records,[...local.records,...(local.taskRecords??[])]);
        if(active)setView({scope,phase:'ready',counts:activity.itemProgressByTask});
      }catch{if(active)setView({scope,phase:'failed',counts:{}});}
    })();
    return()=>{active=false;};
  },[loaded,plan,journal,workspaceId,scope]);
  return scope&&view?.scope===scope?view:null;
}
