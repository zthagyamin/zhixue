// @ts-expect-error TS5097: standalone Node contracts.
import {checkContentQuality} from '../../src/domain/assessment/index.ts';
import type {AccountStudyLoaded,createAccountStudyClient} from '../account-study-client';
import type {AccountPlanState,prepareAccountPlanSource} from '../account-study-runtime';
import type {CloudTaskPlanV1} from '../account-study-planning';
import type {assertAccountPlanEvidence} from '../account-plan-evidence';
import type {readAccountLocalPractice} from '../study-submission-history';
import type {accountTaskActivity} from '../account-study-planning-projection';
import type {SubmissionJournal} from '../study-submission-journal';

/** Legacy account I/O and source projection only; approval order belongs to the application. */
export function createAccountPlanStartAdapter<State extends AccountPlanState>(context:{
  client:Pick<ReturnType<typeof createAccountStudyClient>,'mutatePlan'>;loaded:AccountStudyLoaded;
  workspaceId:string;day:string;journal:SubmissionJournal;readState:()=>Promise<State>;
},services:{assertAccountPlanEvidence:typeof assertAccountPlanEvidence;prepareAccountPlanSource:typeof prepareAccountPlanSource;
  readAccountLocalPractice:typeof readAccountLocalPractice;accountTaskActivity:typeof accountTaskActivity}){
  const {loaded,workspaceId,day,journal}=context;
  return {
    validateDraft(draft:CloudTaskPlanV1){
      const catalog=loaded.catalogs.find(value=>value.catalogHash===draft.catalogHash);
      if(!catalog||catalog.libraryId!==loaded.bundle.snapshot.libraryId||!loaded.bundles.some(bundle=>bundle.snapshot.snapshotId===catalog.snapshotId&&bundle.snapshot.libraryId===catalog.libraryId)){
        throw Error('草稿依赖的资料尚未完整读取，请刷新后重试。');
      }
    },
    assertEvidence:()=>services.assertAccountPlanEvidence(workspaceId,loaded,journal),
    approve:async(command:Parameters<typeof context.client.mutatePlan>[0])=>({status:(await context.client.mutatePlan(command)).status}),
    readState:context.readState,
    prepareSource:(state:State)=>services.prepareAccountPlanSource(loaded,state,day),
    async loadActivity(source:NonNullable<Awaited<ReturnType<typeof services.prepareAccountPlanSource>>>){
      const local=await services.readAccountLocalPractice(workspaceId,loaded.bundle.snapshot.libraryId,journal);
      const bundles=new Map(loaded.bundles.map(bundle=>[bundle.snapshot.snapshotId,bundle]));
      for(const bundle of local.bundles){
        const prior=bundles.get(bundle.snapshot.snapshotId);
        if(prior&&prior.snapshot.snapshotHash!==bundle.snapshot.snapshotHash)throw Error('本机与账号历史资料不一致，请核对。');
        bundles.set(bundle.snapshot.snapshotId,bundle);
      }
      const activity=await services.accountTaskActivity(source.cloud,source.cloudCatalog,[...bundles.values()],loaded.records,[...local.records,...(local.taskRecords??[])]);
      const withheldTaskIds=source.cloud.tasks.filter(task=>task.action.kind==='practice'&&task.action.itemKeys.every(key=>{
        const item=source.bundle.items.find(value=>value.itemKey===key);
        return item?.kind==='practice'&&item.practice.questionType==='recall'&&!checkContentQuality('recall',{...item.practice,learningSupport:item.learningSupport}).capabilities.canSelfCheck;
      })).map(task=>task.taskId);
      return {...activity,withheldTaskIds};
    },
  };
}
