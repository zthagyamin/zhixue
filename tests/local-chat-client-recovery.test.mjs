import test from 'node:test';
import assert from 'node:assert/strict';
import {ChatRecoveryJournal,mergeChatRecovery} from '../src/application/ai/index.ts';
import {buildStudyAIRequest} from '../app/ai/study-ai-context.ts';
const request={requestId:'chat-one',provider:'chatgpt',model:'fixture',settingsRevision:1,context:{id:'original',title:'Original source'},messages:[{role:'user',content:'Question'}]};
const user={id:'user-one',role:'user',content:'Question',contextId:'original',contextTitle:'Original source'};
const answer={id:'answer-one',role:'assistant',content:'',provider:'chatgpt',contextId:'original',contextTitle:'Original source'};
function fixture(){let value=null;return{port:{load:async()=>structuredClone(value),change:async update=>{value=structuredClone(update(structuredClone(value)));}},value:()=>structuredClone(value)};}
test('partial failure and a new journal preserve exact request/source and both message IDs',async()=>{
 const f=fixture(),j=new ChatRecoveryJournal('scope-one',f.port);await j.prepare({request,user,answer});
 const calls=[],service={async*chat(sent){calls.push(sent);yield{type:'delta',text:'saved partial'};throw Error('ai-provider-network');}};
 await assert.rejects(async()=>{for await(const row of j.run(request.requestId,service,new AbortController().signal))void row;},/ai-provider-network/);
 const reopened=new ChatRecoveryJournal('scope-one',f.port),rows=await reopened.load();assert.equal(rows[0].answer.content,'saved partial');
 const replay={async*chat(sent){calls.push(sent);yield{type:'delta',text:'saved partial and complete'};yield{type:'done',provider:'chatgpt',model:'fixture'};}};
 for await(const row of reopened.run(request.requestId,replay,new AbortController().signal))assert.equal(row.answer.id,answer.id);
 assert.deepEqual(calls,[request,request]);assert.equal((await reopened.load())[0].state,'done');
 const merged=mergeChatRecovery([user,{...answer,content:'stale history'}],await reopened.load());assert.equal(merged.length,2);assert.equal(merged[1].content,'saved partial and complete');
});
test('save failure before dispatch never starts provider',async()=>{
 let calls=0,fail=false,value=null;const j=new ChatRecoveryJournal('scope',{load:async()=>value,change:async update=>{if(fail)throw Error('ai-chat-storage-unavailable');value=update(value);}});
 await j.prepare({request,user,answer});fail=true;
 const service={async*chat(){calls++;yield{type:'done'};}};
 await assert.rejects(async()=>{for await(const row of j.run(request.requestId,service,new AbortController().signal))void row;},/storage/);
 assert.equal(calls,0);assert.equal(value.entries[0].state,'saved');
});
test('unknown same input with another ID reuses the original saved action',async()=>{
 const f=fixture(),j=new ChatRecoveryJournal('scope',f.port);await j.prepare({request,user,answer});
 const found=await j.prepare({request:{...request,requestId:'another'},user:{...user,id:'new-user'},answer:{...answer,id:'new-answer'}});
 assert.equal(found.request.requestId,request.requestId);assert.equal(found.user.id,user.id);assert.equal((await j.load()).length,1);
});
test('short replay prefixes preserve saved text; contradictory replies never overwrite',async()=>{
 const f=fixture(),j=new ChatRecoveryJournal('scope',f.port);await j.prepare({request,user,answer});
 const fail={async*chat(){yield{type:'delta',text:'long saved text'};throw Error('unknown');}};
 await assert.rejects(async()=>{for await(const row of j.run(request.requestId,fail,new AbortController().signal))void row;});
 const contradiction={async*chat(){yield{type:'delta',text:'different text'};yield{type:'done'};}};
 await assert.rejects(async()=>{for await(const row of j.run(request.requestId,contradiction,new AbortController().signal))void row;},/response-conflict/);
 assert.equal((await j.load())[0].answer.content,'long saved text');assert.equal((await j.load())[0].state,'pending');
 const split={async*chat(){yield{type:'delta',text:'long'};yield{type:'delta',text:' saved text more'};yield{type:'done'};}};
 const sizes=[];for await(const row of j.run(request.requestId,split,new AbortController().signal))sizes.push(row.answer.content.length);
 assert.ok(sizes.every(size=>size>='long saved text'.length));
});
test('scope corruption cannot be mistaken for empty data',async()=>{
 const f=fixture();await new ChatRecoveryJournal('one',f.port).prepare({request,user,answer});
 await assert.rejects(new ChatRecoveryJournal('other',f.port).load(),/recovery-invalid/);
});
test('restoring truncated history keeps chronological turns and latest model context',async()=>{
 const f=fixture(),j=new ChatRecoveryJournal('scope',f.port);
 for(let n=0;n<70;n++){
  const sent={...request,requestId:'r'+n,messages:[{role:'user',content:'Q'+n}]};
  await j.prepare({request:sent,user:{...user,id:'u'+n,content:'Q'+n},answer:{...answer,id:'a'+n}});
  for await(const row of j.run(sent.requestId,{async*chat(){yield{type:'delta',text:'A'+n};yield{type:'done'};}},new AbortController().signal))void row;
 }
 const rows=await j.load(),legacy={id:'legacy',role:'user',content:'Earlier untracked question'},recent=rows.slice(-50).flatMap(row=>[row.user,row.answer]);
 const merged=mergeChatRecovery([legacy,...recent],rows);
 assert.equal(merged[0].id,'legacy');assert.equal(merged[1].id,'u0');assert.equal(merged.at(-1).id,'a69');assert.equal(new Set(merged.map(row=>row.id)).size,141);
 const sent=buildStudyAIRequest({provider:'chatgpt',model:'fixture',revision:1},request.context,[...merged,{...user,id:'u70',content:'Q70'}],'r70');
 assert.equal(sent.messages.at(-2).content,'A69');assert.equal(sent.messages.some(row=>row.content==='A19'),false);
});
