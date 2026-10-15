import test from 'node:test';
import assert from 'node:assert/strict';
import {createPaperReviewService} from '../src/application/paper-review/index.ts';
const settings={enabled:true,configured:true,provider:'chatgpt',model:'existing-model',revision:3};
const prepared={prompt:'Ask about the current mechanism.',context:{id:'paper:p:para',title:'Paper',question:'Original source',learnerAnswer:'Own explanation'},truncated:false,notice:'Current paragraph only.'};
function fixture(extra={}){
 let scope='owner/library/paper/version/paragraph/template',config=settings,ids=0,calls=[];
 const service=createPaperReviewService({prepare:()=>prepared,currentScope:()=>scope,settings:()=>config,requestId:()=>`review-${++ids}`,
  ai:{async *chat(request,signal){calls.push({request,signal});yield {type:'delta',text:'Check the source.'};}},...extra});
 return {service,calls,get ids(){return ids;},scope:value=>scope=value,config:value=>config=value};
}
test('review builds current-source chat with existing configuration and exposes streamed reference',async()=>{
 const f=fixture(),seen=[];f.service.subscribe(()=>seen.push(f.service.snapshot().status));
 await f.service.review('mechanism');
 assert.deepEqual(f.calls[0].request,{requestId:'review-1',provider:'chatgpt',model:'existing-model',settingsRevision:3,context:prepared.context,messages:[{role:'user',content:prepared.prompt}]});
 assert.equal(f.service.snapshot().text,'Check the source.');assert.equal(f.service.snapshot().prompt,prepared.prompt);
 assert.ok(seen.includes('streaming'));assert.equal(f.service.snapshot().status,'idle');
});
test('offline review preserves a copyable prompt without request identity or transport',async()=>{
 const f=fixture();f.config(null);await f.service.review('mechanism');
 assert.equal(f.ids,0);assert.equal(f.calls.length,0);assert.equal(f.service.snapshot().prompt,prepared.prompt);
 assert.match(f.service.snapshot().message,/复制/);
});
test('excerpt waits for one explicit approval and uses the prepared scope',async()=>{
 const f=fixture({prepare:()=>({...prepared,truncated:true,notice:'Only an excerpt.'})});
 await f.service.review('mechanism');assert.equal(f.service.snapshot().status,'confirmation-required');assert.equal(f.calls.length,0);
 await f.service.confirmExcerpt();assert.equal(f.calls.length,1);assert.equal(f.service.snapshot().text,'Check the source.');
 await f.service.confirmExcerpt();assert.equal(f.calls.length,1);
});
test('source or settings changes after excerpt preparation prevent sending old content',async()=>{
 for(const change of ['scope','settings']){
  const f=fixture({prepare:()=>({...prepared,truncated:true})});await f.service.review('mechanism');
  if(change==='scope')f.scope('another-owner/library');else f.config({...settings,revision:4});
  await f.service.confirmExcerpt();assert.equal(f.calls.length,0);assert.equal(f.service.snapshot().status,'idle');
 }
});
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
test('cancel and a replacement review suppress late deltas and old failure',async()=>{
 const old=deferred();let call=0,oldSignal;
 const f=fixture({ai:{async *chat(_request,signal){if(++call===1){oldSignal=signal;yield {type:'delta',text:'Old partial'};await old.promise;yield {type:'delta',text:'late'};throw Error('late failure');}yield {type:'delta',text:'New reference'};}}});
 const first=f.service.review('first');await Promise.resolve();f.service.cancel();assert.equal(oldSignal.aborted,true);
 await f.service.review('second');old.resolve();await first;
 assert.equal(f.service.snapshot().text,'New reference');assert.equal(f.service.snapshot().status,'idle');
});
test('source and configuration changes during streaming suppress stale text',async()=>{
 for(const change of ['scope','settings']){
  const gate=deferred();const f=fixture({ai:{async *chat(){await gate.promise;yield {type:'delta',text:'Must not appear'};}}});
  const run=f.service.review('mechanism');if(change==='scope')f.scope('different-paragraph');else f.config({...settings,model:'changed'});
  gate.resolve();await run;assert.equal(f.service.snapshot().text,'');assert.equal(f.service.snapshot().status,'idle');
 }
});
test('unsupported source and transport failure remain honest with no grading or storage ports',async()=>{
 const invalid=fixture({prepare:()=>{throw Error('Source unavailable');}});await invalid.service.review('mechanism');
 assert.equal(invalid.calls.length,0);assert.equal(invalid.service.snapshot().notice,'Source unavailable');
 const fail=fixture({ai:{chat(){throw Error('Unavailable');}}});await fail.service.review('mechanism');
 assert.match(fail.service.snapshot().text,/AI 暂不可用/);assert.equal(fail.service.snapshot().prompt,prepared.prompt);
 assert.deepEqual(Object.keys(fail.service).sort(),['cancel','confirmExcerpt','review','snapshot','subscribe']);
});

test('stale completion without a final delta clears previously streamed reference',async()=>{
 const gate=deferred();const f=fixture({ai:{async *chat(){yield {type:'delta',text:'Partial reference'};await gate.promise;}}});
 const first=deferred();const off=f.service.subscribe(()=>{if(f.service.snapshot().text==='Partial reference')first.resolve();});
 const run=f.service.review('mechanism');await first.promise;off();assert.equal(f.service.snapshot().text,'Partial reference');
 f.scope('new-paragraph');gate.resolve();await run;assert.equal(f.service.snapshot().text,'');assert.equal(f.service.snapshot().status,'idle');
});
test('cancel while waiting for excerpt approval cannot later send the cancelled intent',async()=>{
 const f=fixture({prepare:()=>({...prepared,truncated:true})});await f.service.review('mechanism');f.service.cancel();
 await f.service.confirmExcerpt();assert.equal(f.calls.length,0);assert.equal(f.ids,0);assert.equal(f.service.snapshot().prompt,prepared.prompt);
});
