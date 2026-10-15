import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {IDBFactory} from 'fake-indexeddb';
import {createSourceLearningSession} from '../src/application/source-admission/index.ts';
import {createSourceAdmissionClient,sourceAdmissionFingerprint,createSourceSelfAssessmentRepository} from '../src/infrastructure/source-admission/index.ts';
globalThis.indexedDB=new IDBFactory();
const fixture=JSON.parse(readFileSync(new URL('./fixtures/source-flashcard-python-v1.json',import.meta.url),'utf8'));
for(const f of fixture.cases)test('actual Python flashcard evidence preserves '+f.rating+' through paired SDK and one claim',async()=>{
 const calls=[],client=createSourceAdmissionClient({baseUrl:'http://127.0.0.1:8765',sessionToken:'A'.repeat(43),
  libraryId:f.submission.binding.libraryId,capabilities:['nonword-source-v1'],fetcher:async(_url,init)=>{
   const {action,request}=JSON.parse(init.body);calls.push({action,request});
   const response={capture:f.capture,read:f.readReceipt,'self-assess':f.selfAssessmentReceipt,
    evaluate:f.evaluation,claim:f.claimReceipt};return Response.json(response[action]);
  }});
 const attempt={attemptId:f.submission.attemptId,binding:{ownerId:'browser-namespace',libraryId:f.submission.binding.libraryId,
  snapshotId:'local',groupId:'group',roundId:'round',itemKey:f.query.itemKey,contentHash:f.query.contentHash},
  parentAttemptId:null,submitted:{answer:f.submission.answer,answerRevision:f.submission.answerRevision,
   submittedAt:f.submission.submittedAt,assistance:f.submission.assistance??'unknown',
   ...(f.submission.answerRevealed===undefined?{}:{answerRevealed:f.submission.answerRevealed}),
   ...(f.submission.maxPreHintLevel===undefined?{}:{maxPreHintLevel:f.submission.maxPreHintLevel})},checkpoint:{mode:'flashcard',purpose:'first'}};
 const source=createSourceLearningSession({query:f.query,libraryId:attempt.binding.libraryId,transport:client,
  selfAssessment:createSourceSelfAssessmentRepository({ownerId:attempt.binding.ownerId,libraryId:attempt.binding.libraryId}),
  fingerprint:sourceAdmissionFingerprint,newId:()=>assert.fail('Resolved existing evidence must reuse its request.')});
 const outcome=await source.assess(attempt,{source:'self-assess',status:f.rating==='hard'?'partial':['good','easy'].includes(f.rating)?'correct':'incorrect',rating:f.rating,explanation:'Explicit choice.'});
 assert.equal(outcome.status,'confirmed');assert.equal(outcome.outcome.rating,f.rating);assert.equal(outcome.outcome.source,'self-assess');
 attempt.evaluation={status:'resolved',outcome:outcome.outcome.status,feedback:outcome.outcome.explanation,source:'self-assess',rating:f.rating};
 attempt.formal={status:'claimed',eventId:f.claimRequest.eventId,rating:f.rating};
 await source.beforeFormal(attempt);
 assert.deepEqual(calls.find(row=>row.action==='self-assess').request,f.selfAssessmentRequest);
 assert.equal(calls.filter(row=>row.action==='claim').length,1);assert.equal(attempt.submitted.answer,'');
});

test('self-assessment SDK refuses another original submission before disclosure and altered durable receipts',async()=>{
 const f=fixture.cases[1];let calls=0,receipt=structuredClone(f.selfAssessmentReceipt);
 const client=createSourceAdmissionClient({baseUrl:'http://127.0.0.1:8765',sessionToken:'A'.repeat(43),
  remoteOwnerId:f.submission.binding.ownerId,libraryId:f.submission.binding.libraryId,capabilities:['nonword-source-v1'],
  fetcher:async()=>{calls++;return Response.json(receipt);}});
 for(const change of [row=>{row.answerRevision++;},row=>{row.binding.ownerId='other-owner';},
  row=>{row.binding.libraryId='other-library';},row=>{row.submittedAt='2026-10-10T10:00:00.000Z';}]){
  const request=structuredClone(f.selfAssessmentRequest);change(request);
  await assert.rejects(client.selfAssess(request,f.submission),/binding/);
 }
 assert.equal(calls,0);
 await client.selfAssess(f.selfAssessmentRequest,f.submission);
 receipt.selfAssessment.rating='good';receipt.selfAssessmentHash=await sourceAdmissionFingerprint(receipt.selfAssessment);
 await assert.rejects(client.selfAssess(f.selfAssessmentRequest,f.submission),/binding/);
 const unsupported=createSourceAdmissionClient({baseUrl:'http://127.0.0.1:8765',sessionToken:'A'.repeat(43),
  libraryId:f.submission.binding.libraryId,capabilities:[],fetcher:async()=>assert.fail('Unsupported self-assessment cannot disclose data.')});
 await assert.rejects(unsupported.selfAssess(f.selfAssessmentRequest,f.submission),/unsupported/);
});
