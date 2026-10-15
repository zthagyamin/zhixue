import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createSourceAdmissionClient,sourceAdmissionFingerprint as hash} from '../src/infrastructure/source-admission/index.ts';
import {parseSourceCodeHintRequest,parseSourceCodeHintReceipt} from '../src/domain/source-admission/index.ts';

const f=JSON.parse(readFileSync(new URL('./fixtures/source-code-report-python-v1.json',import.meta.url),'utf8'));
const expected={submission:f.submission,sourceBinding:f.submission.binding,reportId:f.codeReportReceipt.reportId};
const request={attemptId:f.submission.attemptId,requestId:'source-hint:test',reportId:expected.reportId};
const corpus=JSON.parse(readFileSync(new URL('./fixtures/source-code-hint-v1.json',import.meta.url),'utf8'));
for(const row of corpus.requestCases)test('shared code hint request parser: '+row.name,()=>{
 if(row.valid)assert.deepEqual(parseSourceCodeHintRequest(row.input),row.input);
 else assert.throws(()=>parseSourceCodeHintRequest(row.input));
});
for(const row of corpus.receiptCases)test('shared code hint receipt parser: '+row.name,()=>{
 if(row.valid)assert.deepEqual(parseSourceCodeHintReceipt(row.input),row.input);
 else assert.throws(()=>parseSourceCodeHintReceipt(row.input));
});
async function reply(status='ready'){
 const body={schemaVersion:1,durable:true,...request,binding:structuredClone(f.submission.binding),sourceBinding:structuredClone(expected.sourceBinding),
  answerRevision:f.submission.answerRevision,answerHash:await hash(f.submission.answer),status,
  ...(status==='ready'?{hint:{text:'Inspect the constant return value.',sourceQuote:'Implement add.',codeQuote:'return 4',reason:'The public example requires addition.'}}:{reason:'hint-review-receipt-unknown'})};
 return {...body,receiptHash:await hash(body)};
}
function fixture(response,options={}){
 const calls=[];
 const client=createSourceAdmissionClient({baseUrl:'http://127.0.0.1:8765',sessionToken:'A'.repeat(43),libraryId:f.submission.binding.libraryId,
  remoteOwnerId:f.submission.binding.ownerId,capabilities:['nonword-source-v1','nonword-source-code-hint-v1'],
  fetcher:async(url,init)=>{calls.push({url,...JSON.parse(init.body)});return Response.json(typeof response==='function'?await response():response);},...options});
 return {client,calls};
}
test('code hint sends only durable identities over scoped source endpoint and validates ready or pending receipts',async()=>{
 for(const status of ['ready','pending']){
  const response=await reply(status),x=fixture(response);
  assert.equal(x.client.hintsSupported(),true);assert.deepEqual(await x.client.codeHint(request,expected),response);
  assert.deepEqual(x.calls,[{url:'http://127.0.0.1:8765/v1/nonword/source',schemaVersion:1,action:'code-hint',request}]);
 }
});
test('separate hints capability and exact request/scope must hold before any hint transport',async()=>{
 for(const capabilities of [[],['nonword-source-v1'],['nonword-source-code-hint-v1']]){
  const x=fixture(await reply(),{capabilities});assert.equal(x.client.hintsSupported(),false);
  await assert.rejects(x.client.codeHint(request,expected),/unsupported/);assert.equal(x.calls.length,0);
 }
 for(const [r,e] of [[{...request,answer:'unbound'},expected],[{...request,attemptId:'other'},expected],
  [{...request,reportId:'code-report:'+'a'.repeat(64)},expected],[request,{...expected,sourceBinding:{...expected.sourceBinding,ownerId:'other'}}]]){
  const x=fixture(await reply());await assert.rejects(x.client.codeHint(r,e));assert.equal(x.calls.length,0);
 }
});
test('hint rejects forged, extra, mismatched and complete-code responses even when rehashed',async()=>{
 const changes=[r=>{r.receiptHash='a'.repeat(64);},r=>{r.answerHash='a'.repeat(64);},r=>{r.reportId='code-report:'+'a'.repeat(64);},
  r=>{r.binding.ownerId='other';},r=>{r.sourceBinding.contentHash='a'.repeat(64);},r=>{r.requestId='other';},r=>{r.answerRevision++;},
  r=>{r.durable=false;},r=>{r.grade='good';},r=>{r.hint.text='```python\ndef add(a,b): return a+b\n```';},
  r=>{r.hint.text='Try this:\ndef add(a,b): return a+b';},r=>{r.hint.text='def add(a,b):\n    return a+b';},
  r=>{r.hint.codeQuote='return a+b';},r=>{r.hint.text='a'.repeat(301);},
  r=>{r.hint.sourceQuote='';},r=>{r.hint.reason=' padded ';},r=>{r.hint.extra='answer';}];
 for(const change of changes){
  const response=await reply();change(response);
  if(response.receiptHash!=='a'.repeat(64)){const {receiptHash,...body}=response;void receiptHash;response.receiptHash=await hash(body);}
  await assert.rejects(fixture(response).client.codeHint(request,expected),undefined,String(change));
 }
});
test('cancelled or retired hint transport cannot return late receipts and never uses alternate endpoint',async()=>{
 let release;const waiting=new Promise(resolve=>{release=resolve;});const response=await reply();
 const x=fixture(async()=>{await waiting;return response;});const controller=new AbortController();
 const pending=x.client.codeHint(request,expected,controller.signal);controller.abort();release();
 await assert.rejects(pending,/cancelled/);assert.ok(x.calls.every(row=>row.url.endsWith('/v1/nonword/source')));
 x.client.retire();await assert.rejects(x.client.codeHint(request,expected),/stale/);
});
test('receipt loss fails explicitly and replay retains original identity without alternate AI path',async()=>{
 let failed=true,calls=[];const response=await reply();
 const x=fixture(response,{fetcher:async(url,init)=>{calls.push({url,...JSON.parse(init.body)});if(failed){failed=false;throw Error('lost');}return Response.json(response);}});
 await assert.rejects(x.client.codeHint(request,expected),/receipt-unavailable/);
 assert.deepEqual(await x.client.codeHint(request,expected),response);
 assert.deepEqual(calls.map(row=>row.request),[request,request]);assert.equal(calls.every(row=>row.action==='code-hint'),true);
});
