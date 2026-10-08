import test from 'node:test';
import assert from 'node:assert/strict';
import {accountFixture,auth} from './math-account-fixtures.mjs';
test('explicit code hint reads original source/current saved run and saves trusted evidence without formal grade',async()=>{
 const f=accountFixture('code'),r=(await f.send(f.hint)).value;assert.equal(r.status,'accepted');assert.equal(r.hint.source,'model');assert.equal(r.evidence.execution.hint.runId,1);assert.equal(f.a.evaluation.status,'pending');
 assert.equal((await f.send(f.hint)).value.status,'duplicate');assert.equal(f.calls,1);assert.equal(f.writes,1);
});
test('code hint rejects forged expected case/source/run and untrusted input fields',async()=>{
 const f=accountFixture('code');await assert.rejects(f.send({...f.hint,expected:'4'}));await assert.rejects(f.send({...f.hint,request:{...f.hint.request,runId:2}}));
 f.evidence.execution.latest.firstFailure.expected=8;await assert.rejects(f.send(f.hint),/source/);assert.equal(f.calls,0);
});
test('code hint unavailable model preserves pending evidence and prepared receipt survives save failure',async()=>{
 const f=accountFixture('code');f.receiptLoss=true;await assert.rejects(f.send(f.hint));assert.equal(f.writes,0);
 assert.equal((await f.send(f.hint)).value.status,'accepted');assert.equal(f.calls,1);
 const invalid=accountFixture('code');invalid.model=async(k,i,trace)=>({output:{text:'```def twice(x): return 2*x```',sourceQuote:'Return twice',codeQuote:'x + 1',reason:'solution'},trace});
 assert.equal((await invalid.send(invalid.hint)).value.status,'pending');assert.equal(invalid.writes,0);
});
test('code hint does not save after cancellation or newer current run',async()=>{
 const f=accountFixture('code'),controller=new AbortController();f.model=async(k,i,trace)=>{controller.abort();return {output:{},trace};};
 await assert.rejects(f.app.post(structuredClone(f.hint),auth,controller.signal),/cancelled/);assert.equal(f.writes,0);
 const changed=accountFixture('code'),model=changed.model;changed.model=async(...args)=>{const out=await model(...args);changed.evidence.execution.latest.runId=2;return out;};await assert.rejects(changed.send(changed.hint),/binding/);assert.equal(changed.writes,0);
});
