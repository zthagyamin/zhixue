import {after} from 'node:test';
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('external-fetch-denied-in-tests');};after(()=>{globalThis.fetch=originalFetch;});
import test from 'node:test';
import assert from 'node:assert/strict';
import {providerRequest,decodeProviderStream,providerEndpoint} from '../app/ai/study-ai-provider.ts';
test('provider-specific bodies and safe endpoints',async()=>{
 for(const provider of ['chatgpt','deepseek']){let sent;await providerRequest({provider,key:'synthetic-key',model:'chosen-model',fetcher:async(url,init)=>{sent={url,...init};return new Response('{}');}},{messages:[{role:'user',content:'hi'}],max_tokens:100,thinking:{type:'disabled'}});const body=JSON.parse(sent.body);assert.equal(body.model,'chosen-model');assert.equal(sent.redirect,'manual');assert.equal(Boolean(body.thinking),provider==='deepseek');assert.equal(body.max_completion_tokens,provider==='chatgpt'?100:undefined);}
 for(const baseUrl of ['https://secret@host/v1','http://localhost:11434/v1','https://host/v1?q=key','https://host/#x'])assert.throws(()=>providerEndpoint({provider:'chatgpt',baseUrl}),/base-url/);
 assert.equal(providerEndpoint({provider:'chatgpt',baseUrl:'https://proxy.example/v1/'}),'https://proxy.example/v1/chat/completions');
});
test('SSE decoder handles every split UTF8 boundary and ignores hidden reasoning',async()=>{
 const bytes=new TextEncoder().encode('data: {"model":"actual","choices":[{"delta":{"reasoning_content":"secret","content":"你好"}}]}\r\n\r\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
 for(let split=1;split<bytes.length;split++){const stream=new ReadableStream({start(c){c.enqueue(bytes.slice(0,split));c.enqueue(bytes.slice(split));c.close();}});let events=[];for await(const event of decodeProviderStream(stream))events.push(event);assert.equal(events.filter(e=>e.type==='delta').map(e=>e.text).join(''),'你好');assert.equal(events.at(-1).type,'done');assert.doesNotMatch(JSON.stringify(events),/secret/);}
});
test('incomplete, provider error, and aborted streams reject',async()=>{for(const data of ['data: {"error":{"message":"raw secret"}}\n\n','data: {"choices":[]}\n\n']){await assert.rejects(async()=>{for await(const e of decodeProviderStream(new Response(data).body))void e;},/provider/);}const c=new AbortController();c.abort();await assert.rejects(async()=>{for await(const e of decodeProviderStream(new Response('').body,c.signal))void e;},/abort/i);});
