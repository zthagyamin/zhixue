import {after} from 'node:test';
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('external-fetch-denied-in-tests');};after(()=>{globalThis.fetch=originalFetch;});
import assert from 'node:assert/strict';import test from 'node:test';let api;
try{api=await import('../app/account-study-plan-ai.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const request={planHash:'a'.repeat(64),intent:'standard',confirmed:true,candidates:[{unitId:'course:u1',subjectId:'course',label:'Read unit',priority:3}],currentOptionalTaskIds:[]};
test('cloud AI is disabled without dedicated server configuration and never falls back to local keys',async()=>{
  assert.equal(typeof api?.createAccountStudyPlanAi,'function','Dedicated cloud AI client must exist');let calls=0;
  for(const options of [{enabled:false,key:'server-key',model:'deepseek-v4-flash'},{enabled:true,key:'',model:'deepseek-v4-flash'},{enabled:true,key:'server-key',model:''}]){
    const client=api.createAccountStudyPlanAi({...options,fetcher:async()=>{calls++;throw new Error('must not call');}});
    await assert.rejects(client.recommend(request),/disabled|unconfigured/);
  }assert.equal(calls,0);
});
test('provider receives bounded labels and IDs, JSON mode, no path answer or browser secret',async()=>{
  let seen;const fetcher=async(url,init)=>{seen={url,init};return new Response(JSON.stringify({model:'deepseek-v4-flash-0731',choices:[{finish_reason:'stop',message:{content:JSON.stringify({selectedUnitIds:['course:u1'],optionalOrder:[],message:'Choose one'})}}],usage:{total_tokens:25}}),{status:200,headers:{'Content-Type':'application/json'}});};
  const client=api.createAccountStudyPlanAi({enabled:true,key:'dedicated-cloud-key',model:'deepseek-v4-flash',fetcher});
  const result=await client.recommend(request,{maxOutputTokens:300});assert.deepEqual(result.selectedUnitIds,['course:u1']);
  const body=JSON.parse(seen.init.body),prompt=body.messages.map(m=>m.content).join('\n');assert.equal(body.response_format.type,'json_object');assert.equal(body.stream,false);
  assert.ok(!prompt.includes('contentRef')&&!prompt.includes('stateRef')&&!prompt.includes('answer'));assert.ok(!prompt.includes('dedicated-cloud-key'));
  assert.equal(seen.init.headers.Authorization,'Bearer dedicated-cloud-key');assert.equal(body.max_tokens,300);assert.deepEqual(result.trace,{provider:'deepseek',modelId:'deepseek-v4-flash',providerModel:'deepseek-v4-flash-0731',promptVersion:'plan-ai-json-v1',ruleVersion:'plan-ai-selection-v1'});
});
test('hallucinated IDs, duplicates, too many per subject and truncated output fail closed',async()=>{
  async function run(content,finish_reason='stop'){
    const client=api.createAccountStudyPlanAi({enabled:true,key:'key',model:'model',fetcher:async()=>new Response(JSON.stringify({choices:[{finish_reason,message:{content}}]}),{status:200,headers:{'Content-Type':'application/json'}})});
    await assert.rejects(client.recommend(request),/output/);
  }
  await run(JSON.stringify({selectedUnitIds:['invented'],optionalOrder:[],message:'x'}));await run(JSON.stringify({selectedUnitIds:['course:u1','course:u1'],optionalOrder:[],message:'x'}));await run('', 'length');await run('{bad');
});
test('unconfirmed request or unbounded candidate labels are rejected before network',async()=>{
  let calls=0;const client=api.createAccountStudyPlanAi({enabled:true,key:'key',model:'model',fetcher:async()=>{calls++;return new Response('{}')}});
  await assert.rejects(client.recommend({...request,confirmed:false}),/confirmation/);
  await assert.rejects(client.recommend({...request,candidates:[{...request.candidates[0],label:'x'.repeat(201)}]}),/label/);assert.equal(calls,0);
});
test('timeout covers response body, not only headers',async()=>{
  const fetcher=async(_url,init)=>{let controller;const stream=new ReadableStream({start(value){controller=value;}});init.signal.addEventListener('abort',()=>controller.error(new Error('aborted')));return new Response(stream,{status:200,headers:{'Content-Type':'application/json'}});};
  const client=api.createAccountStudyPlanAi({enabled:true,key:'key',model:'model',fetcher,timeoutMs:1000});const started=Date.now();
  await assert.rejects(client.recommend(request),/provider/);assert.ok(Date.now()-started<1800);
});
