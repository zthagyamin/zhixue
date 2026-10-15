import test from 'node:test';
import assert from 'node:assert/strict';
import {createSyncRouteHandlers} from '../src/infrastructure/sync-server/index.ts';

function harness(owner='account-a'){
 const calls=[];
 const handlers=createSyncRouteHandlers({getUser:async()=>owner?{userId:owner}:null,
  createStore:async user=>{calls.push(['store',user]);return{};},
  processBatch:async user=>{calls.push(['batch',user]);return{accepted:[],duplicates:[],conflicts:[]};},
  legacy:{getSnapshot:async()=>Response.json({}),events:async(body,user)=>{calls.push(['events',user.userId,body]);return Response.json({ok:true});},
   migrate:async(body,user)=>{calls.push(['migrate',user.userId,body]);return Response.json({ok:true});}}});
 return{...handlers,calls};
}
const url='https://study.example.test/api/sync';
const send=(handler,body,headers={})=>handler(new Request(url,{method:'POST',headers,body:JSON.stringify(body)}));

test('every sync action rejects explicit cross-origin intent before body reading or persistence',async()=>{
 for(const action of ['events','migrate','study-events-v3','study-events-v3-bound']){
  for(const headers of [{Origin:'https://other.example.test'},{Origin:'null'},{'Sec-Fetch-Site':'cross-site'},{'Sec-Fetch-Site':'same-site'}]){
   const fixture=harness();const request=new Request(url,{method:'POST',headers,body:JSON.stringify({action,events:[],expectedUserId:'account-a'})});
   request.text=async()=>{throw new Error('body must not be read');};
   assert.equal((await fixture.POST(request)).status,403,action+JSON.stringify(headers));
   assert.equal(request.bodyUsed,false);
   assert.deepEqual(fixture.calls,[]);
  }
 }
});

test('same-origin text requests and authenticated legacy native requests retain their original dispatch',async()=>{
 for(const headers of [{Origin:new URL(url).origin,'Content-Type':'text/plain'},{Origin:new URL(url).origin,'Content-Type':'application/json','Sec-Fetch-Site':'same-origin'},{}]){
  for(const action of ['events','migrate','study-events-v3']){
   const fixture=harness();assert.equal((await send(fixture.POST,{action,events:[],userId:'account-b'},headers)).status,200);
   assert.ok(fixture.calls.every(call=>call[1]==='account-a'));
  }
 }
 const fixture=harness();assert.equal((await send(fixture.POST,{action:'study-events-v3-bound',expectedUserId:'account-a',events:[]})).status,403);
 assert.deepEqual(fixture.calls,[]);
});

test('lengthless oversized sync body stops before consuming its tail',async()=>{
 let pulled=0,cancelled=false;const part=new TextEncoder().encode('x'.repeat(4096));
 const stream=new ReadableStream({pull(controller){if(pulled++<80)controller.enqueue(part);else controller.close();},cancel(){cancelled=true;}},{highWaterMark:0});
 const fixture=harness();const response=await fixture.POST(new Request(url,{method:'POST',body:stream,duplex:'half'}));
 assert.equal(response.status,413);assert.equal(cancelled,true);assert.ok(pulled<80,'oversized input must not be completely materialized');
 assert.deepEqual(fixture.calls,[]);
});

test('authentication wins over cross-origin and malformed bodies without consumption',async()=>{
 const fixture=harness(null),request=new Request(url,{method:'POST',headers:{Origin:'https://other.example.test','Content-Length':'999999'},body:'not JSON'});
 request.text=async()=>{throw new Error('unauthenticated read');};assert.equal((await fixture.POST(request)).status,401);assert.equal(request.bodyUsed,false);assert.deepEqual(fixture.calls,[]);
});

function streamedRequest(text,headers={},signal){
 const bytes=new TextEncoder().encode(text);let offset=0,cancelled=false;
 const stream=new ReadableStream({pull(controller){if(offset===bytes.length){controller.close();return;}
  controller.enqueue(bytes.slice(offset,offset+7));offset=Math.min(bytes.length,offset+7);},cancel(){cancelled=true;}},{highWaterMark:0});
 return{request:new Request(url,{method:'POST',headers,body:stream,duplex:'half',signal}),cancelled:()=>cancelled};
}

test('split Unicode JSON at the original character ceiling is accepted and the next character is rejected',async()=>{
 const prefix=JSON.stringify({action:'events',padding:''}),padding='中'.repeat(64000-prefix.length-2)+'😀';
 const valid=JSON.stringify({action:'events',padding});assert.equal(valid.length,64000);
 for(const headers of [{},{'Content-Length':'garbage'},{'Content-Length':'1'},{'Content-Encoding':'identity'}]){
  const fixture=harness(),streamed=streamedRequest(valid,headers);
  assert.equal((await fixture.POST(streamed.request)).status,200);
  assert.equal(fixture.calls[0][2].padding,padding);
 }
 const fixture=harness(),streamed=streamedRequest(JSON.stringify({action:'events',padding:padding+'x'}));
 assert.equal((await fixture.POST(streamed.request)).status,413);assert.equal(streamed.cancelled(),true);assert.deepEqual(fixture.calls,[]);
});

test('declared oversized input is rejected without reading; malformed bodies never reach persistence',async()=>{
 const fixture=harness(),streamed=streamedRequest('{}',{'Content-Length':'999999'});
 assert.equal((await fixture.POST(streamed.request)).status,413);assert.equal(streamed.request.bodyUsed,false);
 for(const body of ['not JSON','null','[]','"text"']){
  assert.equal((await fixture.POST(new Request(url,{method:'POST',body}))).status,400);
 }
 assert.deepEqual(fixture.calls,[]);
});

test('interrupted and failed body reads keep the original error response and do not save',async()=>{
 const fixture=harness(),controller=new AbortController();let cancelled=false;
 const body=new ReadableStream({cancel(){cancelled=true;}},{highWaterMark:0});
 const pending=fixture.POST(new Request(url,{method:'POST',body,duplex:'half',signal:controller.signal}));
 await new Promise(resolve=>setImmediate(resolve));controller.abort(new Error('synthetic interruption'));
 assert.equal((await pending).status,400);assert.equal(cancelled,true);
 const failed=new ReadableStream({pull(){throw new Error('synthetic read failure');}},{highWaterMark:0});
 assert.equal((await fixture.POST(new Request(url,{method:'POST',body:failed,duplex:'half'}))).status,400);
 assert.deepEqual(fixture.calls,[]);
});
