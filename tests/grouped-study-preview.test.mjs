import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccountPreview} from './fixtures/account-preview.mjs';
import {createAccountStudyClient} from '../app/account-study-client.ts';
import {toEngineTaskPlan,toEnginePlanningCatalog} from '../app/account-study-planning.ts';
import {studyPracticeGroups} from '../app/study-practice-groups.ts';
import {studyDay} from '../src/domain/planning/study-day.ts';
import {watchStudyDay} from '../src/application/planning/study-day-clock.ts';

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

for(const instant of ['2026-10-26T19:59:59.999Z','2026-10-26T20:00:00.000Z'])test(`grouped fixture clock coherently seeds ${instant} across the 04:00 boundary`,async t=>{
  const origin='http://127.0.0.1:4187',preview=await createAccountPreview({origin,groupedStudy:true,manyReviews:true,reviewTarget:6,now:()=>new Date(instant)});t.after(()=>preview.close());
  assert.equal(preview.day,studyDay(instant));
  const client=createAccountStudyClient({companionUrl:origin,expectedUserId:preview.userId,cache:null,
    fetcher:(path,init)=>preview.handle(new Request(new URL(path,origin),{...init,headers:{...init?.headers,Origin:origin}}))});
  const loaded=await client.load(),state=await client.getPlanState(preview.day),catalog=await toEnginePlanningCatalog(loaded.catalog),plan=await toEngineTaskPlan(state.approvedPlan,loaded.catalog);
  assert.equal(loaded.bundle.snapshot.generatedAt,instant);assert.equal(loaded.facts.observedAt,instant);
  assert.equal(plan.day,preview.day);assert.equal(plan.tasks.length,6);
  const groups=studyPracticeGroups(plan,catalog,key=>{const item=loaded.bundle.items.find(item=>item.itemKey===key);return item.kind==='word'?'three-stage':item.practice.questionType;});
  assert.deepEqual(groups.map(group=>group.itemKeys.length),[2,3,1]);assert.equal(preview.inspect().records,0);assert.deepEqual(preview.inspect().aiRequests,[]);
});

test('actual day watcher and account handler leave a single-day grouped seed intact after rollover',async t=>{
  let instant='2026-10-26T19:59:59.999Z',visible;const published=[];
  const origin='http://127.0.0.1:4187',preview=await createAccountPreview({origin,groupedStudy:true,manyReviews:true,reviewTarget:6,now:()=>new Date(instant)});t.after(()=>preview.close());
  const client=createAccountStudyClient({companionUrl:origin,expectedUserId:preview.userId,cache:null,
    fetcher:(path,init)=>preview.handle(new Request(new URL(path,origin),{...init,headers:{...init?.headers,Origin:origin}}))});
  const stop=watchStudyDay({now:()=>new Date(instant),publish:day=>published.push(day),schedule:()=>1,clear(){},onVisible:fn=>{visible=fn;return()=>{};}});t.after(stop);
  instant='2026-10-26T20:00:00.000Z';visible();
  assert.deepEqual(published,['2026-10-26','2026-10-27']);assert.equal(preview.day,'2026-10-26');
  const next=await client.getPlanState(published.at(-1)),prior=await client.getPlanState(preview.day);
  assert.equal(next.currentPlan,null);assert.equal(next.approvedPlan,null);assert.equal(prior.approvedPlan.tasks.length,6);
  const loaded=await client.load();assert.equal(loaded.facts.observedAt,'2026-10-26T19:59:59.999Z');assert.equal(preview.inspect().records,0);
});

test('existing graded preview records use the supplied fixture clock without contacting a provider',async t=>{
  const instant='2026-10-26T19:59:59.999Z',origin='http://127.0.0.1:4187';
  const preview=await createAccountPreview({origin,scenario:'partial-15',now:()=>new Date(instant)});t.after(()=>preview.close());
  const client=createAccountStudyClient({companionUrl:origin,expectedUserId:preview.userId,cache:null,
    fetcher:(path,init)=>preview.handle(new Request(new URL(path,origin),{...init,headers:{...init?.headers,Origin:origin}}))});
  const loaded=await client.load();assert.equal(loaded.records.length,3);
  assert.ok(loaded.records.every(row=>row.record.event.occurredAt===instant));assert.deepEqual(preview.inspect().aiRequests,[]);
});
