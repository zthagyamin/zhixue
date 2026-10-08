import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';
import {wordBody,snapshotBody} from './fixtures/account-study-fixtures.mjs';
import {attempt} from './fixtures/task-event-fixtures.mjs';
import {putLocalStudySnapshot,getLocalStudyRecord} from '../app/local-account-study.ts';
import {getLocalStudyEvent} from '../app/local-study-events.ts';
import {updateStudyEventDelivery} from '../app/local-study-events.ts';
import {createSubmissionJournal,persistStudySubmission,submissionAssociationHash} from '../app/study-submission-journal.ts';
import {prepareStudySubmission,persistOriginalSubmission} from '../app/study-submission.ts';
let api;try{api=await import('../app/study-submission-transport.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
async function fixture(kind='account',enhanced=false){
  assert.equal(typeof api?.createSubmissionTransport,'function');globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
  const workspaceId='account:owner',journal=createSubmissionJournal(),item=await sealStudyItem(wordBody()),bundle={items:[item],snapshot:await sealStudySnapshot(snapshotBody([item]))};
  await putLocalStudySnapshot(workspaceId,bundle,0);const event=await attempt('event-one','2026-09-01T00:01:00Z',0,1);
  const core={workspaceId,eventId:event.eventId,event,cloud:kind==='account'?'pending':'not-required',companion:kind==='local'?'pending':'not-required',occurredAt:event.occurredAt,updatedAt:event.occurredAt,localContext:{title:'Synthetic',activityType:'practice',durationMin:2,weakPoints:[],sourceNote:'private/local-note.md'}};
  const frame=kind==='account'?{kind,bundle,originDeviceId:'device',practiceMode:'three-stage'}:{kind,practiceMode:enhanced?'recall':'three-stage',contentHash:item.contentHash,localBindingHash:'b'.repeat(64)};
  const payload=await prepareStudySubmission(core,frame,{observationScope:'current-page-attempt',preSubmitAssistance:[],postSubmitFeedback:[],...(enhanced?{recallPolicy:{policyVersion:'recall-hints-v1',attemptId:'recall-transport',maxPreHintLevel:0,requestedRating:event.attempt.rating,appliedRating:event.attempt.rating}}:{})},journal);
  await persistStudySubmission(payload,{journal,persistCore:persistOriginalSubmission});return {workspaceId,journal,payload,requests:[],current:true};
}
const json=value=>Response.json(value);
function coreAck(p){return{schemaVersion:1,libraryId:p.route.record.libraryId,eventId:p.eventId,envelopeHash:p.route.record.envelopeHash,target:'cloud',status:'acked',revision:1};}
async function summaryAck(p){return{status:'accepted',durable:true,sequence:2,summaryId:p.summary.summaryId,summaryHash:p.summary.summaryHash,associationHash:await submissionAssociationHash(p)};}
function transport(f,reply){return api.createSubmissionTransport({workspaceId:f.workspaceId,journal:f.journal,isCurrent:()=>f.current,companion:{url:'http://127.0.0.1:43225',sessionToken:'synthetic',capabilities:['assistance-summary-v1']},fetcher:async(url,init)=>{const body=init?.body?JSON.parse(init.body):null;f.requests.push({url,init,body});return reply(url,body);}});}
test('account dispatch uses the frozen owner/library/envelope and an independent summary acknowledgement',async()=>{
  const f=await fixture(),p=f.payload,t=transport(f,async(url,body)=>body?.action==='append-records'?json({results:[{eventId:p.eventId,durable:true,receipt:coreAck(p)}]}):body?.action==='append-assistance'?json({results:[await summaryAck(p)]}):json({enabled:true,apiVersion:1,profile:{libraryId:'library-a'},capabilities:['assistance-summary-v1']}));
  assert.equal(await t.summary(p),'parent-pending');assert.equal(f.requests.length,0);
  assert.deepEqual(await t.core(p,'cloud'),{accepted:[p.eventId]});assert.equal((await getLocalStudyRecord(f.workspaceId,'library-a',p.eventId)).writeback,'pending');
  assert.equal(await t.summary(p),'account-received');const row=await f.journal.get(f.workspaceId,p.eventId);assert.equal(row.cloudAck.sequence,2);assert.equal(row.writeback,null);
  const sent=f.requests.filter(r=>r.body);assert.equal(sent.length,2);assert.ok(sent.every(r=>r.body.expectedUserId==='owner'&&r.body.libraryId==='library-a'));
  assert.equal(JSON.stringify(sent).includes('private/local-note.md'),false);assert.deepEqual(sent[0].body.records,[p.route.record]);
});
test('failed or mismatched summary receipt cannot undo a saved core or acknowledge the summary',async()=>{
  const f=await fixture(),p=f.payload,t=transport(f,(url,body)=>body?.action==='append-records'?json({results:[{eventId:p.eventId,durable:true,receipt:coreAck(p)}]}):body?.action==='append-assistance'?json({results:[{status:'accepted',durable:true,sequence:3,summaryId:p.summary.summaryId,summaryHash:'f'.repeat(64),associationHash:'e'.repeat(64)}]}):json({enabled:true,apiVersion:1,profile:{libraryId:'library-a'},capabilities:['assistance-summary-v1']}));
  await t.core(p,'cloud');await assert.rejects(t.summary(p),/binding/);
  assert.equal((await getLocalStudyRecord(f.workspaceId,'library-a',p.eventId)).cloud,'acked');assert.equal((await f.journal.get(f.workspaceId,p.eventId)).cloudAck,null);
});
test('old cloud capability leaves auxiliary pending without blocking the original record',async()=>{
  const f=await fixture(),p=f.payload,t=transport(f,(url,body)=>body?json({results:[{eventId:p.eventId,durable:true,receipt:coreAck(p)}]}):json({enabled:true,apiVersion:1,profile:{libraryId:'library-a'},capabilities:[]}));
  await t.core(p,'cloud');assert.equal(await t.summary(p),'unsupported');assert.equal(f.requests.filter(r=>r.body?.action==='append-assistance').length,0);
});
test('native sidecar stays outside V3 and a received auxiliary receipt is never displayed as applied',async()=>{
  const f=await fixture('local'),p=f.payload,associationHash=await submissionAssociationHash(p);
  const receipt={schemaVersion:1,receiptId:'received-one',summaryId:p.summary.summaryId,summaryHash:p.summary.summaryHash,associationHash,status:'received'};
  const t=transport(f,url=>String(url).endsWith('/activity')?json({status:'accepted',companionReceipt:{durable:true,projectionStatus:'applied'}}):json({status:'accepted',durable:true,summaryId:p.summary.summaryId,summaryHash:p.summary.summaryHash,associationHash,receipt:{sequence:1,receipt}}));
  await t.core(p,'companion');assert.equal((await getLocalStudyEvent(f.workspaceId,p.eventId)).companion,'acked');assert.equal(await t.summary(p),'received');
  assert.deepEqual(f.requests[0].body.attemptBinding,p.route.binding);assert.equal(f.requests[0].body.event.attemptBinding,undefined);assert.equal((await f.journal.get(f.workspaceId,p.eventId)).writeback.receipt.status,'received');
});
test('a missing native binding stays unknown rather than being reconstructed after an upgrade',async()=>{
  const f=await fixture('local');f.payload.route.binding=null;const t=transport(f,()=>{throw new Error('unexpected-network');});
  assert.equal(await t.summary(f.payload),'binding-unknown');assert.equal(f.requests.length,0);
});
test('a native core with pending projection does not unlock auxiliary delivery',async()=>{
  const f=await fixture('local'),t=transport(f,()=>json({status:'accepted',projectionStatus:'pending',companionReceipt:{durable:true}}));
  await t.core(f.payload,'companion');assert.equal(await t.summary(f.payload),'parent-pending');assert.equal((await getLocalStudyEvent(f.workspaceId,f.payload.eventId)).companion,'pending');
});
test('a native structured 409 marks only the matching core conflicted and stops retrying it',async()=>{
  const f=await fixture('local'),p=f.payload,t=transport(f,()=>Response.json({status:'conflict',eventId:p.eventId},{status:409}));
  assert.equal((await t.core(p,'companion')).status,'conflict');assert.equal((await getLocalStudyEvent(f.workspaceId,p.eventId)).companion,'conflict');
  await t.drain();assert.equal(f.requests.length,1);assert.equal((await f.journal.get(f.workspaceId,p.eventId)).writeback,null);
});
test('an unrelated or malformed 409 cannot mark the submitted core conflicted',async()=>{
  const f=await fixture('local'),t=transport(f,()=>Response.json({status:'conflict',eventId:'another-event'},{status:409}));
  await assert.rejects(t.core(f.payload,'companion'));assert.equal((await getLocalStudyEvent(f.workspaceId,f.payload.eventId)).companion,'pending');
});
test('a changed owner prevents every new request while retaining the prior owner submission',async()=>{
  const f=await fixture(),t=transport(f,()=>{throw new Error('unexpected-network');});f.current=false;
  await assert.rejects(t.core(f.payload,'cloud'),/workspace-changed/);await assert.rejects(t.summary(f.payload),/workspace-changed/);assert.equal(f.requests.length,0);assert.ok(await f.journal.get(f.workspaceId,f.payload.eventId));
});
test('native-mode cloud delivery uses a fail-closed owner-bound action and no local provenance',async()=>{
  const f=await fixture('local');f.payload.core.cloud='pending';const t=transport(f,()=>json({accepted:[f.payload.eventId]}));
  await t.core(f.payload,'cloud');assert.equal(f.requests[0].body.action,'study-events-v3-bound');assert.equal(f.requests[0].body.expectedUserId,'owner');assert.equal(f.requests[0].body.localContext,undefined);
});
test('a fresh transport resumes summary-only failure without resending an acknowledged core',async()=>{
  const f=await fixture(),p=f.payload;let failSummary=true;
  const reply=async(url,body)=>{
    if(body?.action==='append-records')return json({results:[{eventId:p.eventId,durable:true,receipt:coreAck(p)}]});
    if(body?.action==='append-assistance'){if(failSummary)throw new Error('offline');return json({results:[await summaryAck(p)]});}
    return json({enabled:true,apiVersion:1,profile:{libraryId:'library-a'},capabilities:['assistance-summary-v1']});
  };
  const first=await transport(f,reply).drain();assert.equal(first.failed,1);assert.equal((await getLocalStudyRecord(f.workspaceId,'library-a',p.eventId)).cloud,'acked');
  failSummary=false;const second=await transport(f,reply).drain();assert.equal(second.failed,0);assert.equal(f.requests.filter(r=>r.body?.action==='append-records').length,1);assert.equal((await f.journal.get(f.workspaceId,p.eventId)).cloudAck.sequence,2);
});
test('account recovery and delivery do not depend on an unavailable legacy V3 mirror database',async()=>{
  const f=await fixture(),p=f.payload,open=indexedDB.open;
  indexedDB.open=function(name,...args){if(name==='zhixue-local-study-v1')throw new DOMException('Mirror blocked','SecurityError');return open.call(this,name,...args);};
  const t=transport(f,async(url,body)=>body?.action==='append-records'?json({results:[{eventId:p.eventId,durable:true,receipt:coreAck(p)}]}):body?.action==='append-assistance'?json({results:[await summaryAck(p)]}):json({enabled:true,apiVersion:1,profile:{libraryId:'library-a'},capabilities:['assistance-summary-v1']}));
  try{const result=await t.drain();assert.equal(result.failed,0);assert.equal((await getLocalStudyRecord(f.workspaceId,'library-a',p.eventId)).cloud,'acked');assert.equal((await f.journal.get(f.workspaceId,p.eventId)).cloudAck.sequence,2);}
  finally{indexedDB.open=open;}
});
test('a known conflict receipt cannot be retried as ordinary account delivery',async()=>{
  const f=await fixture(),t=transport(f,()=>{throw new Error('must not send');});await updateStudyEventDelivery(f.workspaceId,f.payload.eventId,'cloud','conflict');
  await assert.rejects(t.core(f.payload,'cloud'),/mirror-conflict/);assert.equal(f.requests.length,0);
});

test('an acknowledged account parent with a later mirror conflict cannot dispatch its summary directly or on restart',async()=>{
  const f=await fixture(),p=f.payload,t=transport(f,()=>json({results:[{eventId:p.eventId,durable:true,receipt:coreAck(p)}]}));
  await t.core(p,'cloud');await updateStudyEventDelivery(f.workspaceId,p.eventId,'cloud','conflict');f.requests.length=0;
  await assert.rejects(t.summary(p),/mirror-conflict/);
  assert.equal((await t.drain()).failed,1);assert.equal(f.requests.length,0);assert.equal((await f.journal.get(f.workspaceId,p.eventId)).cloudAck,null);
});

test('version two recall summary waits for a compatible Companion while retaining the core',async()=>{
 const f=await fixture('local',true),t=transport(f,()=>{throw new Error('old reader must not receive v2');});
 assert.equal(f.payload.summary.schemaVersion,2);
 assert.equal(await t.summary(f.payload),'unsupported');
 assert.equal(f.requests.length,0);assert.equal((await f.journal.get(f.workspaceId,f.payload.eventId)).coreStored,true);
});