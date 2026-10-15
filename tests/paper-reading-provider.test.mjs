import test from 'node:test';
import assert from 'node:assert/strict';
import {createPaperReadingProvider} from '../src/infrastructure/paper-reading/index.ts';
const trace={requestId:'r',modelId:'fixture',promptVersion:'v1',ruleVersion:'v1'};
test('provider sends only current learning source and uses existing controlled transport',async()=>{
 let body;const provider=createPaperReadingProvider({key:'synthetic-key',model:'fixture',baseUrl:'https://fixture.example/v1',allowedOrigins:['https://fixture.example'],fetcher:async(_url,init)=>{
  body=JSON.parse(init.body);return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({status:'needs-improvement',reason:'Missing figure'})}}],usage:{total_tokens:20}});
 }});
 const unit={title:'Paper',goal:'Explain',source:{ownerId:'private-owner',libraryId:'private-library',sourceVersion:'v',sectionId:'Methods',paragraphs:[{id:'p',rawEn:'Source'}]}};
 const result=await provider.run('prepare',{unit},trace,{maxOutputTokens:1200},new AbortController().signal);
 assert.equal(result.output.status,'needs-improvement');assert.equal(body.max_tokens,1200);assert.deepEqual(result.trace,trace);
 const sent=JSON.parse(body.messages[1].content);assert.deepEqual(Object.keys(sent).sort(),['goal','paragraphs','sectionId','title']);
 assert.equal(JSON.stringify(body).includes('private-owner'),false);
});
test('truncated or malformed model output and abort do not become reading results',async()=>{
 const input={unit:{title:'Paper',goal:'Explain',source:{sectionId:'s',paragraphs:[]}}};
 const make=finish=>createPaperReadingProvider({key:'synthetic-key',model:'fixture',baseUrl:'https://fixture.example/v1',allowedOrigins:['https://fixture.example'],fetcher:async()=>Response.json({choices:[{finish_reason:finish,message:{content:'{}'}}]})});
 await assert.rejects(make('length').run('prepare',input,trace,{maxOutputTokens:100},new AbortController().signal),/invalid/);
 const controller=new AbortController();controller.abort();await assert.rejects(make('stop').run('prepare',input,trace,{maxOutputTokens:100},controller.signal),/abort/i);
});

test('paper request has a deadline while waiting for provider headers',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const caller=new AbortController();let upstream;
 const provider=createPaperReadingProvider({key:'synthetic-key',model:'fixture',baseUrl:'https://fixture.example/v1',allowedOrigins:['https://fixture.example'],timeoutMs:1000,
  fetcher:async(_url,init)=>{upstream=init.signal;return new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}));}});
 const pending=provider.run('prepare',{unit:{title:'Paper',goal:'Explain',source:{sectionId:'s',paragraphs:[]}}},trace,{maxOutputTokens:100},caller.signal)
  .then(()=>null,error=>error);
 try{
  t.mock.timers.tick(1000);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(upstream.aborted,true,'server deadline must abort the pending fetch');
  assert.equal((await pending).message,'paper-ai-timeout');
 }finally{caller.abort();await pending;}
});

test('paper deadline includes a stalled body and releases its reader',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const caller=new AbortController();let cancelled=false;
 const provider=createPaperReadingProvider({key:'synthetic-key',model:'fixture',baseUrl:'https://fixture.example/v1',allowedOrigins:['https://fixture.example'],timeoutMs:1000,
  fetcher:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}))});
 const pending=provider.run('prepare',{unit:{title:'Paper',goal:'Explain',source:{sectionId:'s',paragraphs:[]}}},trace,{maxOutputTokens:100},caller.signal)
  .then(()=>null,error=>error);
 try{
  await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(1000);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(cancelled,true,'deadline must cancel a pending body read');
  assert.equal((await pending).message,'paper-ai-timeout');
 }finally{caller.abort();await pending;}
});
