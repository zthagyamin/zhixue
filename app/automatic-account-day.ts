import type {AccountStudyLoaded,createAccountStudyClient} from './account-study-client';
import type {AccountPlanState} from './account-study-runtime';
import type {SubmissionJournal} from './study-submission-journal';
// @ts-expect-error TS5097: standalone Node regression tests.
import {assertAccountPlanEvidence} from './account-plan-evidence.ts';
// @ts-expect-error TS5097: standalone Node regression tests.
import {composeAccountPlanningInput} from './account-study-planning-projection.ts';
// @ts-expect-error TS5097: standalone Node regression tests.
import {applyLongTermPlan} from './long-term-daily-plan.ts';
// @ts-expect-error TS5097: standalone Node regression tests.
import {generateTaskPlan} from './task-plan-engine.ts';
// @ts-expect-error TS5097: standalone Node regression tests.
import {sealCloudTaskPlan} from './account-study-planning.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {prepareMissingDailyPlan} from '../src/application/planning/index.ts';

/** Called after goal reconciliation. Prepare only a missing day; approval stays explicit. */
export async function prepareAutomaticAccountDay({client,loaded,state,day,workspaceId,journal,isCurrent,expectedLongTermRevision}:{
  client:Pick<ReturnType<typeof createAccountStudyClient>,'getLongTermPlanState'|'getPlanState'|'mutatePlan'>;
  loaded:AccountStudyLoaded;state:AccountPlanState;day:string;workspaceId:string;
  journal:SubmissionJournal;isCurrent:()=>boolean;expectedLongTermRevision:number;
}):Promise<AccountPlanState>{
  return prepareMissingDailyPlan({state,day,expectedLongTermRevision,isCurrent,newId:()=>crypto.randomUUID(),
    readGoals:()=>client.getLongTermPlanState(),assertEvidence:()=>assertAccountPlanEvidence(workspaceId,loaded,journal),
    build:async(before,snapshot)=>{
      const composed=await composeAccountPlanningInput({...loaded,day,previous:null});
      const input=applyLongTermPlan(composed.input,snapshot);if(!input.longTermAllocation)return null;
      const plan=await generateTaskPlan(input);
      return sealCloudTaskPlan(plan,loaded.catalog,{baseRevision:before.revision,factsHash:loaded.facts.factsHash,
        eventThrough:loaded.eventThrough,taskThrough:loaded.taskThrough,nativeBaseRevision:loaded.facts.nativePlanRevision});
    },
    saveDraft:async command=>({status:(await client.mutatePlan({action:'save',...command})).status}),
    readDay:async()=>await client.getPlanState(day) as unknown as AccountPlanState,
  });
}
