import test from 'node:test';
import assert from 'node:assert/strict';
import {providerRequest,listProviderModels} from '../app/ai/study-ai-provider.ts';
import {createAccountProviderServices} from '../src/infrastructure/account-study/index.ts';
import {createAccountStudyHandlers} from '../app/account-study-api.ts';
import {AccountStudyAiStore} from '../db/account-study-ai-store.ts';
import {openD1} from './helpers/sqlite-d1.mjs';
import {parseCloudAIAllowedOrigins} from '../src/domain/ai/index.ts';

const proxy='https://proxy.example';
const settings={enabled:true,dailyRequestLimit:3,maxOutputTokens:300,confirmCosts:true,provider:'chatgpt',model:'synthetic-model',providerKey:'synthetic-only-key'};
const denied=[
 'https://10.0.0.1/v1','https://172.16.0.1/v1','https://192.168.1.1/v1',
 'https://169.254.169.254/v1','https://100.64.0.1/v1','https://0.0.0.0/v1',
 'https://[fd00::1]/v1','https://[fe80::1]/v1','https://[::]/v1',
 'https://[::ffff:10.0.0.1]/v1','https://localhost./v1','https://internal/v1',
 'https://api.openai.com.evil.example/v1','https://api.openai.com./v1',
 'https://api.openai.com:8443/v1','https://unregistered.example/v1',
];

test('deployment JSON accepts bounded canonical origins and rejects malformed registry',()=>{
 assert.deepEqual(parseCloudAIAllowedOrigins(undefined),[]);
 assert.deepEqual(parseCloudAIAllowedOrigins(''),[]);
 assert.deepEqual(parseCloudAIAllowedOrigins('["https://PROXY.example:443/"]'),[proxy]);
 for(const raw of ['*','null','{}','[null]','[123]','["https://proxy.example/v1"]',JSON.stringify(Array(33).fill(proxy))])assert.throws(()=>parseCloudAIAllowedOrigins(raw),/cloud-ai-destination-config/);
});

test('cloud transport rejects unregistered destinations before GET or POST',async()=>{
 for(const baseUrl of denied){
  let calls=0;const options={provider:'chatgpt',key:'synthetic-only-key',model:'synthetic-model',baseUrl,fetcher:async()=>{calls++;return Response.json({data:[{id:'synthetic-model'}]});}};
  await assert.rejects(providerRequest(options,{messages:[]}),/cloud-ai-destination/);
  await assert.rejects(listProviderModels(options),/cloud-ai-destination/);
  assert.equal(calls,0,baseUrl);
 }
});

test('official defaults and explicitly registered public proxy retain canonical targets',async()=>{
 for(const [provider,baseUrl,allowedOrigins,expected] of [
  ['chatgpt',undefined,[], 'https://api.openai.com/v1'],
  ['deepseek',undefined,[], 'https://api.deepseek.com'],
  ['chatgpt','https://PROXY.example:443/v1/',[proxy],`${proxy}/v1`],
 ]){
  const calls=[];const options={provider,key:'synthetic-only-key',model:'synthetic-model',baseUrl,allowedOrigins,fetcher:async(url,init)=>{calls.push([url,init.method,init.redirect,init.headers.Authorization]);return Response.json({data:[{id:'synthetic-model'}]});}};
  await providerRequest(options,{messages:[]});assert.deepEqual(await listProviderModels(options),['synthetic-model']);
  assert.deepEqual(calls,[[`${expected}/chat/completions`,'POST','manual','Bearer synthetic-only-key'],[`${expected}/models`,'GET','manual','Bearer synthetic-only-key']]);
 }
});

test('invalid maintainer registration fails closed even for an official target',async()=>{
 for(const entry of ['*','https://*.example','https://127.0.0.1','https://10.0.0.1','https://[fd00::1]','https://localhost','https://proxy.local','https://proxy.internal','https://home.arpa','https://proxy.example:8443','https://proxy.example/v1','http://proxy.example','https://proxy.example?x=y']){
  let called=false;
  await assert.rejects(listProviderModels({provider:'chatgpt',key:'synthetic-key',allowedOrigins:[entry],fetcher:async()=>{called=true;return Response.json({data:[{id:'model'}]});}}),/cloud-ai-destination-config/);
  assert.equal(called,false,entry);
 }
});

test('registration does not remove URL syntax and redirect protection',async()=>{
 for(const baseUrl of [`${proxy}/v1?token=never`,`${proxy}/#x`,'https://key@proxy.example/v1','http://proxy.example/v1']){
  await assert.rejects(listProviderModels({key:'synthetic-key',baseUrl,allowedOrigins:[proxy],fetcher:async()=>assert.fail('forbidden fetch')}),/base-url/);
 }
 let calls=0;const options={key:'synthetic-key',model:'synthetic-model',baseUrl:`${proxy}/v1`,allowedOrigins:[proxy],fetcher:async(_url,init)=>{calls++;assert.equal(init.redirect,'manual');return new Response('',{status:302,headers:{Location:'https://169.254.169.254'}});}};
 await assert.rejects(providerRequest(options,{}),/ai-provider-redirect/);
 await assert.rejects(listProviderModels(options),/ai-provider-redirect/);
 assert.equal(calls,2);
});

async function fixture(t,allowedOrigins=[]){
 const {sqlite,binding}=await openD1();t.after(()=>sqlite.close());
 const scope={userId:'synthetic-user',libraryId:'synthetic-library'};
 await binding.prepare('INSERT INTO learning_accounts(user_id) VALUES (?)').bind(scope.userId).run();
 await binding.prepare('INSERT INTO account_study_libraries(user_id,library_id) VALUES (?,?)').bind(scope.userId,scope.libraryId).run();
 const store=new AccountStudyAiStore(binding,Buffer.alloc(32,7).toString('base64url'),allowedOrigins);
 const calls=[],services=createAccountProviderServices({store:()=>store,configuration:()=>({enabled:true,configured:true,defaultModel:'synthetic-model',allowedOrigins}),fetcher:async(url,init)=>{
  calls.push([url,init.method]);
  return init.method==='POST'?new Response('data: {"choices":[{"delta":{"content":"synthetic answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'):Response.json({data:[{id:'synthetic-model'}]});
 }});
 const handlers=createAccountStudyHandlers({enabled:true,getBrowserUser:async()=>({userId:scope.userId}),getAccessStore:async()=>({profile:async()=>({libraryId:scope.libraryId,revision:0})}),getAiStore:async()=>store,...services});
 const post=body=>handlers.POST(new Request('https://study.example/api/account-study',{method:'POST',headers:{Origin:'https://study.example','Content-Type':'application/json'},body:JSON.stringify(body)}));
 return{store,binding,scope,calls,post,services};
}

test('actual account HTTP rejects arbitrary model-list URLs even with fresh keys',async t=>{
 const f=await fixture(t);const response=await f.post({action:'ai-models',selection:{provider:'chatgpt',baseUrl:'https://10.0.0.1/v1',providerKey:'synthetic-only-key',expectedRevision:0}});
 assert.equal(response.status,400);assert.deepEqual(await response.json(),{error:'cloud-ai-destination'});assert.deepEqual(f.calls,[]);
 const injected=await f.post({action:'ai-models',selection:{provider:'chatgpt',baseUrl:'https://10.0.0.1/v1',providerKey:'synthetic-only-key',expectedRevision:0,allowedOrigins:['https://10.0.0.1']}});
 assert.equal(injected.status,400);assert.deepEqual(f.calls,[]);
});

test('configuration rejects forbidden destinations without changing settings',async t=>{
 const f=await fixture(t);const response=await f.post({action:'configure-plan-ai',settings:{...settings,baseUrl:'https://10.0.0.1/v1',expectedRevision:0}});
 assert.equal(response.status,400);assert.equal((await response.json()).error,'cloud-ai-destination');
 assert.equal((await f.store.getSettings(f.scope)).revision,0);assert.equal((await f.store.getSettings(f.scope)).configured,false);
});

test('malformed deployment registry blocks new work but preserves read/disable/key clearing',async t=>{
 let malformed=false;
 const f=await fixture(t,()=>parseCloudAIAllowedOrigins(malformed?'["https://10.0.0.1"]':'[]'));
 await f.store.configure(f.scope,{...settings,expectedRevision:0});
 malformed=true;
 assert.equal(f.services.planAiAvailable(),true);
 assert.equal((await f.store.getSettings(f.scope)).revision,1);
 await assert.rejects(f.services.getChatAi(f.scope,1),/cloud-ai-destination-config/);
 const disabled=await f.post({action:'configure-plan-ai',settings:{...settings,enabled:false,confirmCosts:false,providerKey:undefined,clearProviderKey:true,expectedRevision:1}});
 assert.equal(disabled.status,200);assert.equal((await disabled.json()).settings.configured,false);
 const enabled=await f.post({action:'configure-plan-ai',settings:{...settings,expectedRevision:2}});
 assert.equal(enabled.status,502);assert.equal((await enabled.json()).error,'cloud-ai-destination-config');assert.deepEqual(f.calls,[]);
});

test('registered account proxy works for settings, stored credentials and fresh list credentials',async t=>{
 const f=await fixture(t,[proxy]);const response=await f.post({action:'configure-plan-ai',settings:{...settings,baseUrl:`${proxy}/v1`,expectedRevision:0}});
 assert.equal(response.status,200);assert.equal((await response.json()).status,'accepted');
 for(const providerKey of [undefined,'synthetic-fresh-key']){
  const result=await f.post({action:'ai-models',selection:{provider:'chatgpt',baseUrl:`${proxy}/v1`,expectedRevision:1,...(providerKey?{providerKey}:{})}});
  assert.equal(result.status,200);assert.deepEqual((await result.json()).models,['synthetic-model']);
 }
 assert.deepEqual(f.calls,[[`${proxy}/v1/models`,'GET'],[`${proxy}/v1/models`,'GET']]);
 const chat=await f.post({action:'ai-chat',request:{requestId:'registered-chat',provider:'chatgpt',model:'synthetic-model',settingsRevision:1,context:{id:'synthetic-context',title:'Synthetic question'},messages:[{role:'user',content:'Synthetic request'}]}});
 assert.equal(chat.status,200);assert.match(await chat.text(),/"type":"done"/);
 assert.deepEqual(f.calls.at(-1),[`${proxy}/v1/chat/completions`,'POST']);
 assert.equal((await f.binding.prepare('SELECT status FROM account_study_ai_requests WHERE request_id=?').bind('registered-chat').first()).status,'completed');
});

test('old unregistered configuration stays readable and disable/clear remain possible',async t=>{
 const f=await fixture(t);await f.store.configure(f.scope,{...settings,expectedRevision:0});
 const hash='a'.repeat(64),trace={operationKind:'chat',modelId:'synthetic-model',promptVersion:'synthetic-v1',ruleVersion:'synthetic-v1'};
 await f.store.begin(f.scope,{requestId:'completed-before-change',day:'2026-10-12',inputHash:hash,trace});
 await f.store.complete(f.scope,'completed-before-change',hash,{text:'preserved'},10);
 const row=await f.binding.prepare('SELECT provider_configs FROM account_study_ai_settings').first();const configs=JSON.parse(row.provider_configs);configs.chatgpt.baseUrl='https://10.0.0.1/v1';
 await f.binding.prepare('UPDATE account_study_ai_settings SET provider_configs=?').bind(JSON.stringify(configs)).run();
 assert.equal((await f.store.getSettings(f.scope)).baseUrl,'https://10.0.0.1/v1');
 for(const method of ['getChatAi','getPlanAi','getQuestionAi','getCourseAi','getPracticeAi','getPaperReadingProvider'])await assert.rejects(f.services[method](f.scope,1),/cloud-ai-destination/);
 const chat=await f.post({action:'ai-chat',request:{requestId:'blocked-chat',provider:'chatgpt',model:'synthetic-model',settingsRevision:1,context:{id:'synthetic-context',title:'Synthetic question'},messages:[{role:'user',content:'Synthetic request'}]}});
 assert.equal(chat.status,400);assert.equal((await chat.json()).error,'cloud-ai-destination');
 await assert.rejects(f.store.begin(f.scope,{requestId:'new-blocked',day:'2026-10-12',inputHash:'b'.repeat(64),trace}),/cloud-ai-destination/);
 assert.equal((await f.store.begin(f.scope,{requestId:'completed-before-change',day:'2026-10-12',inputHash:hash,trace})).status,'completed');
 assert.equal(await f.binding.prepare('SELECT count(*) AS n FROM account_study_ai_requests').first('n'),1);
 const disabled=await f.store.configure(f.scope,{...settings,baseUrl:'https://10.0.0.1/v1',providerKey:undefined,enabled:false,confirmCosts:false,clearProviderKey:true,expectedRevision:1});
 assert.equal(disabled.status,'accepted');assert.equal(disabled.settings.baseUrl,'https://10.0.0.1/v1');assert.equal(disabled.settings.configured,false);assert.deepEqual(f.calls,[]);
});
