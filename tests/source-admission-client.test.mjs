import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createSourceAdmissionClient, sourceAdmissionFingerprint} from '../src/infrastructure/source-admission/index.ts';
import {canonicalSourceAdmissionJson} from '../src/domain/source-admission/index.ts';
import {attemptFingerprint} from '../src/infrastructure/learning-attempt/fingerprint.ts';

const f=JSON.parse(readFileSync(new URL('./fixtures/source-admission-python-v1.json',import.meta.url),'utf8'));
const token='A'.repeat(43),libraryId=f.submission.binding.libraryId;
const expected={submission:f.submission,sourceBinding:f.confirmedCapture.sourceBinding,sourceCaptureId:f.confirmedCapture.captureId};
const original={attemptId:f.submission.attemptId,itemKey:f.submission.binding.itemKey,
  contentHash:f.submission.binding.contentHash,libraryId,answerRevision:f.submission.answerRevision,
  answer:f.submission.answer,submittedAt:f.submission.submittedAt,purpose:'first',parentAttemptId:null,
  assistance:'independent',maxPreHintLevel:0,answerRevealed:false};
function fixture(overrides={}) {
  const calls=[];
  const values={capture:f.pendingCapture,submit:f.submitReceipt,confirm:f.confirmReceipt,
    evaluate:f.evaluation,claim:f.claimReceipt,read:f.readReceipt};
  const client=createSourceAdmissionClient({baseUrl:'http://127.0.0.1:8765',sessionToken:token,
    capabilities:['nonword-source-v1'],libraryId,remoteOwnerId:f.submission.binding.ownerId,
    fetcher:async(url,init)=>{calls.push({url,init});const body=JSON.parse(init.body);return Response.json(values[body.action]);},
    ...overrides});
  return {client,calls,values};
}
const fresh=()=>({attemptId:'attempt-first',requestId:'fresh-evaluation'});
const claimRequest={attemptId:'attempt-first',eventId:'event-first'};
const claimExpected={submission:f.submission,evaluation:f.evaluation,eventKind:'due'};
const clone=value=>structuredClone(value);

test('dedicated canonical/hash matches actual Python Unicode ordering and wire numeric vectors',async()=>{
  for(const row of f.vectors) {
    assert.equal(canonicalSourceAdmissionJson(row.value),row.canonical);
    assert.equal(await sourceAdmissionFingerprint(row.value),row.fingerprint);
  }
  assert.notEqual(await attemptFingerprint(f.vectors[0].value),f.vectors[0].fingerprint);
});
test('capability absence prevents every network request',async()=>{
  const {client,calls}=fixture({capabilities:[]});
  assert.equal(client.supported(),false);
  await assert.rejects(client.capture(f.query),/unsupported/);
  await assert.rejects(client.read('attempt-first',original),/unsupported/);
  assert.equal(calls.length,0);
});
test('strict loopback URL and paired token reject alternate hosts, URL tricks and redirect credentials',async()=>{
  for(const baseUrl of ['https://127.0.0.1:8765','http://example.com:8765','http://127.1:8765',
    'http://2130706433:8765','http://user@localhost:8765','http://localhost:8765/extra',
    'http://localhost:8765?x=1','http://localhost:8765#frag']) {
    const {client,calls}=fixture({baseUrl});
    await assert.rejects(client.capture(f.query),/endpoint/);
    assert.equal(calls.length,0);
  }
  for(const sessionToken of ['', 'bare-token', 'A'.repeat(42), token+'\n']) {
    const {client,calls}=fixture({sessionToken});
    await assert.rejects(client.capture(f.query),/session/);
    assert.equal(calls.length,0);
  }
});
test('all actions use one paired POST endpoint and closed envelope without writing local grades',async()=>{
  const {client,calls}=fixture();
  const capture=await client.capture(f.query);
  assert.deepEqual(capture,f.pendingCapture);
  assert.deepEqual(await client.submit(f.submission,capture),f.submitReceipt);
  assert.deepEqual(await client.confirm({attemptId:'attempt-first',captureId:f.confirmedCapture.captureId},
    {submission:f.submission,capture:f.confirmedCapture}),f.confirmReceipt);
  assert.deepEqual(await client.evaluate(fresh(),expected),f.evaluation);
  assert.deepEqual(await client.claim(claimRequest,claimExpected),f.claimReceipt);
  assert.deepEqual(await client.read('attempt-first',original),f.readReceipt);
  assert.equal(calls.length,6);
  for(const {url,init} of calls) {
    assert.equal(url,'http://127.0.0.1:8765/v1/nonword/source');
    assert.equal(init.headers['X-Study-Loop-Session'],token);
    assert.equal(init.redirect,'error');assert.equal(init.credentials,'omit');
    assert.deepEqual(Object.keys(JSON.parse(init.body)).sort(),['action','request','schemaVersion']);
  }
});
test('capture pins authenticated remote owner and original query identity instead of local owner',async()=>{
  const {client,values}=fixture({remoteOwnerId:undefined});
  const capture=await client.capture(f.query);
  assert.equal(capture.binding.ownerId,f.submission.binding.ownerId);
  values.capture=clone(f.pendingCapture);
  values.capture.binding.ownerId=values.capture.originalBinding.ownerId='other-remote-owner';
  await assert.rejects(client.capture(f.query),/binding|owner/);
  const local=clone(f.submission);local.binding.ownerId='browser-local-namespace';
  await assert.rejects(client.submit(local,capture),/binding|owner/);
});
test('a supplied cached capture cannot pin a remote owner before an authenticated capture response',async()=>{
  const {client,calls}=fixture({remoteOwnerId:undefined});
  await assert.rejects(client.submit(f.submission,f.pendingCapture),/owner/);
  assert.equal(calls.length,0);
});
test('capture refuses query/library/owner mismatches and nondurable evidence',async()=>{
  for(const change of [r=>r.binding.libraryId=r.originalBinding.libraryId='other-library',
    r=>r.binding.itemKey=r.originalBinding.itemKey='another-item',
    r=>r.binding.contentHash=r.originalBinding.contentHash='e'.repeat(64),
    r=>r.durable=false,r=>r.route={stateRef:'caller-selected.md'}]) {
    const {client,values}=fixture();values.capture=clone(f.pendingCapture);change(values.capture);
    await assert.rejects(client.capture(f.query),/receipt|binding|fields|scope/);
  }
});
test('submission checks actual Python hash, revision, immutable time and durable save receipt',async()=>{
  for(const change of [r=>r.submissionHash='0'.repeat(64),r=>r.answerRevision++,
    r=>r.submittedAt='2026-10-10T09:01:00.000Z',r=>r.durable=false]) {
    const {client,values}=fixture();values.submit=clone(f.submitReceipt);change(values.submit);
    await assert.rejects(client.submit(f.submission,f.pendingCapture),/receipt|binding|hash/);
  }
});
test('confirmation keeps original remote binding while separately checking newly verified source capture',async()=>{
  const {client,values}=fixture();const request={attemptId:'attempt-first',captureId:f.confirmedCapture.captureId};
  values.confirm=clone(f.confirmReceipt);values.confirm.binding=f.confirmedCapture.binding;
  await assert.rejects(client.confirm(request,{submission:f.submission,capture:f.confirmedCapture}),/binding/);
});
test('pending evaluation cannot acquire score, rating, outcome or a resolved receipt',async()=>{
  const context={submission:f.submission,sourceBinding:null,sourceCaptureId:f.pendingCapture.captureId};
  const {client,values}=fixture();values.evaluate=f.pendingEvaluation;
  const receipt=await client.evaluate({attemptId:'attempt-first',requestId:'pending-request'},context);
  assert.equal(receipt.status,'pending');assert.equal(receipt.correct,undefined);
  for(const extra of [{correct:true},{rating:'easy'},{outcome:'correct'}]) {
    values.evaluate={...f.pendingEvaluation,...extra};
    await assert.rejects(client.evaluate({attemptId:'attempt-first',requestId:'pending-request'},context),/fields|receipt/);
  }
});
test('evaluation binds request, answer, revision, source capture and consistent outcome',async()=>{
  for(const change of [r=>r.requestId='old-request',r=>r.answerHash='0'.repeat(64),r=>r.answerRevision++,
    r=>r.sourceCaptureId=f.pendingCapture.captureId,r=>r.correct=false,r=>r.outcome='incorrect']) {
    const {client,values}=fixture();values.evaluate=clone(f.evaluation);change(values.evaluate);
    await assert.rejects(client.evaluate(fresh(),expected),/binding|hash|receipt|outcome/);
  }
});
test('claim binds exact saved evaluation/time/rating and unknown purpose cannot claim or self assess',async()=>{
  const unknown=clone(claimExpected);unknown.submission.purpose='unknown';
  const {client,calls}=fixture();
  await assert.rejects(client.claim(claimRequest,unknown),/purpose/);
  assert.equal(calls.length,0);
  for(const change of [r=>r.claim.correct=false,r=>r.claim.occurredAt='2026-10-10T09:01:00.000Z',
    r=>r.claim.binding.contentHash='0'.repeat(64),r=>r.claim.evaluationHash='0'.repeat(64)]) {
    const g=fixture();g.values.claim=clone(f.claimReceipt);change(g.values.claim);
    await assert.rejects(g.client.claim(claimRequest,claimExpected),/binding|hash|receipt/);
  }
});
test('unknown purpose can receive a durable save receipt without acquiring claim authority',async()=>{
  const {client,values,calls}=fixture();values.submit=f.unknownReceipt;
  assert.deepEqual(await client.submit(f.unknownSubmission,f.unknownCapture),f.unknownReceipt);
  assert.equal(calls.length,1);
  await assert.rejects(client.claim({attemptId:'attempt-unknown',eventId:'unknown'},
    {submission:f.unknownSubmission,evaluation:f.partialEvaluation,eventKind:'due'}),/purpose/);
  assert.equal(calls.length,1);
});
test('actual Python partial evaluation remains partial and defaults to a hard evidence claim',async()=>{
  const {client,values}=fixture();values.evaluate=f.partialEvaluation;values.claim=f.partialClaimReceipt;
  const context={submission:f.partialSubmission,sourceBinding:f.partialCapture.sourceBinding,sourceCaptureId:f.partialCapture.captureId};
  const evaluated=await client.evaluate({attemptId:'attempt-partial',requestId:'partial-evaluation'},context);
  assert.equal(evaluated.outcome,'partial');assert.equal(evaluated.correct,false);
  const result=await client.claim({attemptId:'attempt-partial',eventId:'event-partial'},
    {submission:f.partialSubmission,evaluation:evaluated,eventKind:'due'});
  assert.equal(result.claim.rating,'hard');
});
test('read recovery learns old capture ID only after immutable local answer/core and remote scope validation',async()=>{
  const {client}=fixture({remoteOwnerId:undefined});
  await client.capture(f.query);
  assert.deepEqual(await client.read('attempt-first',original),f.readReceipt);
  for(const change of [r=>r.answer='changed',r=>r.answerRevision++,r=>r.itemKey='other',
    r=>r.submittedAt='2026-10-10T09:01:00.000Z',r=>r.purpose='guided',r=>r.assistance='observed']) {
    const core=clone(original);change(core);
    await assert.rejects(client.read('attempt-first',core),/binding|receipt|submission/);
  }
});
test('recovery rejects a private route or a forged durable receipt',async()=>{
  const {client,values}=fixture();values.read={...clone(f.readReceipt),route:{stateRef:'hidden.md'}};
  await assert.rejects(client.read('attempt-first',original),/fields|receipt/);
  values.read=clone(f.readReceipt);values.read.receipt.submissionHash='0'.repeat(64);
  await assert.rejects(client.read('attempt-first',original),/hash|receipt/);
});
test('cancellation includes decoding when fetch ignores signal',async()=>{
  let started;const ready=new Promise(resolve=>started=resolve),controller=new AbortController();
  const {client}=fixture({fetcher:async()=>({ok:true,status:200,json:()=>{started();return new Promise(()=>{});}})});
  const pending=client.capture(f.query,controller.signal);await ready;controller.abort();
  await assert.rejects(pending,/cancel/);
});
test('timeout rejects a transport that ignores cancellation',async()=>{
  const {client}=fixture({timeoutMs:5,fetcher:async()=>new Promise(()=>{})});
  await assert.rejects(client.capture(f.query),/timeout|unavailable/);
});
test('retirement and current-context change reject decoded late receipts rather than only aborting fetch',async()=>{
  let resolveBody,started;const ready=new Promise(resolve=>started=resolve);
  const {client}=fixture({fetcher:async()=>({ok:true,status:200,json:()=>{started();return new Promise(resolve=>resolveBody=resolve);}})});
  const pending=client.capture(f.query);await ready;client.retire();resolveBody(f.pendingCapture);
  await assert.rejects(pending,/retired|cancel|stale/);
  let current=true;
  const g=fixture({isCurrent:()=>current,fetcher:async()=>({ok:true,status:200,json:async()=>{current=false;return f.pendingCapture;}})});
  await assert.rejects(g.client.capture(f.query),/stale|retired/);
});
test('a newer capture rejects the older response even when both requests finish successfully',async()=>{
  let release;let count=0;
  const {client}=fixture({fetcher:async()=>({ok:true,status:200,json:async()=>{
    if(++count===1)return new Promise(resolve=>release=resolve);
    return f.confirmedCapture;
  }})});
  const older=client.capture(f.query);
  while(!release)await new Promise(resolve=>setTimeout(resolve,0));
  const newer=await client.capture(f.query);assert.equal(newer.status,'confirmed');
  release(f.pendingCapture);await assert.rejects(older,/stale/);
});
test('an in-flight evaluation retains the original expected answer snapshot',async()=>{
  let release;
  const context=clone(expected);context.submission.answer='a different immutable answer';
  const {client}=fixture({fetcher:async()=>({ok:true,status:200,json:()=>new Promise(resolve=>release=resolve)})});
  const pending=client.evaluate(fresh(),context);
  while(!release)await new Promise(resolve=>setTimeout(resolve,0));
  context.submission.answer=f.submission.answer;
  release(f.evaluation);
  await assert.rejects(pending,/answer-hash/);
});
test('cancellation also covers asynchronous fingerprint validation after decoding',async()=>{
  let started,release;
  const ready=new Promise(resolve=>started=resolve),control=new AbortController();
  const {client}=fixture({fingerprint:async value=>{started();await new Promise(resolve=>release=resolve);return sourceAdmissionFingerprint(value);}});
  const pending=client.submit(f.submission,f.pendingCapture,control.signal);
  await ready;control.abort();release();
  await assert.rejects(pending,/cancel/);
});
test('unknown fields and noncanonical time are rejected before sending original answers',async()=>{
  for(const change of [r=>r.route={stateRef:'untrusted.md'},r=>r.submittedAt='2026-10-10T09:00:00Z']) {
    const {client,calls}=fixture();const request=clone(f.submission);change(request);
    await assert.rejects(client.submit(request,f.pendingCapture),/fields|time/);
    assert.equal(calls.length,0);
  }
});