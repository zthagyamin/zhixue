import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeMathClient} from '../src/infrastructure/math-study/native-client.ts';
import {parseNativeMathCapture,nativeMathClaimHash,validateNativeMathReceipt} from '../src/domain/math-study/index.ts';
import {studyHash} from '../src/domain/sync/index.ts';
import {spawnSync} from 'node:child_process';
import {fixture} from './fixtures/native-math-fixtures.mjs';

const python=process.env.PYTHON||'python';
export const options={baseUrl:'http://127.0.0.1:5195',sessionToken:'isolated-session',capabilities:['native-math-v1']};
test('exact public capture hash matches Python canonical hash, without portable source substitution',async()=>{
 const f=await fixture();f.item.practice.prompt='算出 2+2';f.item.practice.sourceLabel='来源数学题';
 const {captureId:previous,...body}=f.capture;assert.ok(previous);f.capture.captureId=await studyHash(body);const captureId=f.capture.captureId;
 const py=spawnSync(python,['-X','utf8','-c','import sys;sys.path.insert(0,"companion");from account_sync_schema import study_hash;import json;print(study_hash(json.load(sys.stdin)))'],{input:JSON.stringify(body),encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(py.status,0,`${py.error?.code??''} ${py.error?.message??''}\n${py.stderr??''}`);assert.equal(py.stdout.trim(),captureId);
 assert.deepEqual(await parseNativeMathCapture(f.capture),f.capture);
 assert.notEqual(await studyHash(f.item),f.identity.contentHash);
 await assert.rejects(parseNativeMathCapture({...f.capture,item:{...f.item,title:'unapproved'}}));
 const pyClaim=spawnSync(python,['-X','utf8','-c','import sys;sys.path.insert(0,"companion");from account_sync_schema import study_hash;from native_math_schema import logical_claim;import json;print(study_hash(logical_claim(json.load(sys.stdin))))'],{input:JSON.stringify({...f.claim,captureId}),encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(pyClaim.status,0,`${pyClaim.error?.code??''} ${pyClaim.error?.message??''}\n${pyClaim.stderr??''}`);assert.equal(pyClaim.stdout.trim(),await nativeMathClaimHash({...f.claim,captureId}));
});
test('paired transport validates exact source/claim/results and sends no client reference',async()=>{
 const f=await fixture(),calls=[];
 const client=createNativeMathClient({...options,fetcher:async(url,init)=>{
  const body=JSON.parse(init.body);calls.push({url,init,body});
  const data=url.endsWith('/claim')?{schemaVersion:1,durable:true,attemptId:f.attempt.attemptId,answerRevision:1,captureId:f.capture.captureId,claimHash:await nativeMathClaimHash(f.claim)}:{schemaVersion:1,durable:true,capture:f.capture};
  return {ok:true,status:200,json:async()=>data};
 }});
 assert.deepEqual(await client.capture(f.identity),f.capture);await client.claim(f.claim);
 assert.equal(calls[0].init.headers['X-Study-Loop-Session'],options.sessionToken);
 assert.equal(calls[0].init.redirect,'error');assert.equal(calls[0].body.identity.libraryId,f.identity.libraryId);
 assert.equal(calls[1].body.attempt.submitted.answer,'4');
});
test('old capability and credential target violations stop before transport',async()=>{
 const f=await fixture();let calls=0;
 for(const patch of [{capabilities:[]},{baseUrl:'https://other.example'},{baseUrl:options.baseUrl+'/path'},{baseUrl:'http://u:p@127.0.0.1:5195'},{baseUrl:options.baseUrl+'?token=x'}]){
  const client=createNativeMathClient({...options,...patch,fetcher:async()=>{calls++;throw Error('unexpected');}});
  await assert.rejects(client.capture(f.identity));
 }assert.equal(calls,0);
});
test('cancelled signal-blind response is rejected, including late body and initial abort',async()=>{
 const f=await fixture(),controller=new AbortController();let finish,entered;
 const ready=new Promise(resolve=>{entered=resolve;});
 const client=createNativeMathClient({...options,fetcher:async()=>({ok:true,status:200,json:()=>{entered();return new Promise(resolve=>{finish=resolve;});}})});
 const work=client.capture(f.identity,controller.signal);await ready;controller.abort();await assert.rejects(work,/cancelled/);finish({schemaVersion:1,durable:true,capture:f.capture});
 await assert.rejects(client.capture(f.identity,controller.signal),/cancelled/);
});
test('receipt digest alone cannot authorize wrong identity, revision, step or mode',async()=>{
 const f=await fixture(),request={schemaVersion:1,requestId:'request',attemptId:f.attempt.attemptId,answerRevision:1,sourceVersion:f.identity.contentHash,mode:'step',stepRevision:1};
 const step={answerRevision:1,stepRevision:1,stepId:'intermediate',sourceVersion:f.identity.contentHash,status:'correct',source:'deterministic',explanation:'checked'};
 const body={schemaVersion:1,durable:true,requestId:'request',attemptId:f.attempt.attemptId,answerRevision:1,sourceVersion:f.identity.contentHash,step};
 const signed=async value=>({...value,receiptHash:await studyHash(value)});
 assert.ok((await validateNativeMathReceipt(await signed(body),request,f.claim,f.capture)).step);
 for(const patch of [{attemptId:'wrong'},{answerRevision:2},{step:{...step,stepId:'wrong'}},{final:{status:'correct',source:'deterministic',explanation:'wrong mode'}}])await assert.rejects(validateNativeMathReceipt(await signed({...body,...patch}),request,f.claim,f.capture));
});
test('bounded timeout cancels a signal-blind transport and rejects late returned identity',async()=>{
 const f=await fixture();let release;
 const client=createNativeMathClient({...options,timeoutMs:10,fetcher:()=>new Promise(resolve=>{release=resolve;})});
 await assert.rejects(client.capture(f.identity),/receipt-unavailable/);release({ok:true,status:200,json:async()=>({schemaVersion:1,durable:true,capture:f.capture})});
 const wrong={...f.identity,localBindingHash:'d'.repeat(64)},bad=createNativeMathClient({...options,fetcher:async()=>({ok:true,status:200,json:async()=>({schemaVersion:1,durable:true,capture:f.capture})})});
 await assert.rejects(bad.capture(wrong),/receipt-binding/);
});
