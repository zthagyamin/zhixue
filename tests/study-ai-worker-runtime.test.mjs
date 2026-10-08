import test from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';
import {Miniflare,Response} from 'miniflare';

test('actual Worker runtime sends provider requests and rejects redirect responses',async()=>{
 const expected=[['/models','GET',200,JSON.stringify({data:[{id:'test-model'}]})],['/chat/completions','POST',200,'{}'],['/models','GET',302,''],['/chat/completions','POST',307,'']];
 let requests=0;
 const entry='virtual:provider-worker',source=`import {listProviderModels,providerRequest} from ${JSON.stringify(fileURLToPath(new URL('../app/ai/study-ai-provider.ts',import.meta.url)).replaceAll('\\','/'))};
 export default {async fetch(){const options={provider:'deepseek',baseUrl:'https://provider.example',key:'synthetic-key',model:'test-model'};const results=[];for(const operation of [()=>listProviderModels(options),()=>providerRequest(options,{messages:[]}),()=>listProviderModels(options),()=>providerRequest(options,{messages:[]})]){try{const value=await operation();results.push(value instanceof Response?value.status:value);}catch(error){results.push(error.message);}}return Response.json(results);}};`;
 // Bundle the actual compatibility entry and its current dependency graph.
 // Concatenating old files could drop implementation after an extraction.
 const bundle=await build({configFile:false,logLevel:'silent',build:{write:false,minify:false,target:'es2022',rolldownOptions:{input:entry,preserveEntrySignatures:'strict',output:{format:'es'}}},plugins:[{name:'provider-worker-fixture',resolveId:id=>id===entry?id:undefined,load:id=>id===entry?source:undefined}]});
 const script=bundle.output.find(chunk=>chunk.type==='chunk'&&chunk.isEntry).code;
 // Miniflare 5 removed fetchMock. A deny-by-default outbound service preserves
 // the real workerd execution and prevents every unlisted external request.
 const mf=new Miniflare({cf:false,workers:[{
  config:{type:'worker',name:'security-provider-fixture',compatibilityDate:'2026-05-22',manifest:{mainModule:'index.mjs',modules:{'index.mjs':{type:'esm',contents:script}}}},
  dev:{unsafeRegisterWorker:false,outboundService:{type:'fetcher',handler(request){
   const entry=expected[requests++];assert.ok(entry,'unexpected outbound request');
   assert.equal(request.url,'https://provider.example'+entry[0]);assert.equal(request.method,entry[1]);
   assert.equal(request.headers.get('Authorization'),'Bearer synthetic-key');
   return new Response(entry[3],{status:entry[2],headers:{'Content-Type':'application/json'}});
  }}},
 }]});
 try{const response=await mf.dispatchFetch('http://local.test'),body=await response.text();assert.equal(response.status,200,body);assert.deepEqual(JSON.parse(body),[['test-model'],200,'ai-provider-redirect','ai-provider-redirect']);assert.equal(requests,expected.length);}finally{await mf.dispose();}
});
