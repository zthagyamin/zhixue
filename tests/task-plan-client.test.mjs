import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createCompanionPlanClient} from '../app/companion-plan-client.ts';

const plan=JSON.parse(readFileSync(new URL('./fixtures/task-plan-v2.json',import.meta.url),'utf8'));
function clientFor(body,capabilities=[]) {
  const calls=[];
  const client=createCompanionPlanClient({baseUrl:'http://fixture',sessionToken:'fixture',capabilities,
    fetcher:async(url,init)=>{calls.push({url,init});return {ok:true,status:200,json:async()=>body};}});
  return {client,calls};
}
test('V2 save refuses an old Companion before sending any request',async()=>{
  const {client,calls}=clientFor({});
  assert.equal(typeof client.applyTaskPlan,'function','V2 save path is required');
  await assert.rejects(client.applyTaskPlan(plan,0),/升级 Companion/);
  assert.equal(calls.length,0);
});
test('V2 save validates and preserves its snapshot and revision',async()=>{
  const {client,calls}=clientFor({revision:{revision:4,after:plan}},['task-planning-v1']);
  assert.equal(typeof client.applyTaskPlan,'function');
  const result=await client.applyTaskPlan(plan,3);
  assert.deepEqual(result.revision.after,plan);
  assert.deepEqual(JSON.parse(calls[0].init.body).candidate,plan);
  assert.equal(JSON.parse(calls[0].init.body).expectedRevision,3);
});
test('V2 save does not trust a malformed response snapshot',async()=>{
  const {client}=clientFor({revision:{revision:4,after:{...plan,tasks:'lost'}}},['task-planning-v1']);
  await assert.rejects(client.applyTaskPlan(plan,3),/invalid-plan-tasks/);
});
test('legacy save cannot accidentally send a V2 snapshot',async()=>{
  const {client,calls}=clientFor({revision:{revision:1}});
  await assert.rejects(async()=>client.applyPlan(plan,0),/V2/);
  assert.equal(calls.length,0);
});
test('versioned reader preserves V2 while legacy reader refuses it',async()=>{
  const {client}=clientFor({revision:1,candidate:plan,history:[]});
  assert.equal(typeof client.getPlanDocument,'function');
  assert.deepEqual((await client.getPlanDocument()).candidate,plan);
  await assert.rejects(client.getCurrentPlan(),/V2/);
});
