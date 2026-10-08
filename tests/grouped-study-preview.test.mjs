import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccountPreview} from './fixtures/account-preview.mjs';
import {createAccountStudyClient} from '../app/account-study-client.ts';
import {toEngineTaskPlan,toEnginePlanningCatalog} from '../app/account-study-planning.ts';
import {studyPracticeGroups} from '../app/study-practice-groups.ts';

for(const reviewTarget of [1,6])test(`full-page fixture preserves six real review assignments and target ${reviewTarget}`,async t=>{
  const origin='http://127.0.0.1:4187',preview=await createAccountPreview({origin,groupedStudy:true,manyReviews:true,reviewTarget});t.after(()=>preview.close());
  const client=createAccountStudyClient({companionUrl:origin,expectedUserId:preview.userId,cache:null,
    fetcher:(path,init)=>preview.handle(new Request(new URL(path,origin),{...init,headers:{...init?.headers,Origin:origin}}))});
  const loaded=await client.load(),state=await client.getPlanState(preview.day),catalog=await toEnginePlanningCatalog(loaded.catalog),plan=await toEngineTaskPlan(state.approvedPlan,loaded.catalog);
  assert.equal(plan.tasks.length,6);assert.equal(plan.longTermAllocation.reviewTarget,reviewTarget);
  const groups=studyPracticeGroups(plan,catalog,key=>{const item=loaded.bundle.items.find(item=>item.itemKey===key);return item.kind==='word'?'three-stage':item.practice.questionType;});
  assert.deepEqual(groups.map(group=>group.itemKeys.length),[2,3,1]);
  assert.equal(preview.inspect().records,0);assert.deepEqual(preview.inspect().aiRequests,[]);
});
