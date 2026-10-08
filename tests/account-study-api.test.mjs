// Active-writer fixtures use today's clock: receipt SQL checks expiry against SQLite 'now'.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {openD1} from './helpers/sqlite-d1.mjs';
import {AccountStudyAccessStore} from '../db/account-study-access-store.ts';
import {AccountStudyStore} from '../db/account-study-store.ts';
import {AccountStudyReceiptStore} from '../db/account-study-receipt-store.ts';
import {AccountStudyPlanStore} from '../db/account-study-plan-store.ts';
import {AccountLongTermPlanStore} from '../db/account-long-term-plan-store.ts';
import {readFileSync} from 'node:fs';
import {AccountStudyAiStore} from '../db/account-study-ai-store.ts';
import {AccountStudyContentDecisionStore} from '../db/account-study-content-decision-store.ts';
import {AccountAssistanceStore} from '../db/account-assistance-store.ts';
import {sealAccountAssistance} from '../app/assistance-record.ts';
import {sealAssistanceSummary} from '../app/assistance-summary.ts';
import {sealStudyItem,sealStudySnapshot,studyHash} from '../app/account-study-content.ts';
import {sealStudyRecord} from '../app/account-study-record.ts';
import {wordBody,snapshotBody,recordBody} from './fixtures/account-study-fixtures.mjs';
import {attempt} from './fixtures/task-event-fixtures.mjs';
import {toCloudPlanningCatalog,toEnginePlanningCatalog,sealCloudTaskPlan,sealCloudPlanningFacts} from '../app/account-study-planning.ts';
import {generateTaskPlan} from '../app/task-plan-engine.ts';
import {courseSubject} from './fixtures/task-plan-input.mjs';
import {hashTaskEvent} from '../app/task-event-v1.ts';
let api;
try {api=await import('../app/account-study-api.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;}
const ORIGIN='https://study.example.test',URL_ROOT=`${ORIGIN}/api/account-study`;
const SECRET=Buffer.alloc(32,7).toString('base64url');
const registration=()=>({grantId:'grant-one',libraryId:'library-a',tokenHash:createHash('sha256').update(SECRET).digest('hex'),label:'Desktop',expectedProfileRevision:0,replaceLibrary:false});
function request(method,action,body={},query={},token){
  const url=new URL(URL_ROOT);if(method==='GET') url.searchParams.set('action',action);
  Object.entries(query).forEach(([k,v])=>url.searchParams.set(k,String(v)));
  const headers={'Content-Type':'application/json',Origin:ORIGIN};if(token) headers.Authorization=`Bearer ${token}`;
  return new Request(url,{method,headers,...(method==='POST'?{body:JSON.stringify({action,...body})}:{})});
}
async function setup(t){assert.equal(typeof api?.createAccountStudyHandlers,'function','Account transport handler must exist');
  const {sqlite,binding}=await openD1();t.after(()=>sqlite.close());const access=new AccountStudyAccessStore(binding),study=new AccountStudyStore(binding);
  const receipts=new AccountStudyReceiptStore(binding,()=>new Date('2026-09-01T00:00:00.000Z'));
  const plans=new AccountStudyPlanStore(binding),aiStore=new AccountStudyAiStore(binding,Buffer.alloc(32,5).toString('base64url')),contentDecisions=new AccountStudyContentDecisionStore(binding),aiCalls=[];
  const planTrace={modelId:'deepseek-test-model',promptVersion:'plan-ai-json-v1',ruleVersion:'plan-ai-selection-v1'},questionTrace={modelId:'deepseek-test-model',promptVersion:'question-ai-json-v1',ruleVersion:'question-ai-answer-binding-v1'};
  const planAi={trace:planTrace,available:true,recommend:async request=>{aiCalls.push(request);return {selectedUnitIds:[],optionalOrder:[],message:'Deterministic set retained',trace:planTrace,usageTokens:12};}};
  const questionAi={trace:questionTrace,available:true,run:async request=>({snapshotId:request.snapshotId,itemKey:request.itemKey,contentHash:request.contentHash,attemptId:request.attemptId,text:'Hint',trace:questionTrace,usageTokens:4})};
  const handlers=(userId='user-a',enabled=true,aiAvailable=true,overrides={})=>api.createAccountStudyHandlers({enabled,getBrowserUser:async()=>userId?{userId}:null,getAccessStore:async()=>access,getStudyStore:async()=>study,getReceiptStore:async()=>receipts,getAssistanceStore:async()=>new AccountAssistanceStore(binding,()=>new Date('2026-09-01T00:00:00.000Z')),getPlanStore:async()=>plans,getLongTermStore:async()=>new AccountLongTermPlanStore(binding),getAiStore:async()=>aiStore,getContentDecisionStore:async()=>contentDecisions,getPlanAiTrace:()=>planTrace,getQuestionAiTrace:()=>questionTrace,getPlanAi:async scope=>{await aiStore.providerKey(scope);return planAi;},getQuestionAi:async scope=>{await aiStore.providerKey(scope);return questionAi;},getChatAi:async scope=>({async *stream(){const settings=await aiStore.getSettings(scope);yield{type:'delta',text:'Synthetic answer 你好'};yield{type:'done',model:settings.model,provider:settings.provider,usageTokens:4};}}),planAiAvailable:()=>aiAvailable,...overrides});
  const items=[await sealStudyItem(wordBody())],snapshot=await sealStudySnapshot(snapshotBody(items));
  async function prepared(){await access.register('user-a',registration());await access.activate(SECRET);await study.putSnapshot({userId:'user-a',libraryId:'library-a'},{snapshot,items},0);}
  async function record(n=1){return sealStudyRecord(await recordBody({contentHash:items[0].contentHash,roundId:`round-${n}`,attemptId:`attempt-${n}`,
    event:await attempt(`event-${n}`,'2026-09-01T00:01:00Z',0,1)}));}
  return {sqlite,access,study,plans,aiStore,aiCalls,handlers,prepared,record,snapshot,items};
}

test('model listing is browser scoped, revision checked and returns model IDs only',async t=>{
 const f=await setup(t);await f.prepared();let selection;
 const handlers=f.handlers('user-a',true,true,{getAiModels:async(_scope,value)=>{selection=value;return ['gpt-test-chat'];}});
 const body={selection:{provider:'chatgpt',baseUrl:'https://api.openai.com/v1',providerKey:'synthetic-only-key',expectedRevision:0}};
 const response=await handlers.POST(request('POST','ai-models',body));assert.equal(response.status,200);assert.deepEqual(await response.json(),{models:['gpt-test-chat']});assert.equal(selection.provider,'chatgpt');
 const invalid=await handlers.POST(request('POST','ai-models',{selection:{...body.selection,baseUrl:'https://different.example/v1',providerKey:'        '}}));assert.equal(invalid.status,400);
 assert.equal((await f.handlers(null).POST(request('POST','ai-models',body,{},SECRET))).status,403);
 assert.equal((await handlers.POST(request('POST','ai-models',{selection:{...body.selection,expectedRevision:9}}))).status,409);
});

test('long-term preferences are browser-owned, scoped and separate from learning evidence',async t=>{
  const f=await setup(t);await f.prepared();
  const snapshot=JSON.parse(readFileSync(new URL('./fixtures/long-term-plan.json',import.meta.url),'utf8')).snapshot;
  const mutation={operationId:'macro-save',expectedRevision:0,enabled:true,snapshot};
  assert.equal((await f.handlers(null).POST(request('POST','mutate-long-term-plan',{mutation},{},SECRET))).status,403);
  assert.equal((await f.handlers().POST(request('POST','mutate-long-term-plan',{mutation,expectedUserId:'user-b'}))).status,403);
  const saved=await f.handlers().POST(request('POST','mutate-long-term-plan',{mutation,libraryId:'library-a',expectedUserId:'user-a'}));
  assert.equal(saved.status,200);assert.equal((await saved.json()).state.revision,1);
  const current=await f.handlers().GET(request('GET','long-term-plan',{}, {libraryId:'library-a',expectedUserId:'user-a'}));
  assert.equal(current.status,200);assert.deepEqual((await current.json()).snapshot,snapshot);
  assert.equal((await f.handlers('user-b').GET(request('GET','long-term-plan',{}, {libraryId:'library-a'}))).status,403);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM account_study_records').get().n,0);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM account_study_plan_operations').get().n,0);
});

test('auxiliary capability, append and receipts are separately authenticated and paged',async t=>{
  const f=await setup(t);await f.prepared();const browser=f.handlers(),parent=await f.record();
  const summary=await sealAssistanceSummary({schemaVersion:1,attemptEventId:parent.event.eventId,attemptCoreHash:parent.event.coreHash,practiceMode:parent.practiceMode,observationScope:'current-page-attempt',preSubmitAssistance:[],postSubmitFeedback:[]});
  const record=await sealAccountAssistance(parent,summary),bootstrap=await(await browser.GET(request('GET','bootstrap'))).json();
  assert.ok(bootstrap.capabilities.includes('assistance-summary-v1'));
  assert.equal((await browser.POST(request('POST','append-assistance',{records:[record]}))).status,404);
  await browser.POST(request('POST','append-records',{records:[parent]}));
  const accepted=await browser.POST(request('POST','append-assistance',{records:[record]}));assert.equal(accepted.status,200);assert.equal((await accepted.json()).results[0].durable,true);
  const read=await browser.GET(request('GET','assistance'));assert.equal((await read.json()).summaries[0].record.associationHash,record.associationHash);
  const receipt={schemaVersion:1,receiptId:'aux-receipt-one',summaryId:summary.summaryId,summaryHash:summary.summaryHash,associationHash:record.associationHash,status:'received'};
  assert.equal((await browser.POST(request('POST','assistance-receipt',{receipt}))).status,403);
  assert.equal((await f.handlers(null).POST(request('POST','assistance-receipt',{receipt},{},SECRET))).status,200);
  assert.equal((await(await browser.GET(request('GET','assistance-receipts'))).json()).receipts.length,1);
  assert.equal((await browser.GET(request('GET','assistance',{}, {limit:21}))).status,400);
  assert.equal((await f.handlers('user-b').GET(request('GET','assistance',{}, {libraryId:'library-a'}))).status,403);
  assert.equal((await browser.POST(request('POST','append-assistance',{records:[record],expectedUserId:'user-b'}))).status,403);
  const foreign=request('POST','append-assistance',{records:[record]});foreign.headers.set('Origin','https://other.example.test');assert.equal((await browser.POST(foreign)).status,403);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM account_study_records').get().n,1);
});

test('a content-incompatible plugin is a permanent per-record rejection, not a server outage',async t=>{
  const {handlers,prepared,record}=await setup(t);await prepared();
  const raw={...await record(),practiceMode:'quiz'};delete raw.envelopeHash;
  const invalid=await sealStudyRecord(raw);
  const response=await handlers().POST(request('POST','append-records',{records:[invalid,await record(2)]}));
  assert.equal(response.status,200);const result=await response.json();
  assert.equal(result.results[0].error,'invalid-study-practice-mode');assert.equal(result.results[0].retryable,false);
  assert.equal(result.results[1].durable,true);
});
test('unauthenticated and disabled requests do not consume bodies or touch stores',async t=>{
  const {handlers}=await setup(t);let reads=0;
  const body=new ReadableStream({pull(controller){reads++;controller.enqueue(new TextEncoder().encode('not-json'));controller.close();}},{highWaterMark:0});
  const response=await handlers(null).POST(new Request(URL_ROOT,{method:'POST',body,duplex:'half'}));
  assert.equal(response.status,401);assert.equal(reads,0);assert.equal(response.headers.get('Cache-Control'),'no-store');
  const disabled=api.createAccountStudyHandlers({enabled:false,getBrowserUser:async()=>{throw new Error('auth should not run');},
    getAccessStore:async()=>{throw new Error('store should not run');},getStudyStore:async()=>{throw new Error('store should not run');},getReceiptStore:async()=>{throw new Error('store should not run');},getPlanStore:async()=>{throw new Error('store should not run');},getAiStore:async()=>{throw new Error('store should not run');},getContentDecisionStore:async()=>{throw new Error('store should not run');},getPlanAi:async()=>{throw new Error('ai should not run');},getQuestionAi:async()=>{throw new Error('ai should not run');}});
  assert.equal((await disabled.GET(request('GET','bootstrap'))).status,503);
});
test('browser identity registers a hash, pending device activates, then publishes bounded content',async t=>{
  const {handlers,snapshot,items}=await setup(t),browser=handlers(),device=handlers(null);
  assert.equal((await browser.POST(request('POST','register-grant',registration()))).status,200);
  const pending=await device.GET(request('GET','grant-info',{}, {},SECRET));assert.equal((await pending.json()).state,'pending');
  assert.equal((await device.POST(request('POST','begin-snapshot',{snapshot},{},SECRET))).status,403);
  assert.equal((await device.POST(request('POST','activate-grant',{}, {},SECRET))).status,200);
  assert.equal((await device.POST(request('POST','begin-snapshot',{snapshot},{},SECRET))).status,200);
  assert.equal((await device.POST(request('POST','stage-items',{snapshotId:snapshot.snapshotId,entries:[{position:0,item:items[0]}]},{},SECRET))).status,200);
  assert.equal((await device.POST(request('POST','complete-snapshot',{snapshotId:snapshot.snapshotId,expectedRevision:0},{},SECRET))).status,200);
  const result=await browser.GET(request('GET','items',{}, {snapshotId:snapshot.snapshotId}));assert.equal(result.status,200);assert.equal((await result.json()).items[0].word.meaning,'树');
  const bootstrap=await browser.GET(request('GET','bootstrap'));assert.equal((await bootstrap.json()).profile.libraryId,'library-a');
});
test('browser cannot publish source content or impersonate device write authority',async t=>{
  const {handlers,prepared,snapshot,sqlite}=await setup(t);await prepared();
  assert.equal((await handlers().POST(request('POST','begin-snapshot',{snapshot}))).status,403);
  assert.equal((await handlers().POST(request('POST','activate-grant'))).status,403);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM account_study_snapshots').get().n,1);
});
test('forged ownership and library overrides cannot select a different account or machine scope',async t=>{
  const {handlers,prepared}=await setup(t);const forged=await handlers().POST(request('POST','register-grant',{...registration(),userId:'user-b'}));assert.equal(forged.status,400);
  await prepared();assert.equal((await handlers(null).GET(request('GET','manifest',{}, {libraryId:'library-b'},SECRET))).status,403);
  assert.equal((await handlers('user-b').GET(request('GET','manifest',{}, {libraryId:'library-a'}))).status,403);
  assert.equal((await handlers('user-b').GET(request('GET','grant-info',{}, {},SECRET))).status,403);
});
test('an expected account binds reads and writes before cookie changes can access another space',async t=>{
  const {handlers,prepared,record,sqlite}=await setup(t);await prepared();
  const ok=await handlers().GET(request('GET','bootstrap',{}, {expectedUserId:'user-a'}));assert.equal(ok.status,200);
  const mismatch=await handlers().GET(request('GET','bootstrap',{}, {expectedUserId:'user-b'}));
  assert.equal(mismatch.status,403);assert.deepEqual(await mismatch.json(),{error:'account-mismatch'});
  const write=await handlers().POST(request('POST','append-records',{records:[await record()],expectedUserId:'user-b'}));
  assert.equal(write.status,403);assert.equal(sqlite.prepare('SELECT count(*) AS n FROM account_study_records').get().n,0);
  const saved=await handlers().POST(request('POST','append-records',{records:[await record()],expectedUserId:'user-a'}));assert.equal(saved.status,200);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM account_study_records').get().n,1);
  assert.equal((await handlers().POST(request('POST','append-records',{records:[],expectedUserId:null}))).status,400);
});
test('revoked device is unauthorized and cross-origin browser writes are rejected',async t=>{
  const {handlers,prepared,access}=await setup(t);await prepared();await access.revoke('user-a','grant-one');
  assert.equal((await handlers(null).GET(request('GET','grant-info',{}, {},SECRET))).status,401);
  const cross=request('POST','register-grant',registration());cross.headers.set('Origin','https://other.example.test');
  assert.equal((await handlers().POST(cross)).status,403);
});
test('bounded body parsing rejects oversized streams and never echoes malformed input',async t=>{
  const {handlers}=await setup(t);const huge=new Request(URL_ROOT,{method:'POST',headers:{'Content-Type':'application/json',Origin:ORIGIN},body:'x'.repeat(2200001)});
  assert.equal((await handlers().POST(huge)).status,413);
  const bad=new Request(URL_ROOT,{method:'POST',headers:{'Content-Type':'application/json',Origin:ORIGIN},body:'{"do-not-echo-secret":'});
  const response=await handlers().POST(bad);assert.equal(response.status,400);assert.equal((await response.text()).includes('do-not-echo-secret'),false);
});
test('record batch validates all cores before persistence and only acknowledges cloud durability',async t=>{
  const {handlers,prepared,record,sqlite}=await setup(t);await prepared();const good=await record(),bad={...await record(2),envelopeHash:'b'.repeat(64)};
  const failed=await handlers().POST(request('POST','append-records',{records:[good,bad]}));assert.equal(failed.status,400);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM account_study_records').get().n,0);
  const response=await handlers().POST(request('POST','append-records',{records:[good]}));assert.equal(response.status,200);
  const result=(await response.json()).results[0];assert.equal(result.receipt.target,'cloud');assert.equal(result.receipt.status,'acked');assert.equal(result.receipt.envelopeHash,good.envelopeHash);
  assert.equal(result.writeback,undefined);
});
test('record pages hold a stable fence while later records arrive',async t=>{
  const {handlers,prepared,record,study}=await setup(t);await prepared();const scope={userId:'user-a',libraryId:'library-a'};
  await study.appendRecord(scope,await record(1));await study.appendRecord(scope,await record(2));
  const first=await (await handlers().GET(request('GET','records',{}, {after:0,limit:1}))).json();assert.equal(first.records.length,1);
  await study.appendRecord(scope,await record(3));
  const last=await (await handlers().GET(request('GET','records',{}, {after:first.nextCursor,through:first.through,limit:1}))).json();
  assert.equal(last.records[0].record.event.eventId,'event-2');assert.equal(last.nextCursor,null);assert.equal(last.through,first.through);
  const fresh=await (await handlers().GET(request('GET','records',{}, {after:first.through,limit:1}))).json();assert.equal(fresh.records[0].record.event.eventId,'event-3');
});
test('bootstrap captures record, plan and receipt fences from one account-scoped database view',async t=>{
  const {handlers,prepared,record,study}=await setup(t);await prepared();const scope={userId:'user-a',libraryId:'library-a'};
  await study.appendRecord(scope,await record(1));const boot=await (await handlers().GET(request('GET','bootstrap'))).json();
  assert.deepEqual(boot.readFences,{records:1,operations:0,receipts:0,executions:0});
  await study.appendRecord(scope,await record(2));
  const page=await (await handlers().GET(request('GET','records',{}, {after:0,through:boot.readFences.records}))).json();
  assert.equal(page.records.length,1);assert.equal(page.through,1);
  const other=await (await handlers('user-b').GET(request('GET','bootstrap'))).json();assert.equal(other.readFences,null);
});
test('ambiguous query values, invalid cursors, excessive pages and non-JSON writes fail explicitly',async t=>{
  const {handlers,prepared}=await setup(t);await prepared();
  assert.equal((await handlers().GET(request('GET','records',{}, {after:'1.5'}))).status,400);
  assert.equal((await handlers().GET(request('GET','records',{}, {limit:21}))).status,400);
  assert.equal((await handlers().GET(new Request(`${URL_ROOT}?action=records&libraryId=library-a&libraryId=library-b`))).status,400);
  const text=request('POST','register-grant',registration());text.headers.set('Content-Type','text/plain');assert.equal((await handlers().POST(text)).status,415);
});
test('a device bootstrap cannot follow the account into a replacement library after authentication',async t=>{
  const {handlers,prepared,access,study,items}=await setup(t);await prepared();
  const nextSecret=Buffer.alloc(32,8).toString('base64url');
  await access.register('user-a',{...registration(),grantId:'grant-two',libraryId:'library-b',expectedProfileRevision:1,replaceLibrary:true,
    tokenHash:createHash('sha256').update(nextSecret).digest('hex')});
  const snapshot=await sealStudySnapshot(snapshotBody(items,{libraryId:'library-b',snapshotId:'snapshot-b'}));
  await study.putSnapshot({userId:'user-a',libraryId:'library-b'},{snapshot,items},0);
  const authenticate=access.authenticate.bind(access);let switchOnce=true;
  access.authenticate=async token=>{const principal=await authenticate(token);if(token===SECRET&&switchOnce){switchOnce=false;await access.activate(nextSecret);}return principal;};
  const response=await handlers(null).GET(request('GET','bootstrap',{}, {},SECRET));assert.equal(response.status,403);
});
test('one pending snapshot does not hide successful receipts or starve subsequent records',async t=>{
  const {handlers,prepared,record,sqlite}=await setup(t);await prepared();
  const missing={...await record(2),snapshotId:'not-published'};delete missing.envelopeHash;
  const response=await handlers().POST(request('POST','append-records',{records:[await record(1),await sealStudyRecord(missing),await record(3)]}));
  assert.equal(response.status,200);const results=(await response.json()).results;
  assert.deepEqual(results.map(result=>result.status),['accepted','blocked','accepted']);
  assert.equal(results[1].durable,false);assert.equal(results[1].retryable,true);assert.equal(results[1].receipt,undefined);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM account_study_records').get().n,2);
});
test('an oversized stream is cancelled even without a declared content length',async t=>{
  const {handlers}=await setup(t);let cancelled=false;
  const stream=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(2200001));},cancel(){cancelled=true;}},{highWaterMark:0});
  const response=await handlers().POST(new Request(URL_ROOT,{method:'POST',headers:{'Content-Type':'application/json',Origin:ORIGIN},body:stream,duplex:'half'}));
  assert.equal(response.status,413);assert.equal(cancelled,true);
});
test('deterministic ancestry errors return a per-record block without hiding other receipts',async t=>{
  const {handlers,prepared,record,sqlite}=await setup(t);await prepared();const bad={...await record(2),parentEventId:'event-2'};delete bad.envelopeHash;
  const response=await handlers().POST(request('POST','append-records',{records:[await record(1),await sealStudyRecord(bad),await record(3)]}));
  assert.equal(response.status,200);const results=(await response.json()).results;
  assert.deepEqual(results.map(result=>result.status),['accepted','blocked','accepted']);assert.equal(results[1].retryable,false);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM account_study_records').get().n,2);
});
test('an invalid uploaded content digest is a client error rather than a retryable service outage',async t=>{
  const {handlers,prepared,items,sqlite}=await setup(t);await prepared();
  const response=await handlers(null).POST(request('POST','stage-items',{snapshotId:'snapshot-a',entries:[{position:0,item:{...items[0],contentHash:'b'.repeat(64)}}]},{},SECRET));
  assert.equal(response.status,400);assert.equal(sqlite.prepare('SELECT count(*) AS n FROM account_study_item_versions').get().n,1);
});
test('future fences cannot certify empty or partially downloaded history',async t=>{
  const {handlers,prepared,record,study}=await setup(t);await prepared();const scope={userId:'user-a',libraryId:'library-a'};
  await study.appendRecord(scope,await record(1));
  assert.equal((await handlers().GET(request('GET','records',{}, {after:999999,through:999999}))).status,400);
  await study.appendRecord(scope,await record(2));
  assert.equal((await handlers().GET(request('GET','records',{}, {after:0,through:999999,limit:1}))).status,400);
});
test('a fence belonging only to another account is rejected even below this account latest sequence',async t=>{
  const {handlers,prepared,record,study,access,items,snapshot}=await setup(t);await prepared();
  const a={userId:'user-a',libraryId:'library-a'},b={userId:'user-b',libraryId:'library-a'};
  await study.appendRecord(a,await record(1));await study.appendRecord(a,await record(2));
  await access.register('user-b',{...registration(),grantId:'grant-b',tokenHash:createHash('sha256').update('another-nonproduction-secret').digest('hex')});
  await study.putSnapshot(b,{snapshot,items},0);const foreign=await study.appendRecord(b,await record(3));await study.appendRecord(a,await record(4));
  assert.equal((await handlers().GET(request('GET','records',{}, {after:0,through:foreign.sequence,limit:1}))).status,400);
});
test('only the active Companion may publish a proof-backed Obsidian receipt',async t=>{
  const {handlers,prepared,record,study,sqlite}=await setup(t);await prepared();const event=await record();await study.appendRecord({userId:'user-a',libraryId:'library-a'},event);
  const receipt={schemaVersion:1,receiptId:'receipt-one',eventId:event.event.eventId,envelopeHash:event.envelopeHash,status:'applied',
    proof:{coreHash:event.event.coreHash,proofHash:'c'.repeat(64),targetCount:2}};
  assert.equal((await handlers().POST(request('POST','writeback-receipt',{receipt}))).status,403);
  assert.equal(sqlite.prepare('SELECT count(*) AS n FROM account_study_writeback_receipts').get().n,0);
  const result=await handlers(null).POST(request('POST','writeback-receipt',{receipt},{},SECRET));assert.equal(result.status,200);
  assert.equal((await result.json()).receipt.delivery.status,'applied');
  const read=await handlers().GET(request('GET','receipts'));assert.equal((await read.json()).receipts.length,1);
  const isolated=await handlers('user-b').GET(request('GET','receipts',{}, {libraryId:'library-a'}));assert.equal(isolated.status,403);
});
test('machine receipt shape and event association errors are not service-outage retries',async t=>{
  const {handlers,prepared,record,study}=await setup(t);await prepared();const event=await record();await study.appendRecord({userId:'user-a',libraryId:'library-a'},event);
  const receipt={schemaVersion:1,receiptId:'receipt-one',eventId:event.event.eventId,envelopeHash:event.envelopeHash,status:'applied'};
  assert.equal((await handlers(null).POST(request('POST','writeback-receipt',{receipt},{},SECRET))).status,400);
  const wrong={...receipt,envelopeHash:'b'.repeat(64),proof:{coreHash:event.event.coreHash,proofHash:'c'.repeat(64),targetCount:2}};
  assert.equal((await handlers(null).POST(request('POST','writeback-receipt',{receipt:wrong},{},SECRET))).status,409);
});
test('globally unavailable cloud AI rejects new keys but still permits deleting a stored key',async t=>{const {handlers,prepared,aiStore}=await setup(t);await prepared();let response=await handlers().POST(request('POST','configure-plan-ai',{settings:{enabled:true,dailyRequestLimit:2,maxOutputTokens:300,expectedRevision:0,confirmCosts:true,providerKey:'deepseek-original-key'}}));assert.equal(response.status,200);response=await handlers('user-a',true,false).POST(request('POST','configure-plan-ai',{settings:{enabled:true,dailyRequestLimit:2,maxOutputTokens:300,expectedRevision:1,confirmCosts:true,providerKey:'deepseek-replacement-key'}}));assert.equal(response.status,503);response=await handlers('user-a',true,false).POST(request('POST','configure-plan-ai',{settings:{enabled:false,dailyRequestLimit:2,maxOutputTokens:300,expectedRevision:1,confirmCosts:false,clearProviderKey:true}}));assert.equal(response.status,200);await assert.rejects(aiStore.providerKey({userId:'user-a',libraryId:'library-a'}),/key-required/);});
test('active Companion publishes planning catalog while browser alone mutates and approves shared plan',async t=>{
  const day=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  const {handlers,prepared,snapshot,items,aiCalls,sqlite}=await setup(t);await prepared();
  const native={schemaVersion:1,sourceHash:'a'.repeat(64),diagnostics:[],subjects:[{subjectId:'vocab',name:'Words',priority:3,planningStatus:'none',
    words:[{itemKey:'word:tree',subjectId:'vocab',word:'Tree',language:'en',sourceHash:'a'.repeat(64),completionRule:'three-stage'}],units:[],goals:[]}]};
  native.subjects.push(courseSubject(1,{targetCount:1}));
  const {catalog}=await toCloudPlanningCatalog(native,{snapshot,items});
  assert.equal((await handlers().POST(request('POST','publish-planning-catalog',{catalog}))).status,403);
  assert.equal((await handlers(null).POST(request('POST','publish-planning-catalog',{catalog},{},SECRET))).status,200);
  const contentCandidate={candidateId:'candidate-api-one',kind:'modified',label:'Lesson.md',contentHash:'c'.repeat(64)},facts=await sealCloudPlanningFacts({schemaVersion:1,libraryId:'library-a',snapshotId:snapshot.snapshotId,catalogHash:catalog.catalogHash,
    observedAt:'2026-09-01T00:00:00.000Z',nativePlanRevision:0,sourceReviews:[],captureReviews:[],legacyEvents:[],legacyTaskEvents:[],contentCandidates:[contentCandidate],historyComplete:true});
  assert.equal((await handlers(null).POST(request('POST','publish-planning-facts',{facts},{},SECRET))).status,200);
  const read=await handlers().GET(request('GET','planning-catalog',{}, {snapshotId:snapshot.snapshotId}));assert.equal(read.status,200);
  const engine=await toEnginePlanningCatalog(catalog),plan=await generateTaskPlan({day,catalog:engine,
    words:[{lexemeKey:'en:tree',itemKeys:['word:tree'],status:'unseen'}],reviews:[],completions:[],previous:null});
  const cloud=await sealCloudTaskPlan(plan,catalog,{baseRevision:0,factsHash:facts.factsHash,eventThrough:0,taskThrough:0,nativeBaseRevision:0}),save={action:'save',operationId:'api-save-one',expectedRevision:0,plan:cloud};
  assert.equal((await handlers(null).POST(request('POST','mutate-plan',{mutation:save},{},SECRET))).status,403);
  let result=await handlers().POST(request('POST','mutate-plan',{mutation:save}));assert.equal(result.status,200);assert.equal((await result.json()).state.revision,1);
  result=await handlers().POST(request('POST','mutate-plan',{mutation:{action:'approve',operationId:'api-approve-one',expectedRevision:1,day,planHash:cloud.cloudPlanHash,predecessorOperationId:null}}));
  assert.equal((await result.json()).state.decision,'approved');
  const execution={schemaVersion:1,receiptId:'api-execution-one',operationId:'api-approve-one',cloudPlanHash:cloud.cloudPlanHash,status:'applied',proof:{cloudPlanHash:cloud.cloudPlanHash,nativePlanHash:'e'.repeat(64),localRevision:1,proofHash:'f'.repeat(64),targetCount:1}};
  assert.equal((await handlers().POST(request('POST','plan-execution-receipt',{receipt:execution}))).status,403);
  assert.equal((await handlers(null).POST(request('POST','claim-plan-operation',{operationId:'api-approve-one'},{},SECRET))).status,200);
  assert.equal((await handlers(null).POST(request('POST','plan-execution-receipt',{receipt:execution},{},SECRET))).status,200);
  assert.equal((await (await handlers().GET(request('GET','plan-operations'))).json()).operations.length,2);
  assert.equal((await (await handlers().GET(request('GET','plan-executions'))).json()).executions.length,1);
  const state=await handlers().GET(request('GET','plan-state',{}, {day})),body=await state.json();assert.equal(state.status,200);assert.equal(body.decision,'approved');assert.equal(body.revision,2);
  const task=cloud.tasks.find(value=>value.completionRule==='self-report'),approvedAt=sqlite.prepare("SELECT received_at FROM account_study_plan_operations WHERE operation_id='api-approve-one'").get().received_at,eventBody={schemaVersion:1,eventType:'task-completed',eventId:'task-event-api-one',taskId:task.taskId,subjectId:task.subjectId,day,occurredAt:new Date(Date.parse(`${approvedAt.replace(' ','T')}Z`)+0).toISOString(),unitIds:task.unitIds,source:'self-report',evidenceRefs:[]};
  const event={...eventBody,coreHash:await hashTaskEvent(eventBody)},taskRecord=await sealStudyRecord({schemaVersion:1,libraryId:'library-a',snapshotId:snapshot.snapshotId,originDeviceId:'device-api',provenanceMode:'task',planHash:cloud.cloudPlanHash,assignmentId:task.taskId,completionKey:`completion:${await studyHash([cloud.cloudPlanHash,task.taskId,task.unitIds,event.day])}`,event});
  let taskResult=await handlers().POST(request('POST','append-records',{records:[taskRecord]}));assert.equal((await taskResult.json()).results[0].durable,true);
  const forged={...taskRecord,planHash:'f'.repeat(64)};delete forged.envelopeHash;taskResult=await handlers().POST(request('POST','append-records',{records:[await sealStudyRecord(forged)]}));assert.equal((await taskResult.json()).results[0].durable,false);
  let ai=await handlers().POST(request('POST','configure-plan-ai',{settings:{enabled:true,dailyRequestLimit:2,maxOutputTokens:300,expectedRevision:0,confirmCosts:true,providerKey:'deepseek-test-key'}}));assert.equal(ai.status,200);
  const decision={operationId:'content-api-one',factsHash:facts.factsHash,candidateId:contentCandidate.candidateId,contentHash:contentCandidate.contentHash,decision:'approved'};assert.equal((await handlers().POST(request('POST','decide-content',{decision}))).status,200);assert.equal((await (await handlers(null).GET(request('GET','content-decisions',{}, {},SECRET))).json()).operations.length,1);const contentReceipt={schemaVersion:1,receiptId:'content-api-receipt',operationId:decision.operationId,candidateId:decision.candidateId,contentHash:decision.contentHash,decision:'approved',status:'applied',proofHash:'d'.repeat(64)};assert.equal((await handlers().POST(request('POST','content-decision-receipt',{receipt:contentReceipt}))).status,403);assert.equal((await handlers(null).POST(request('POST','content-decision-receipt',{receipt:contentReceipt},{},SECRET))).status,200);
  const questionBase={kind:'hint',snapshotId:snapshot.snapshotId,itemKey:items[0].itemKey,contentHash:items[0].contentHash,input:''},questionRequest={...questionBase,attemptId:`attempt:${await studyHash([questionBase.kind,questionBase.snapshotId,questionBase.itemKey,questionBase.contentHash,questionBase.input])}`};ai=await handlers().POST(request('POST','question-ai',{requestId:'question-request-one',request:questionRequest}));assert.equal(ai.status,200);assert.equal((await ai.json()).result.attemptId,questionRequest.attemptId);
  const aiRequest={planHash:cloud.cloudPlanHash,intent:'standard',confirmed:true,candidates:[],currentOptionalTaskIds:[]};
  const goalUnit=catalog.subjects.find(subject=>subject.subjectId==='course').units[0],invalidAiRequest={...aiRequest,candidates:[{unitId:goalUnit.unitId,subjectId:'course',label:goalUnit.planningLabel??goalUnit.title,priority:3}]};assert.equal((await handlers().POST(request('POST','recommend-plan-ai',{requestId:'ai-goal-unit',day,request:invalidAiRequest}))).status,400);
  ai=await handlers().POST(request('POST','recommend-plan-ai',{requestId:'ai-request-one',day,request:aiRequest}));assert.equal(ai.status,200);assert.equal((await ai.json()).result.message,'Deterministic set retained');
  ai=await handlers().POST(request('POST','recommend-plan-ai',{requestId:'ai-request-one',day,request:aiRequest}));assert.equal((await ai.json()).status,'duplicate');assert.equal(aiCalls.length,1);
  ai=await handlers().POST(request('POST','configure-plan-ai',{settings:{enabled:false,dailyRequestLimit:2,maxOutputTokens:300,expectedRevision:1,confirmCosts:false,clearProviderKey:true}}));assert.equal(ai.status,200);
  ai=await handlers().POST(request('POST','recommend-plan-ai',{requestId:'ai-request-one',day,request:aiRequest}));assert.equal(ai.status,200);assert.equal((await ai.json()).status,'duplicate');assert.equal(aiCalls.length,1);
});
test('account chat streams text, replays duplicate once, and binds revisions and budgets',async t=>{const {handlers,prepared,aiStore,sqlite}=await setup(t);await prepared();const scope={userId:'user-a',libraryId:'library-a'},settings={provider:'chatgpt',model:'fake-openai',enabled:true,dailyRequestLimit:3,dailyTokenLimit:6000,maxOutputTokens:500,expectedRevision:0,confirmCosts:true,providerKey:'synthetic-key-only'};await aiStore.configure(scope,settings);const body={requestId:'chat-one',provider:'chatgpt',model:'fake-openai',settingsRevision:1,context:{id:'question',title:'Question'},messages:[{role:'user',content:'Explain'}]};const response=await handlers().POST(request('POST','ai-chat',{request:body}));assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/event-stream/);const stream=await response.text();assert.match(stream,/Synthetic answer/);assert.ok(stream.includes(JSON.stringify('done')));const duplicate=await handlers().POST(request('POST','ai-chat',{request:body}));assert.equal((await duplicate.json()).status,'duplicate');assert.equal(sqlite.prepare('SELECT count(*) AS n FROM account_study_ai_requests').get().n,1);assert.equal(sqlite.prepare('SELECT provider_id FROM account_study_ai_requests').get().provider_id,'chatgpt');assert.equal((await handlers().POST(request('POST','ai-chat',{request:{...body,settingsRevision:0}}))).status,409);});
test('question IDs remain usable across model switches without replaying old answers',async t=>{const {handlers,prepared,aiStore,sqlite,snapshot,items}=await setup(t);await prepared();const scope={userId:'user-a',libraryId:'library-a'},settings={enabled:true,dailyRequestLimit:3,dailyTokenLimit:6000,maxOutputTokens:500,confirmCosts:true,providerKey:'synthetic-key-only',provider:'deepseek',model:'model-one'};await aiStore.configure(scope,{...settings,expectedRevision:0});const base={kind:'hint',snapshotId:snapshot.snapshotId,itemKey:items[0].itemKey,contentHash:items[0].contentHash,input:''},q={...base,attemptId:`attempt:${await studyHash([base.kind,base.snapshotId,base.itemKey,base.contentHash,base.input])}`};let response=await handlers().POST(request('POST','question-ai',{requestId:'reused-ui-id',request:q}));assert.equal(response.status,200);await aiStore.configure(scope,{...settings,expectedRevision:1,provider:'chatgpt',model:'model-two'});response=await handlers().POST(request('POST','question-ai',{requestId:'reused-ui-id',request:q}));assert.equal(response.status,200);assert.equal((await response.json()).status,'accepted');const rows=sqlite.prepare('SELECT model_id,provider_id FROM account_study_ai_requests').all();assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.provider_id).sort(),['chatgpt','deepseek']);});

for(const operation of ['question','plan'])test(`concurrent provider switch before ${operation} reservation cannot mislabel or cache another provider`,async t=>{
 const {handlers,prepared,aiStore,sqlite,snapshot,items}=await setup(t);await prepared();const owner={userId:'user-a',libraryId:'library-a'},base={enabled:true,dailyRequestLimit:3,dailyTokenLimit:6000,maxOutputTokens:500,confirmCosts:true,providerKey:'synthetic-key-only'};
 await aiStore.configure(owner,{...base,provider:'deepseek',model:'old-model',expectedRevision:0});const originalGet=aiStore.getSettings.bind(aiStore);let switched=false,calls=0;
 aiStore.getSettings=async scope=>{const selected=await originalGet(scope);if(!switched){switched=true;await aiStore.configure(scope,{...base,provider:'chatgpt',model:'new-model',expectedRevision:selected.revision});}return selected;};
 const load=async(scope,revision)=>{const selected=await originalGet(scope);if(selected.revision!==revision)throw new Error('ai-settings-stale');return{recommend:async()=>{calls++;return{selectedUnitIds:[],optionalOrder:[],message:'synthetic-new-provider',trace:{provider:selected.provider,modelId:selected.model},usageTokens:1};},run:async()=>{calls++;return{text:'synthetic-new-provider',trace:{provider:selected.provider,modelId:selected.model},usageTokens:1};}};};
 const h=handlers('user-a',true,true,{getPlanAi:load,getQuestionAi:load,getPlanStore:async()=>({getState:async()=>({currentPlan:{cloudPlanHash:'a'.repeat(64),catalogHash:'b'.repeat(64),tasks:[]}}),getCatalogByHash:async()=>({subjects:[]})})});
 const question={kind:'hint',snapshotId:snapshot.snapshotId,itemKey:items[0].itemKey,contentHash:items[0].contentHash,input:''};question.attemptId=`attempt:${await studyHash([question.kind,question.snapshotId,question.itemKey,question.contentHash,question.input])}`;
 const aiRequest=operation==='question'?question:{planHash:'a'.repeat(64),intent:'standard',confirmed:true,candidates:[],currentOptionalTaskIds:[]};const action=operation==='question'?'question-ai':'recommend-plan-ai',body={requestId:'race-reused-id',request:aiRequest,...(operation==='plan'?{day:'2026-09-08'}:{})};
 const response=await h.POST(request('POST',action,body));assert.equal(response.status,409);assert.equal((await response.json()).error,'ai-settings-stale');assert.equal(calls,0);assert.equal(sqlite.prepare('SELECT count(*) AS n FROM account_study_ai_requests').get().n,0);
 aiStore.getSettings=originalGet;await aiStore.configure(owner,{...base,provider:'deepseek',model:'old-model',expectedRevision:2});const resumed=await h.POST(request('POST',action,body));assert.equal(resumed.status,200);assert.equal((await resumed.json()).status,'accepted');assert.equal(calls,1);const row=sqlite.prepare('SELECT provider_id,model_id,status FROM account_study_ai_requests').get();assert.equal(row.provider_id,'deepseek');assert.equal(row.model_id,'old-model');assert.equal(row.status,'completed');
});
