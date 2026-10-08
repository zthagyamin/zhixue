import test from 'node:test';
import assert from 'node:assert/strict';
import {createPracticeAssistanceAi} from '../src/infrastructure/math-study/index.ts';
import {createAccountProviderServices} from '../src/infrastructure/account-study/index.ts';
const trace={requestId:'req',modelId:'mock',promptVersion:'practice-assistance-v1',ruleVersion:'source-bound-assistance-v1'};
const signal=()=>new AbortController().signal;
test('practice assistance uses configured provider, bound trace and bounded nonstream budget',async()=>{
 let seen;const ai=createPracticeAssistanceAi({enabled:true,key:'synthetic-key',model:'mock',provider:'chatgpt',baseUrl:'https://api.openai.com/v1',fetcher:async(url,init)=>{seen={url,init,body:JSON.parse(init.body)};return Response.json({choices:[{finish_reason:'stop',message:{content:'{"text":"hint"}'}}],usage:{total_tokens:10}});}});
 const r=await ai.run('code-hint',{code:'saved input'},trace,{maxOutputTokens:300},signal());assert.deepEqual(r.trace,trace);assert.equal(r.usageTokens,10);assert.equal(seen.body.max_completion_tokens,300);assert.equal(seen.body.stream,false);assert.equal(seen.body.model,'mock');assert.equal(seen.body.thinking,undefined);assert.match(seen.body.messages[0].content,/No full solution/);
});
test('practice provider rejects disabled, stale credential revision, truncated completion and over-limit reply',async()=>{
 let calls=0;const disabled=createPracticeAssistanceAi({enabled:false,key:'key',model:'mock',fetcher:async()=>{calls++;return Response.json({});}});await assert.rejects(disabled.run('math-step',{},trace,{maxOutputTokens:300},signal()),/disabled/);assert.equal(calls,0);
 const services=createAccountProviderServices({store:()=>({getSettings:async()=>({revision:2}),providerKey:async()=>{calls++;return 'key';}}),configuration:()=>({enabled:true,configured:true,defaultModel:'mock'})});await assert.rejects(services.getPracticeAi({userId:'u',libraryId:'l'},1),/stale/);assert.equal(calls,0);
 for(const payload of [{choices:[{finish_reason:'length',message:{content:'{}'}}]},'x'.repeat(70000)]){
  const ai=createPracticeAssistanceAi({enabled:true,key:'key',model:'mock',fetcher:async()=>typeof payload==='string'?new Response(payload):Response.json(payload)});await assert.rejects(ai.run('math-step',{},trace,{maxOutputTokens:300},signal()),/output/);
 }
});
test('practice provider stops reading a response that never ends when timed out',async()=>{
 const caller=new AbortController();let stream,boundedSignal,cancelled=false,cancelCount=0,readStarted,cancelObserved,watchdogTimer;
 const reading=new Promise(resolve=>{readStarted=resolve;}),cancellation=new Promise(resolve=>{cancelObserved=resolve;});
 const ai=createPracticeAssistanceAi({enabled:true,key:'key',model:'mock',timeoutMs:1000,fetcher:async(_url,init)=>{
  boundedSignal=init.signal;
  // With no prefetch, this gate opens only when the provider reader requests a chunk.
  stream=new ReadableStream({pull(){readStarted();},cancel(){cancelled=true;cancelCount++;cancelObserved();}},{highWaterMark:0});
  return new Response(stream);
 }});
 // AbortSignal.timeout is unreferenced in Node. A mocked stream has no socket to keep
 // Node 22 alive; this test-owned failure deadline supplies that lifecycle, not a sleep.
 const watchdog=new Promise((_,reject)=>{watchdogTimer=setTimeout(()=>reject(Error('practice-provider-timeout-watchdog')),5000);});
 const run=ai.run('math-step',{},trace,{maxOutputTokens:300},caller.signal);
 try{
  await Promise.race([(async()=>{
   await Promise.race([reading,run]);assert.equal(stream.locked,true);assert.equal(boundedSignal.aborted,false);
   await assert.rejects(run,error=>error.name==='TimeoutError'&&error===boundedSignal.reason);
   await cancellation;
   assert.equal(boundedSignal.aborted,true);assert.equal(caller.signal.aborted,false);
   assert.equal(cancelled,true);assert.equal(cancelCount,1);assert.equal(stream.locked,false);
  })(),watchdog]);
 }finally{clearTimeout(watchdogTimer);caller.abort();}
});
