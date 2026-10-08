import test from 'node:test';
import assert from 'node:assert/strict';
import {providerRequest,listProviderModels} from '../app/ai/study-ai-provider.ts';
import {studyAIModelChoices} from '../app/ai/study-ai-models.ts';
import {decodeStudyAIStream,createStudyAIService} from '../app/ai/study-ai-service.ts';

test('provider errors identify model, authentication and quota without returning provider text',async()=>{
 for(const [status,body,expected]of [[401,{error:{message:'private-key echo'}},'ai-provider-auth'],[400,{error:{code:'model_not_found',message:'private request'}},'ai-provider-model'],[402,{},'ai-provider-balance'],[429,{},'ai-provider-rate-limit']]){
  await assert.rejects(()=>providerRequest({provider:'deepseek',key:'synthetic-key',model:'deepseek-v4-flash',fetcher:async()=>Response.json(body,{status})},{messages:[]}),error=>error.message===expected);
 }
});
test('official model display names are rejected before making any provider request',async()=>{
 await assert.rejects(()=>providerRequest({provider:'deepseek',key:'synthetic-key',model:'deepseek V4 flash',fetcher:async()=>{throw new Error('must-not-call');}},{messages:[]}),/ai-model-name/);
});
test('default DeepSeek calls disable hidden reasoning within the limited response budget',async()=>{
 let body;await providerRequest({provider:'deepseek',key:'synthetic-key',model:'deepseek-v4-flash',fetcher:async(_url,init)=>{body=JSON.parse(init.body);return new Response('{}');}},{messages:[]});assert.deepEqual(body.thinking,{type:'disabled'});
});
test('streamed diagnostics keep a safe code instead of obscuring the cause or exposing text',async()=>{
 const response=new Response('data: {"type":"error","error":"ai-provider-model","message":"private text"}\n\n',{headers:{'Content-Type':'text/event-stream'}});
 await assert.rejects(async()=>{for await(const event of decodeStudyAIStream(response,new AbortController().signal))void event;},error=>error.message==='ai-provider-model');
});
test('connection test exercises the chat stream without sending page content or creating chat history',async()=>{
 let sent;const service=createStudyAIService({request:async(action,value)=>{sent={action,value};return new Response('data: {"type":"delta","text":"OK"}\n\ndata: {"type":"done","provider":"deepseek","model":"deepseek-v4-flash"}\n\n',{headers:{'Content-Type':'text/event-stream'}});}});
 const result=await service.testConnection({provider:'deepseek',model:'deepseek-v4-flash',revision:4},new AbortController().signal);
 assert.equal(sent.action,'chat');assert.equal(sent.value.context.id,'connection-test');assert.equal(sent.value.messages.length,1);assert.equal(result.model,'deepseek-v4-flash');assert.ok(result.latencyMs>=0);assert.equal(sent.value.settingsRevision,4);
});
test('model choices keep exact IDs and ignore unsafe upstream labels or metadata',async()=>{
 const models=await listProviderModels({provider:'chatgpt',key:'synthetic-key',baseUrl:'https://api.openai.com/v1',fetcher:async(url,init)=>{assert.equal(url,'https://api.openai.com/v1/models');assert.equal(init.method,'GET');return Response.json({data:[{id:'gpt-test',secret:'never return'},{id:'gpt-test'},{id:'bad\nmodel'},{}]});}});
 assert.deepEqual(models,['gpt-test']);const options=studyAIModelChoices('deepseek','https://api.deepseek.com',[],'deepseek V4 flash');assert.ok(options.some(option=>option.id==='deepseek-v4-flash'));assert.ok(!options.some(option=>option.id==='deepseek V4 flash'));
});

test('provider adapters never follow redirect locations with credentials',async()=>{
 let calls=0;const fetcher=async(_url,init)=>{calls++;assert.equal(init.redirect,'manual');return new Response('',{status:302,headers:{Location:'https://different.example'}});};
 const options={provider:'deepseek',key:'synthetic-key',model:'deepseek-v4-flash',fetcher};
 await assert.rejects(providerRequest(options,{messages:[]}),/ai-provider-redirect/);
 await assert.rejects(listProviderModels(options),/ai-provider-redirect/);assert.equal(calls,2);
});
