import test from 'node:test';
import assert from 'node:assert/strict';
import {createAccountProviderServices} from '../src/infrastructure/account-study/index.ts';
function fixture(){
 const calls=[],scope={userId:'synthetic',libraryId:'library'},settings={revision:3,enabled:true,provider:'deepseek',model:'synthetic-chat',baseUrl:'https://model.example/v1',providers:{deepseek:{baseUrl:'https://model.example/v1'},chatgpt:{baseUrl:'https://alternate.example/v1'}}};
 const store={getSettings:async owner=>{calls.push(['settings',owner]);return settings;},providerKey:async(...args)=>{calls.push(['key',...args]);return'synthetic-only-key';}};
 const services=createAccountProviderServices({store:()=>store,configuration:()=>({enabled:true,configured:true,defaultModel:'default-synthetic'}),fetcher:async(url,request)=>{calls.push(['fetch',url,request.headers.Authorization]);return Response.json({data:[{id:'synthetic-chat'}]});}});
 return{calls,scope,settings,services,selection:{provider:'deepseek',baseUrl:settings.baseUrl,expectedRevision:3}};
}
test('provider construction rejects a stale revision before reading a credential',async()=>{
 const f=fixture();for(const key of ['getPlanAi','getQuestionAi','getChatAi'])await assert.rejects(f.services[key](f.scope,2),/ai-settings-stale/);
 assert.equal(f.calls.some(row=>row[0]==='key'||row[0]==='fetch'),false);
});
test('model listing cannot send an existing credential to a different endpoint',async()=>{
 const f=fixture();await assert.rejects(f.services.getAiModels(f.scope,{...f.selection,baseUrl:'https://different.example/v1'}),/ai-model-list-key-required/);
 assert.equal(f.calls.some(row=>row[0]==='key'||row[0]==='fetch'),false);
});
test('model listing with a supplied credential does not read a stored key',async()=>{
 const f=fixture();assert.deepEqual(await f.services.getAiModels(f.scope,{...f.selection,baseUrl:'https://different.example/v1',providerKey:'synthetic-new-key'}),['synthetic-chat']);
 assert.equal(f.calls.some(row=>row[0]==='key'),false);assert.deepEqual(f.calls.find(row=>row[0]==='fetch'),['fetch','https://different.example/v1/models','Bearer synthetic-new-key']);
});
test('model listing binds stored credentials to owner, provider and settings revision',async()=>{
 const f=fixture();await f.services.getAiModels(f.scope,f.selection);
 assert.deepEqual(f.calls.find(row=>row[0]==='key'),['key',f.scope,3,'deepseek']);
 await assert.rejects(f.services.getAiModels(f.scope,{...f.selection,expectedRevision:2}),/ai-settings-stale/);
 assert.equal(f.calls.filter(row=>row[0]==='fetch').length,1);
});
