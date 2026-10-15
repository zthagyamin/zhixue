import test from 'node:test';
import assert from 'node:assert/strict';
let waitForReadback;
try {({waitForReadback}=await import('../scripts/readback-observation.mjs'));}
catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}

test('async false receipt observations are not accepted before the durable link arrives',async()=>{
 assert.equal(typeof waitForReadback,'function');
 let reads=0;
 const result=await waitForReadback(async()=>({attemptId:'first',formal:++reads<3?null:{status:'linked'}}),
  async row=>row.formal?.status==='linked',{timeoutMs:1000,intervalMs:0});
 assert.equal(reads,3);assert.equal(result.attemptId,'first');assert.equal(result.formal.status,'linked');
});
test('an unmet receipt has a bounded failed observation rather than a successful pending row',async()=>{
 assert.equal(typeof waitForReadback,'function');let clock=0,reads=0;
 await assert.rejects(waitForReadback(async()=>{reads++;return {formal:null};},row=>row.formal?.status==='linked',
  {timeoutMs:10,intervalMs:4,now:()=>clock,sleep:async ms=>{clock+=ms;},label:'formal link'}),/formal link.*not observed/);
 assert.ok(reads>1);assert.equal(clock,10);
});
test('a read failure is preserved without repeating an uncertain operation',async()=>{
 assert.equal(typeof waitForReadback,'function');let calls=0;
 await assert.rejects(waitForReadback(async()=>{calls++;throw Error('source unavailable');},()=>true),/source unavailable/);
 assert.equal(calls,1);
});

test('a hung read fails by the deadline and its late reply cannot become a receipt',async()=>{
 let release,reads=0,accepted=0;
 await assert.rejects(waitForReadback(()=>{reads++;return new Promise(resolve=>{release=resolve;});},
  ()=>{accepted++;return true;},{timeoutMs:20,label:'hung receipt'}),/hung receipt.*not observed/);
 release({formal:{status:'linked'}});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(reads,1);assert.equal(accepted,0);
});

for(const stage of ['read','accept'])test(`a ${stage} that crosses the deadline cannot publish success before the timer runs`,async()=>{
 let clock=0;
 await assert.rejects(waitForReadback(async()=>{if(stage==='read')clock=10;return {formal:{status:'linked'}};},
  async()=>{if(stage==='accept')clock=10;return true;},{timeoutMs:5,now:()=>clock,label:stage+' deadline'}),/not observed/);
});
