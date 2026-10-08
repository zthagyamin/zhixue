import assert from 'node:assert/strict';
import test from 'node:test';
import {createAccountStudyHandlers} from '../app/account-study-api.ts';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const origin='https://study.example.test';
function fixture(overrides={}){
  const trace=[],settings={provider:'deepseek',model:'synthetic-chat',baseUrl:'https://api.deepseek.com',revision:1,maxOutputTokens:100};
  const store={getSettings:async()=>settings,begin:async()=>{trace.push('begin');return{status:'accepted',settings};},complete:async()=>trace.push('complete'),fail:async()=>trace.push('fail'),...overrides.store};
  const service={async *stream(_request,_budget,signal){trace.push(['stream',signal.aborted]);signal.throwIfAborted();yield{type:'delta',text:'synthetic'};yield{type:'done',model:settings.model};}};
  const dependencies={enabled:true,getBrowserUser:async()=>({userId:'synthetic'}),getAccessStore:async()=>({profile:async()=>({libraryId:'library'})}),getAiStore:async()=>store,
    getChatAi:async()=>service,planAiAvailable:()=>true,...overrides.dependencies};
  const request=signal=>new Request(origin+'/api/account-study',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},signal,
    body:JSON.stringify({action:'ai-chat',libraryId:'library',request:{requestId:'chat-test',provider:settings.provider,model:settings.model,settingsRevision:settings.revision,context:{id:'x',title:'Synthetic context'},messages:[{role:'user',content:'Synthetic question'}]}})});
  return{trace,service,store,dependencies,request,run:signal=>createAccountStudyHandlers(dependencies).POST(request(signal))};
}

test('an already cancelled account chat never starts a provider or records completion',async()=>{
  const control=new AbortController(),f=fixture();control.abort();const response=await f.run(control.signal);await response.text();
  assert.equal(f.trace.some(value=>Array.isArray(value)&&value[0]==='stream'),false);assert.equal(f.trace.includes('complete'),false);
});

test('cancellation during provider construction cannot be lost before the stream starts',async()=>{
  const wait=deferred(),entered=deferred(),control=new AbortController(),f=fixture();
  f.dependencies.getChatAi=()=>{entered.resolve();return wait.promise;};
  const pending=f.run(control.signal);await entered.promise;control.abort();wait.resolve(f.service);const response=await pending;await response.text();
  assert.equal(f.trace.some(value=>Array.isArray(value)&&value[0]==='stream'),false);assert.equal(f.trace.includes('complete'),false);assert.equal(f.trace.filter(value=>value==='fail').length,1);
});

test('a provider-load failure settles the original reservation and does not enter streaming',async()=>{
  const f=fixture({dependencies:{getChatAi:async()=>{throw Error('unavailable');}}});const response=await f.run();
  assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:'ai-settings-stale'});assert.deepEqual(f.trace,['begin','fail']);
});

test('done is emitted only after durable completion and a persistence failure cannot emit done',async()=>{
  const f=fixture({store:{complete:async()=>{throw Error('storage-unavailable');}}}),response=await f.run(),body=await response.text();
  assert.equal(response.status,200);assert.match(body,/"type":"delta"/);assert.match(body,/"type":"error"/);assert.doesNotMatch(body,/"type":"done"/);assert.equal(f.trace.filter(value=>value==='fail').length,1);
});

test('reader cancellation stops the active provider and cannot create a successful chat result',async()=>{
  const entered=deferred(),ended=deferred(),f=fixture();
  f.dependencies.getChatAi=async()=>({async *stream(_request,_budget,signal){
    yield{type:'delta',text:'first'};entered.resolve();await new Promise(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',resolve,{once:true});});
    ended.resolve();signal.throwIfAborted();
  }});
  const response=await f.run(),reader=response.body.getReader();await reader.read();await entered.promise;await reader.cancel();await ended.promise;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.trace.includes('complete'),false);assert.equal(f.trace.filter(value=>value==='fail').length,1);
});

test('failed failure-persistence closes with an error and never emits a durable completion',async()=>{
  let failures=0;
  const f=fixture({store:{complete:async()=>{throw Error('store unavailable');},fail:async()=>{failures++;throw Error('store unavailable');}}});
  const response=await f.run(),body=await response.text();
  assert.equal(response.status,200);assert.match(body,/"type":"error"/);assert.doesNotMatch(body,/"type":"done"/);assert.equal(failures,1);
});
