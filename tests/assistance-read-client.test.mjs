import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {assistanceView} from './fixtures/assistance-read.mjs';
import {createAssistanceReadCache} from '../app/assistance-read-cache.ts';
import {createSubmissionJournal} from '../app/study-submission-journal.ts';
import {withStudyEventCoreHash} from '../app/study-event-v3.ts';
import {sealStudyRecord} from '../app/account-study-record.ts';
import {sealAssistanceSummary} from '../app/assistance-summary.ts';
import {sealAccountAssistance} from '../app/assistance-record.ts';
let api;try{api=await import('../app/assistance-read-client.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const scope={workspaceId:'account:a',libraryId:'library-a'},tick=()=>new Promise(done=>setImmediate(done));
async function fixture(){assert.equal(typeof api?.createAssistanceReadClient,'function');globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
  const view=await assistanceView(),requests=[],cache=createAssistanceReadCache(),f={view,requests,cache,missing:false,supported:true};
  f.fetcher=async(url,init)=>{const q=new URL(url,'http://localhost').searchParams,action=q.get('action');requests.push({q,init});assert.equal(q.get('expectedUserId'),'a');
    if(action==='bootstrap')return Response.json({apiVersion:1,enabled:true,profile:{libraryId:'library-a'},capabilities:f.supported?['assistance-summary-v1']:[],assistanceFences:{summaries:f.view.summaryThrough,receipts:f.view.receiptThrough}});
    assert.equal(q.get('libraryId'),'library-a');assert.equal(q.get('limit'),'20');const summary=action==='assistance',after=Number(q.get('after')),through=Number(q.get('through'));
    const rows=(summary?f.view.summaries.map(({parent,...row})=>{void parent;return row;}):f.view.receipts).filter(row=>row.sequence>after&&row.sequence<=through),page=rows.slice(0,20);
    return Response.json({[summary?'summaries':'receipts']:f.missing?[]:page,through,nextCursor:rows.length>20?page.at(-1).sequence:null});
  };
  f.client=()=>api.createAssistanceReadClient({...scope,fetcher:f.fetcher,cache});f.parents=()=>f.view.summaries.map(row=>row.parent);return f;
}
test('complete auxiliary read persists its own checkpoints and unchanged reads download no rows',async()=>{
  const f=await fixture(),client=f.client();assert.equal(await client.cached(),null);const first=await client.load(f.parents());assert.deepEqual(first.view,f.view);
  assert.deepEqual((await f.cache.read(scope)).view,f.view);f.requests.length=0;assert.deepEqual((await f.client().load(f.parents())).view,f.view);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].q.get('action'),'bootstrap');
});
test('missing pages or unverified parents keep the previous complete auxiliary view',async()=>{
  const f=await fixture(),client=f.client();await client.load(f.parents());f.view={...f.view,summaryThrough:4};f.missing=true;
  await assert.rejects(client.load(f.parents()),/incomplete/);assert.equal((await client.cached()).summaryThrough,3);
  const g=await fixture();await assert.rejects(g.client().load([]),/parent-missing/);assert.equal(await g.client().cached(),null);
});
test('old service capability retains prior auxiliary history and cannot claim an empty replacement',async()=>{
  const f=await fixture(),client=f.client();await client.load(f.parents());f.supported=false;
  const next=await client.load(f.parents());assert.equal(next.supported,false);assert.equal(next.view.summaryThrough,3);
});
test('same-owner/library reads are coalesced and cancellation of one consumer does not cancel the other',async()=>{
  const f=await fixture(),a=new AbortController(),one=f.client().load(f.parents(),{signal:a.signal}),two=f.client().load(f.parents());a.abort();
  await assert.rejects(one,{name:'AbortError'});assert.equal((await two).view.summaryThrough,3);assert.equal(f.requests.filter(r=>r.q.get('action')==='bootstrap').length,1);
});
test('a cancelled final consumer never publishes a late response checkpoint',async()=>{
  const f=await fixture(),original=f.fetcher,entered={};let finish;const pending=new Promise(resolve=>finish=resolve);let started;const start=new Promise(resolve=>started=resolve);
  f.fetcher=async(url,init)=>{if(new URL(url,'http://localhost').searchParams.get('action')==='assistance'){entered.yes=true;started();await pending;}return original(url,init);};
  const controller=new AbortController(),reading=f.client().load(f.parents(),{signal:controller.signal});await start;controller.abort();await assert.rejects(reading,{name:'AbortError'});finish();await tick();await tick();assert.equal(entered.yes,true);assert.equal((await f.cache.read(scope)).view,null);
});
test('cross-device auxiliary receipts reconcile only the exact local submission without touching core delivery',async()=>{
  const f=await fixture(),row=f.view.summaries[0],p=row.parent,event=p.event,journal=createSubmissionJournal();
  await journal.put({schemaVersion:1,workspaceId:scope.workspaceId,eventId:event.eventId,core:{workspaceId:scope.workspaceId,eventId:event.eventId,event,cloud:'pending',companion:'not-required',occurredAt:event.occurredAt,updatedAt:event.occurredAt},route:{kind:'account',record:p},summary:row.record.summary});
  const receipt={schemaVersion:1,receiptId:'readback',summaryId:row.record.summary.summaryId,summaryHash:row.record.summary.summaryHash,associationHash:row.record.associationHash,status:'applied',proof:{attemptCoreHash:event.coreHash,proofHash:'c'.repeat(64),targetCount:2}};
  f.view={...f.view,receiptThrough:2,receipts:[{sequence:2,receipt,writerGrantId:'writer',receivedAt:'2026-09-01T00:02:00.000Z'}]};const loaded=await f.client().load(f.parents());await api.reconcileAssistanceJournal(loaded.view,journal);
  const saved=await journal.get(scope.workspaceId,event.eventId);assert.equal(saved.cloudAck.sequence,3);assert.equal(saved.writeback.receipt.status,'applied');assert.equal(saved.coreStored,false);assert.equal(saved.payload.core.cloud,'pending');
});
test('auxiliary histories larger than one page keep the 20-row ceiling and exact immutable fence',async()=>{
  const f=await fixture(),seed=f.view.summaries[0],summaries=[];
  const {envelopeHash,...parentBody}=seed.parent;void envelopeHash;const {summaryId,summaryHash,...summaryBody}=seed.record.summary;void summaryId;void summaryHash;
  for(let i=0;i<26;i++){
    const event=await withStudyEventCoreHash({...seed.parent.event,eventId:`paged-${i}`}),parent=await sealStudyRecord({...parentBody,event,roundId:`round-${i}`,attemptId:`attempt-${i}`});
    const summary=await sealAssistanceSummary({...summaryBody,attemptEventId:event.eventId,attemptCoreHash:event.coreHash});summaries.push({sequence:i*2+1,parent,record:await sealAccountAssistance(parent,summary),receivedAt:seed.receivedAt});
  }
  f.view={...f.view,summaryThrough:51,summaries};const result=await f.client().load(f.parents());assert.equal(result.view.summaries.length,26);
  const pages=f.requests.filter(r=>r.q.get('action')==='assistance');assert.deepEqual(pages.map(r=>Number(r.q.get('after'))),[0,39]);assert.ok(pages.every(r=>r.q.get('through')==='51'&&r.q.get('limit')==='20'));
});
test('a later receipt-only update downloads no old summary and retains independent cursors',async()=>{
  const f=await fixture(),client=f.client();await client.load(f.parents());f.requests.length=0;const record=f.view.summaries[0].record;
  f.view={...f.view,receiptThrough:7,receipts:[{sequence:7,writerGrantId:'writer',receivedAt:'2026-09-01T00:02:00.000Z',receipt:{schemaVersion:1,receiptId:'received-new',summaryId:record.summary.summaryId,summaryHash:record.summary.summaryHash,associationHash:record.associationHash,status:'received'}}]};
  const next=await client.load(f.parents());assert.equal(next.view.summaryThrough,3);assert.equal(next.view.receiptThrough,7);assert.equal(f.requests.filter(r=>r.q.get('action')==='assistance').length,0);assert.equal(next.view.receipts[0].receipt.status,'received');
});
