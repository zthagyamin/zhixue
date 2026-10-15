import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB} from 'fake-indexeddb';
import {createLocalChatRecovery} from '../app/ai/local-chat-recovery-store.ts';
import {createLocalStudyAIService} from '../app/ai/study-ai-service.ts';
import {openStudyDb,RECORD_STORE} from '../app/local-study-db.ts';
globalThis.indexedDB=indexedDB;
const scope={mode:'local',ownerId:'owner-one',libraryId:'library-one'};
const request={requestId:'chat-one',provider:'chatgpt',model:'fixture',settingsRevision:1,context:{id:'original',title:'Original'},messages:[{role:'user',content:'Question'}]};
const candidate={request,user:{id:'user-one',role:'user',content:'Question',contextId:'original'},answer:{id:'answer-one',role:'assistant',content:'',provider:'chatgpt',contextId:'original'}};
test('actual IndexedDB readback isolates owner/library and survives journal reconstruction',async()=>{
 const journal=createLocalChatRecovery(scope,'conversation-isolation');await journal.prepare(candidate);
 assert.deepEqual((await createLocalChatRecovery(scope,'conversation-isolation').load())[0].request,request);
 assert.deepEqual(await createLocalChatRecovery({...scope,ownerId:'another-owner'},'conversation-isolation').load(),[]);
 assert.deepEqual(await createLocalChatRecovery({...scope,libraryId:'another-library'},'conversation-isolation').load(),[]);
});
test('two actual IndexedDB writers for same input retain one request and message identity',async()=>{
 const a=createLocalChatRecovery(scope,'concurrent-conversation'),b=createLocalChatRecovery(scope,'concurrent-conversation');
 const second={request:{...request,requestId:'another-id'},user:{...candidate.user,id:'another-user'},answer:{...candidate.answer,id:'another-answer'}};
 const [one,two]=await Promise.all([a.prepare(candidate),b.prepare(second)]);
 assert.equal(one.request.requestId,two.request.requestId);assert.equal(one.answer.id,two.answer.id);assert.equal((await a.load()).length,1);
});
test('an older generation cannot replace a completed newer generation in actual storage',async()=>{
 const a=createLocalChatRecovery(scope,'generation-conversation'),b=createLocalChatRecovery(scope,'generation-conversation');await a.prepare(candidate);
 let release;const wait=new Promise(resolve=>release=resolve),old={async*chat(){yield{type:'delta',text:'prefix'};await wait;yield{type:'delta',text:' old'};yield{type:'done'};}};
 const stream=a.run(request.requestId,old,new AbortController().signal);await stream.next();const stale=stream.next();
 const fresh={async*chat(){yield{type:'delta',text:'prefix new'};yield{type:'done',provider:'chatgpt',model:'fixture'};}};
 for await(const row of b.run(request.requestId,fresh,new AbortController().signal))void row;
 release();await assert.rejects(stale,/ai-request-conflict/);
 const row=(await a.load())[0];assert.equal(row.state,'done');assert.equal(row.answer.content,'prefix new');assert.equal(row.answer.id,candidate.answer.id);
});
test('old Companion capability is refused before a credential-bearing chat request',async()=>{
 const calls=[],service=createLocalStudyAIService({baseUrl:'http://127.0.0.1:9999',token:'synthetic-token',libraryId:'lib',fetcher:async(url,options)=>{calls.push({url,options});return Response.json({capabilities:[]});}});
 await assert.rejects(async()=>{for await(const event of service.chat(request,new AbortController().signal))void event;},/chat-upgrade-required/);
 assert.equal(calls.length,1);assert.equal(calls[0].options.redirect,'error');assert.equal(calls[0].options.headers,undefined);
});
test('current Companion receives exact ID with redirects refused, including a stopped signal',async()=>{
 const calls=[],service=createLocalStudyAIService({baseUrl:'http://127.0.0.1:9999',token:'synthetic-token',libraryId:'lib',fetcher:async(url,options)=>{calls.push({url,options});
  if(url.endsWith('/health'))return Response.json({capabilities:['local-ai-chat-recovery-v1']});
  return new Response('data: {"type":"done","provider":"chatgpt","model":"fixture"}\n\n',{headers:{'Content-Type':'text/event-stream'}});}});
 for await(const event of service.chat(request,new AbortController().signal))void event;
 assert.equal(calls.length,2);assert.equal(JSON.parse(calls[1].options.body).request.requestId,request.requestId);assert.equal(calls[1].options.redirect,'error');
 const abort=new AbortController();abort.abort();await assert.rejects(async()=>{for await(const event of service.chat(request,abort.signal))void event;});assert.equal(calls.length,2);
});
test('present records with null or missing values fail closed on read and write',async()=>{
 for(const mode of ['null','missing']){
  const journal=createLocalChatRecovery(scope,'corrupt-'+mode);await journal.prepare(candidate);
  const db=await openStudyDb();
  try{await new Promise((resolve,reject)=>{
   const tx=db.transaction(RECORD_STORE,'readwrite'),store=tx.objectStore(RECORD_STORE),get=store.getAll();
   get.onsuccess=()=>{const row=get.result.find(row=>row.kind.endsWith('corrupt-'+mode));assert.ok(row);
    if(mode==='null')row.value=null;else delete row.value;store.put(row);};
   tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
  });}finally{db.close();}
  await assert.rejects(journal.load(),/recovery-invalid/);
  const replacement={request:{...request,requestId:'replacement'},user:{...candidate.user,id:'replacement-user'},answer:{...candidate.answer,id:'replacement-answer'}};
  await assert.rejects(journal.prepare(replacement),/recovery-invalid/);
 }
});
