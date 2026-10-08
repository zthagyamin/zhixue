import assert from 'node:assert/strict';
import test from 'node:test';
import {createAccountStudyClient} from '../app/account-study-client.ts';
import {accountCompletedTaskIds} from '../app/account-study-planning-projection.ts';
let createAccountPreview;
try{({createAccountPreview}=await import('./fixtures/account-preview.mjs'));}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const origin='http://127.0.0.1:3004';
async function fixture(t,scenario){assert.equal(typeof createAccountPreview,'function','Preview must use an isolated real account handler');const f=await createAccountPreview({origin,scenario});t.after(()=>f.close());return f;}
function client(f){return createAccountStudyClient({companionUrl:'http://127.0.0.1:43224',fetcher:(url,init)=>f.handle(new Request(new URL(url,origin),init))});}
test('modern isolated preview exposes the real auxiliary tables and capability without a provider',async t=>{
  const f=await fixture(t,'approved-15'),boot=await f.handle(new Request(`${origin}/api/account-study?action=bootstrap&expectedUserId=${f.userId}`)),value=await boot.json();
  assert.ok(value.capabilities.includes('assistance-summary-v1'));assert.deepEqual(value.assistanceFences,{summaries:0,receipts:0});
  assert.equal(f.inspect().assistance,0);
});

test('the writeback preview starts unseeded and registers only a prepared synthetic device',async t=>{
  const userId='a'.repeat(64),f=await createAccountPreview({origin,scenario:'account-writeback',userId});t.after(()=>f.close());
  assert.equal(f.userId,userId);assert.equal((await (await f.handle(new Request(`${origin}/api/account-study?action=bootstrap`))).json()).snapshot,null);
  const registration=await f.registerDevice({grantId:'synthetic-test-grant',libraryId:'library-a',tokenHash:'b'.repeat(64),label:'Isolated writer'});assert.equal(registration.grantId,'synthetic-test-grant');assert.equal(registration.state,'pending');
  const boot=await (await f.handle(new Request(`${origin}/api/account-study?action=bootstrap`))).json();assert.equal(boot.profile.libraryId,null);assert.equal(boot.snapshot,null);assert.equal(f.inspect().records,0);
});
test('approved preview serves fifteen planned words from a larger real sealed catalog',async t=>{
  const f=await fixture(t,'approved-15'),c=client(f),loaded=await c.load(),state=await c.getPlanState(f.day);
  assert.equal(loaded.bundle.items.filter(item=>item.kind==='word').length,30);
  assert.equal(state.decision,'approved');
  assert.equal(state.approvedPlan.tasks.filter(task=>task.category==='new-word').flatMap(task=>task.action.itemKeys).length,15);
});
test('draft and no-plan previews do not invent an executable approved plan',async t=>{
  for(const scenario of ['draft-15','no-plan']){const f=await fixture(t,scenario),state=await client(f).getPlanState(f.day);assert.equal(state.approvedPlan,null);assert.equal(Boolean(state.currentPlan),scenario==='draft-15');}
});
test('preview blocks foreign origins and source-publishing actions from its browser identity',async t=>{
  const f=await fixture(t,'approved-15');
  assert.equal((await f.handle(new Request('https://example.invalid/api/account-study'))).status,403);
  const r=await f.handle(new Request(origin+'/api/account-study',{method:'POST',headers:{'content-type':'application/json',Origin:origin},body:JSON.stringify({action:'begin-snapshot'})}));
  assert.equal(r.status,403);
});
test('completed preview derives its completion from forty-five genuine isolated events',async t=>{
  const f=await fixture(t,'completed-15'),c=client(f),loaded=await c.load(),state=await c.getPlanState(f.day);
  assert.equal(loaded.records.length,45);
  assert.equal((await accountCompletedTaskIds(state.approvedPlan,loaded.catalog,loaded.bundles,loaded.records)).length,1);
});

test('all-plugins preview provides real calculation and code content without an approved plan',async t=>{
  const f=await fixture(t,'all-plugins'),c=client(f),loaded=await c.load();
  assert.ok(loaded.bundle.items.some(item=>item.kind==='practice'&&item.practice.questionType==='calculation'));
  assert.ok(loaded.bundle.items.some(item=>item.kind==='practice'&&item.practice.questionType==='code'));
  assert.equal((await c.getPlanState(f.day)).approvedPlan,null);
});

test('long-material preview seals readable paragraphs through the same content API',async t=>{
  const f=await createAccountPreview({origin,scenario:'no-plan',longReading:true});t.after(()=>f.close());
  const loaded=await client(f).load(),question=loaded.bundle.items.find(item=>item.kind==='practice');
  assert.ok(question.practice.prompt.length>2000);assert.match(question.practice.prompt,/Paragraph 16/);
  assert.equal(f.inspect().records,0);
});

test('partial preview provides real resume evidence without completing the whole task',async t=>{
  const f=await fixture(t,'partial-15'),c=client(f),loaded=await c.load(),state=await c.getPlanState(f.day);
  assert.equal(loaded.records.length,3);assert.deepEqual(await accountCompletedTaskIds(state.approvedPlan,loaded.catalog,loaded.bundles,loaded.records),[]);
});
