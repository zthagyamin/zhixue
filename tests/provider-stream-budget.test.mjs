import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeProviderStream,MAX_PROVIDER_STREAM_BYTES} from '../src/infrastructure/ai/provider.ts';
import {readFileSync} from 'node:fs';
import {createStudyAIChat} from '../src/infrastructure/ai/chat.ts';

async function consume(chunks){
 let cancelled=false;
 const stream=new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(chunk);},
  cancel(){cancelled=true;}});
 const events=[];
 try{for await(const event of decodeProviderStream(stream))events.push(event);return events;}
 finally{assert.equal(cancelled,true);}
}
const encoded=value=>new TextEncoder().encode(value);
const fixture=JSON.parse(readFileSync(new URL('./fixtures/provider-stream-budget-v1.json',import.meta.url),'utf8'));
test('shared versioned response byte budget matches production',()=>assert.equal(MAX_PROVIDER_STREAM_BYTES,fixture.maxResponseBytes));
for(const row of fixture.cases)test('shared stream case: '+row.name,async()=>{
 const frame=encoded(row.kind==='comment'?':'+'x'.repeat(row.size)+'\n\n':
  'data: '+JSON.stringify({choices:[{delta:row.kind==='hidden'?{reasoning_content:'x'.repeat(row.size)}:{content:row.text}}]})+'\n\n');
 const chunks=[...Array(row.repeat).fill(frame),encoded('data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')];
 if(row.reject)await assert.rejects(consume(chunks),/cloud-ai-provider-stream-limit/);
 else assert.deepEqual((await consume(chunks))[0],{type:'delta',text:row.text});
});
test('hidden reasoning consumes total stream bytes even though it is never displayed',async()=>{
 const frame=encoded('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'x'.repeat(240000)}}]})+'\n\n');
 await assert.rejects(consume([...Array(36).fill(frame),encoded('data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')]),
  /cloud-ai-provider-stream-limit/);
});
test('ignored comment blocks also consume total stream bytes',async()=>{
 const frame=encoded(':'+'x'.repeat(240000)+'\n\n');
 await assert.rejects(consume([...Array(36).fill(frame),encoded('data: {"choices":[{"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')]),
  /cloud-ai-provider-stream-limit/);
});
test('normal UTF8 split across transport chunks preserves content and completion',async()=>{
 const raw=encoded('data: '+JSON.stringify({choices:[{delta:{content:'你好，world。'}}]})+'\n\n'+
   'data: {"choices":[{"finish_reason":"stop"}],"usage":{"total_tokens":12}}\n\ndata: [DONE]\n\n');
 const events=await consume([raw.slice(0,50),raw.slice(50,53),raw.slice(53)]);
 assert.deepEqual(events,[{type:'delta',text:'你好，world。'},{type:'done',model:undefined,usageTokens:12}]);
});

test('actual chat reports invalid stream and releases its reader before upstream cancellation acknowledges',async()=>{
 let entered,acknowledge,watchdog,cancelCount=0;
 const cancellationStarted=new Promise(resolve=>{entered=resolve;});
 const acknowledgment=new Promise(resolve=>{acknowledge=resolve;});
 const stream=new ReadableStream({start(controller){controller.enqueue(encoded('data: {invalid}\n\n'));},
  cancel(){cancelCount++;entered();return acknowledgment;}});
 const ai=createStudyAIChat({key:'synthetic-key',model:'synthetic-model',baseUrl:'https://fixture.example/v1',allowedOrigins:['https://fixture.example'],
  fetcher:async()=>new Response(stream)});
 const run=ai.stream({context:{},messages:[]},100,new AbortController().signal).next();
 void run.catch(()=>{});
 try{
  await cancellationStarted;
  await assert.rejects(Promise.race([run,new Promise((_,reject)=>{
   watchdog=setTimeout(()=>reject(Error('cancellation-acknowledgment-retained-chat')),500);
  })]),/cloud-ai-provider-stream-invalid/);
  assert.equal(cancelCount,1);assert.equal(stream.locked,false);
 }finally{clearTimeout(watchdog);acknowledge();await run.catch(()=>{});}
});

test('stopping actual chat preserves its partial delta and releases the stream before cancellation acknowledgment',async()=>{
 let entered,acknowledge,watchdog,cancelCount=0;
 const started=new Promise(resolve=>{entered=resolve;});
 const acknowledgment=new Promise(resolve=>{acknowledge=resolve;});
 const stream=new ReadableStream({start(controller){controller.enqueue(encoded('data: {"choices":[{"delta":{"content":"已有输出"}}]}\n\n'));},
  cancel(){cancelCount++;entered();return acknowledgment;}});
 const chat=createStudyAIChat({key:'synthetic-key',model:'synthetic-model',baseUrl:'https://fixture.example/v1',allowedOrigins:['https://fixture.example'],fetcher:async()=>new Response(stream)});
 const iterator=chat.stream({context:{},messages:[]},100,new AbortController().signal);
 assert.deepEqual(await iterator.next(),{done:false,value:{type:'delta',text:'已有输出'}});
 const stopped=iterator.return();void stopped.catch(()=>{});
 try{
  await started;
  assert.deepEqual(await Promise.race([stopped,new Promise((_,reject)=>{
   watchdog=setTimeout(()=>reject(Error('cancel-ack-retained-stop')),500);
  })]),{done:true,value:undefined});
  assert.equal(cancelCount,1);assert.equal(stream.locked,false);
 }finally{clearTimeout(watchdog);acknowledge();await stopped.catch(()=>{});}
});

test('aborting a pending provider read handles a rejected cancellation without replacing the abort reason',async()=>{
 let entered,cancelCount=0;
 const reading=new Promise(resolve=>{entered=resolve;});
 const stream=new ReadableStream({pull(){entered();},cancel(){cancelCount++;return Promise.reject(Error('synthetic-cancel-rejection'));}},{highWaterMark:0});
 const controller=new AbortController(),run=decodeProviderStream(stream,controller.signal).next();void run.catch(()=>{});
 await reading;controller.abort();
 await assert.rejects(run,error=>error===controller.signal.reason&&error.name==='AbortError');
 assert.equal(cancelCount,1);assert.equal(stream.locked,false);
 await new Promise(resolve=>setImmediate(resolve));
});
