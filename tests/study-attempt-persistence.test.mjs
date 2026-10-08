import assert from 'node:assert/strict';
import test from 'node:test';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {recordStudyAttempt} from '../app/study-event-controller.ts';
import {createSubmissionJournal,persistStudySubmission} from '../app/study-submission-journal.ts';
import {prepareStudySubmission,persistOriginalSubmission} from '../app/study-submission.ts';
import {listWorkspaceStudyEvents} from '../app/local-study-events.ts';
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';
import {wordBody,snapshotBody} from './fixtures/account-study-fixtures.mjs';
import {putLocalStudySnapshot,listLocalStudyRecords} from '../app/local-account-study.ts';

const input=()=>({workspaceId:'guest:local',domain:'python',item:{kind:'python',key:'m2-synthetic'},rating:'good',correct:true,stageBefore:0,stageAfter:3,reviewedAt:'2026-09-17T12:00:00.000Z',isThreeStage:false,delivery:{cloud:'not-required',companion:'not-required'},localContext:{title:'original title',activityType:'website-practice',durationMin:2,weakPoints:[]}});
test('real journal and event stores keep one immutable record after a committed write loses its reply',async()=>{
 globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
 const journal=createSubmissionJournal(),store=createLearningDraftStore('guest:local/library',{newId:()=> 'm2-once-event',now:()=> '2026-09-17T12:00:00.000Z'});
 let loseReply=true,projected=0,published=0;const accepted=[],mutable=input();
 const execute=(request,control)=>recordStudyAttempt(request.capture('record',()=>({...mutable,identity:request.identity,reviewedAt:request.identity.reviewedAt})),{
  async persistEvent(record){
   const payload=await prepareStudySubmission(record,{kind:'local',practiceMode:'code'},null,journal);
   await persistStudySubmission(payload,{journal,persistCore:persistOriginalSubmission});accepted.push(record);
   if(loseReply){loseReply=false;throw Error('reply lost after durable write');}
   control.durable({publish:()=>published++});
  },persistProgress:async()=>{projected++;},sendCloud:async()=>{throw Error('not enabled');},sendCompanion:async()=>{throw Error('not enabled');},updateDelivery:async()=>{},
 });
 const draft=store.adapter('content-a','code:1');draft.write('code','first answer');
 assert.equal((await store.submit(draft,{intent:'good',current:()=>true,execute})).status,'failed');
 assert.equal(draft.read('code',''),'first answer');assert.equal(projected,0);assert.equal(published,0);
 mutable.localContext.title='changed after the first request';mutable.currentFsrs={invalid:'must not enter retry'};
 const restored=store.adapter('content-a','code:1');
 assert.equal((await store.submit(restored,{intent:'good',current:()=>true,execute})).status,'saved');
 await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(accepted[0],accepted[1]);assert.equal(projected,1);assert.equal(published,1);
 const rows=await journal.list('guest:local'),events=await listWorkspaceStudyEvents('guest:local');
 assert.equal(rows.length,1);assert.equal(events.length,1);assert.equal(rows[0].coreStored,true);
 assert.equal(events[0].event.eventId,'m2-once-event');assert.equal(events[0].event.attempt.rating,'good');
 assert.equal(rows[0].payload.core.localContext.title,'original title');
});
test('stable identities require consistent time and accepted input cannot mutate during hashing',async()=>{
 const original=input(),records=[];
 const ports={persistEvent:async record=>records.push(record),persistProgress:async()=>{},sendCloud:async()=>{},sendCompanion:async()=>{},updateDelivery:async()=>{}};
 const identity={eventId:'m2-stable-event',reviewedAt:original.reviewedAt};
 const saving=recordStudyAttempt({...original,identity},ports);original.item.key='new-owner-item';original.localContext.title='mutated';await saving;
 assert.equal(records[0].event.item.key,'m2-synthetic');assert.equal(records[0].localContext.title,'original title');
 assert.equal(records[0].updatedAt,identity.reviewedAt);
 await assert.rejects(recordStudyAttempt({...input(),identity,reviewedAt:'2026-09-18T12:00:00.000Z'},ports),/identity-time-mismatch/);
 assert.equal(records.length,1);
});
test('account retries reuse the original portable envelope after its durable reply was lost',async()=>{
 globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
 const item=await sealStudyItem(wordBody()),bundle={items:[item],snapshot:await sealStudySnapshot(snapshotBody([item]))};
 await putLocalStudySnapshot('account:a',bundle,0);const journal=createSubmissionJournal();
 const store=createLearningDraftStore('account:a/library-a',{newId:()=> 'm2-account-once',now:()=> '2026-09-17T12:00:00.000Z'}),draft=store.adapter('word/content','three-stage:1');
 let lose=true,published=0;const payloads=[];
 const resultInput={...input(),workspaceId:'account:a',domain:'ielts',item:{kind:'word',key:item.itemKey},stageBefore:0,stageAfter:1,isThreeStage:true,delivery:{cloud:'pending',companion:'not-required'}};
 const execute=(request,control)=>recordStudyAttempt(request.capture('account-input',()=>({...resultInput,identity:request.identity,reviewedAt:request.identity.reviewedAt})),{
  async persistEvent(record){
   const payload=await prepareStudySubmission(record,{kind:'account',bundle,practiceMode:'three-stage',originDeviceId:'device-a'},null,journal);
   await persistStudySubmission(payload,{journal,persistCore:persistOriginalSubmission});payloads.push(payload);
   if(lose){lose=false;throw Error('lost portable record reply');}control.durable({publish:()=>published++});
  },persistProgress:async()=>{},sendCloud:async()=>({}),sendCompanion:async()=>{},updateDelivery:async()=>{},
 });
 assert.equal((await store.submit(draft,{intent:'good',current:()=>true,execute})).status,'failed');
 assert.equal((await store.submit(draft,{intent:'good',current:()=>true,execute})).status,'saved');
 assert.equal(published,1);assert.deepEqual(payloads[0],payloads[1]);
 assert.equal((await journal.list('account:a')).length,1);assert.equal((await listLocalStudyRecords('account:a','library-a')).length,1);assert.equal((await listWorkspaceStudyEvents('account:a')).length,1);
});
