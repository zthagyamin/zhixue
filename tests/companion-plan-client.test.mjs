import assert from "node:assert/strict";
import test from "node:test";

import { createCompanionPlanClient } from "../app/companion-plan-client.ts";

function fakeFetch(status, body) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetcher, calls };
}

const candidate = { day: "2026-08-25", planHash: "a".repeat(64), items: [], totalMinutes: 0, overloaded: false, skipped: [] };

test('task suggestions carry pairing, version and readable fallback without saving',async()=>{
  const request={day:'2026-08-31',sourceHash:'a'.repeat(64),draftVersion:7,excludedUnitIds:[],selectedUnitIds:[],intent:'standard'};
  const response={day:request.day,sourceHash:request.sourceHash,draftVersion:7,mode:'fallback',selections:[{unitIds:['unit'],reason:'资料顺序'}],message:'AI暂不可用'};
  const {fetcher,calls}=fakeFetch(200,response);
  const client=createCompanionPlanClient({fetcher,baseUrl:'http://local',sessionToken:'fixture-session',capabilities:['task-planning-v1']});
  assert.equal(typeof client.suggestPlan,'function');
  assert.deepEqual(await client.suggestPlan(request),response);
  assert.equal(calls.length,1);assert.equal(calls[0].url,'http://local/v1/plan/suggest');
  assert.deepEqual(calls[0].body,request);assert.equal(calls[0].init.headers['X-Study-Loop-Session'],'fixture-session');
  assert.ok(calls[0].init.signal);
});
test('suggestions reject malformed responses and retain server error messages',async()=>{
  for(const [status,payload,pattern] of [[200,{mode:'ai',selections:[{unitIds:['invented']}]},/invalid-suggestion/],
    [200,{day:'2026-08-31',sourceHash:['a'.repeat(64)],draftVersion:1,mode:'ai',message:'',selections:[]},/invalid-suggestion/],
    [409,{message:'来源已变更'},/来源已变更/]]) {
    const {fetcher}=fakeFetch(status,payload);
    const client=createCompanionPlanClient({fetcher,baseUrl:'http://local',sessionToken:'fixture-session',capabilities:['task-planning-v1']});
    assert.equal(typeof client.suggestPlan,'function');
    await assert.rejects(client.suggestPlan({day:'2026-08-31',sourceHash:'a'.repeat(64),draftVersion:1,excludedUnitIds:[],selectedUnitIds:[],intent:'standard'}),pattern);
  }
});

test('task events use independent paired routes and require a matching durable receipt',async()=>{
  const {readFile}=await import('node:fs/promises');
  const event=JSON.parse(await readFile(new URL('./fixtures/task-event-v1.json',import.meta.url),'utf8'));
  const options={baseUrl:'http://local',sessionToken:'fixture-task-session',capabilities:['task-planning-v1']};
  const ack=fakeFetch(200,{status:'accepted',eventId:event.eventId,durable:true});
  const client=createCompanionPlanClient({...options,fetcher:ack.fetcher});
  assert.equal(typeof client.appendTaskEvent,'function');
  assert.equal((await client.appendTaskEvent(event)).status,'accepted');
  assert.equal(ack.calls[0].url,'http://local/v1/tasks/events');assert.deepEqual(ack.calls[0].body,{event});
  assert.equal(ack.calls[0].init.headers['X-Study-Loop-Session'],options.sessionToken);
  const history=fakeFetch(200,{events:[event],nextCursor:null,snapshotHash:'a'.repeat(64)});
  const reader=createCompanionPlanClient({...options,fetcher:history.fetcher});
  assert.deepEqual((await reader.getTaskEvents('cursor+value')).events,[event]);
  assert.match(history.calls[0].url,/after=cursor%2Bvalue/);
  const invalid=fakeFetch(200,{status:'accepted',eventId:'another-event',durable:false});
  await assert.rejects(createCompanionPlanClient({...options,fetcher:invalid.fetcher}).appendTaskEvent(event),/receipt/);
});
test('planning context and evidence requests use the paired version-bound routes',async()=>{
  const {vocabularyInput}=await import('./fixtures/task-plan-input.mjs');
  const context={catalog:vocabularyInput(0).catalog,sourceReviews:[],captureReviews:[],observedAt:'2026-08-31T00:00:00.000Z',planRevision:3,capabilities:['task-planning-v1']};
  const options={baseUrl:'http://local',sessionToken:'fixture-planning-session',capabilities:context.capabilities};
  const getContext=fakeFetch(200,context),client=createCompanionPlanClient({...options,fetcher:getContext.fetcher});
  assert.equal(typeof client.getPlanningContext,'function');assert.deepEqual(await client.getPlanningContext(),context);
  assert.equal(getContext.calls[0].url,'http://local/v1/plan/context');
  const sourceHash=context.catalog.sourceHash;
  const page={records:[],sourceHash,planRevision:3,snapshotHash:'a'.repeat(64),nextCursor:null};
  const history=fakeFetch(200,page),reader=createCompanionPlanClient({...options,fetcher:history.fetcher});
  assert.deepEqual(await reader.getPlanningEvidence(sourceHash,3,'cursor+value'),page);
  assert.equal(history.calls[0].url,`http://local/v1/plan/evidence?sourceHash=${sourceHash}&planRevision=3&after=cursor%2Bvalue`);
  assert.equal(history.calls[0].init.headers['X-Study-Loop-Session'],options.sessionToken);
});

test("applyPlan sends expectedRevision and surfaces 409 as stale", async () => {
  const { fetcher, calls } = fakeFetch(409, { status: "stale", message: "refresh" });
  const client = createCompanionPlanClient({ fetcher, baseUrl: "http://local", sessionToken: "token-1" });
  const result = await client.applyPlan(candidate, 3, "user-1");
  assert.equal(result.status, "stale");
  assert.equal(calls[0].body.expectedRevision, 3);
  assert.equal(calls[0].init.headers["X-Study-Loop-Session"], "token-1");
});

test("constraints and immediate scan use Companion authority routes", async () => {
  const constraints = { mode: "auto", system: {}, effective: {}, deadlines: [], explanation: "fallback" };
  const { fetcher, calls } = fakeFetch(200, constraints);
  const client = createCompanionPlanClient({ fetcher, baseUrl: "http://local", sessionToken: "token-1" });
  assert.equal((await client.getConstraints()).mode, "auto");
  await client.saveConstraints(constraints);
  await client.scanChanges();
  assert.deepEqual(calls.map((call) => [call.url, call.init.method ?? "GET"]), [
    ["http://local/v1/constraints", "GET"],
    ["http://local/v1/constraints", "POST"],
    ["http://local/v1/changes/scan", "POST"],
  ]);
});

test("change decisions send the paired audit payload and surface Companion errors", async () => {
  const stale = fakeFetch(400, { message: "资料变更已过期，请重新检查后再决定。" });
  const staleClient = createCompanionPlanClient({ fetcher: stale.fetcher, baseUrl: "http://local", sessionToken: "token-1" });
  await assert.rejects(
    staleClient.decideChange("change-1", "approved", "user-1"),
    /资料变更已过期，请重新检查后再决定。/,
  );
  assert.deepEqual(stale.calls[0].body, { changeId: "change-1", decision: "approved", operator: "user-1" });
  assert.equal(stale.calls[0].init.headers["X-Study-Loop-Session"], "token-1");

  const accepted = fakeFetch(200, { changeId: "change-1", decision: "approved", log: [] });
  const acceptedClient = createCompanionPlanClient({ fetcher: accepted.fetcher, baseUrl: "http://local", sessionToken: "token-1" });
  assert.equal((await acceptedClient.decideChange("change-1", "approved", "user-1")).decision, "approved");
});

test("reject and restore use explicit audit and concurrency payloads", async () => {
  const { fetcher, calls } = fakeFetch(200, { revision: { revision: 4 } });
  const client = createCompanionPlanClient({ fetcher, baseUrl: "http://local", sessionToken: "token-1" });
  await client.rejectPlan("b".repeat(64), "not today", "user-1");
  const restored = await client.restorePlan(2, 3, "user-1");
  assert.equal(restored.status, "ok");
  assert.equal(calls[0].body.candidateHash, "b".repeat(64));
  assert.deepEqual(calls[1].body, { target: 2, expectedRevision: 3, operator: "user-1" });
});

test("gradePractice sends the session header and returns the verdict", async () => {
  // I2：计算题判题必须经 companionPlanClient.gradePractice —— 它携带
  // X-Study-Loop-Session 头；插件裸 fetch 缺这个头，服务器恒 401。
  const { fetcher, calls } = fakeFetch(200, { correct: true, verdict: "correct", explanation: "容差内" });
  const client = createCompanionPlanClient({ fetcher, baseUrl: "http://local", sessionToken: "token-1" });
  const item = { questionType: "calculation", prompt: "softmax 梯度 ∂L/∂z", answer: "2.0" };
  const result = await client.gradePractice(item, "2.0");
  assert.equal(calls[0].url, "http://local/v1/practice/grade");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["X-Study-Loop-Session"], "token-1");
  assert.deepEqual(calls[0].body, { item, answer: "2.0" });
  assert.equal(result.verdict, "correct");
});
