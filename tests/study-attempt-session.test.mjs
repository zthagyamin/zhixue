import assert from 'node:assert/strict';
import test from 'node:test';
import {createStudyAttemptSession,createStudyEvaluation} from '../src/application/study-attempt/index.ts';
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function fixture(){
 let pending=null,epoch=0,resume=null,ids=0,now=0,commits=0,failures=0,current=true;
 const gate={begin(){if(pending)return null;pending={epoch};return pending;},commit(ticket,continuation){if(ticket!==pending||ticket.epoch!==epoch)return false;pending=null;resume=continuation;commits++;return true;},fail(ticket){if(ticket!==pending)return false;pending=null;failures++;return true;}};
 const session=createStudyAttemptSession({binding:{scopeKey:'owner/library',itemBinding:'item/content',mode:'recall:1'},gate,newId:()=>`event-${++ids}`,now:()=>`2026-09-17T12:00:0${now++}.000Z`});
 return {session,gate,current:()=>current,setCurrent:value=>current=value,counts:()=>({ids,now,commits,failures}),continue(){const fn=resume;resume=null;fn?.();},clear(){epoch++;pending=null;session.invalidate();}};
}
test('local durability unlocks once while delivery remains pending, and continuation never resaves',async()=>{
 const f=fixture(),write=deferred(),delivery=deferred();let saves=0,published=0,moves=0;
 const options={intent:'good',current:f.current,deferred:true,execute:async(request,control)=>{saves++;await write.promise;control.durable({publish:()=>published++,continue:()=>moves++});await delivery.promise;}};
 const pending=f.session.submit(options);assert.equal(f.session.snapshot().phase,'saving');
 assert.equal((await f.session.submit(options)).status,'blocked');assert.equal(saves,1);
 write.resolve();assert.equal((await pending).status,'saved');assert.equal(published,1);assert.equal(moves,0);
 f.continue();f.continue();assert.equal(moves,1);assert.equal(saves,1);assert.equal(f.session.snapshot().phase,'continued');delivery.resolve();
});
test('lost reply retry keeps one identity, time and immutable command despite caller mutations',async()=>{
 const f=fixture(),records=new Map(),input={rating:'again',answer:'first',state:{due:'old'}},requests=[];let loseReply=true;
 const execute=(request,control)=>{
  const command=request.capture('command',()=>input);requests.push({identity:request.identity,command});
  const key=request.identity.eventId,prior=records.get(key);if(prior)assert.deepEqual(prior,command);else records.set(key,structuredClone(command));
  command.answer='outside mutation';
  if(loseReply){loseReply=false;throw Error('reply lost after write');}
  control.durable();
 };
 assert.equal((await f.session.submit({intent:'again',current:f.current,execute})).status,'failed');
 input.answer='changed';input.state.due='new';
 assert.equal((await f.session.submit({intent:'again',current:f.current,execute})).status,'saved');
 assert.equal(records.size,1);assert.deepEqual(records.values().next().value,{rating:'again',answer:'first',state:{due:'old'}});
 assert.deepEqual(requests[0].identity,requests[1].identity);assert.deepEqual(f.counts(),{ids:1,now:1,commits:1,failures:1});
});
test('different retry intent cannot overwrite an unresolved request',async()=>{
 const f=fixture();let executions=0;
 const execute=()=>{executions++;throw Error('offline');};
 await f.session.submit({intent:'again',current:f.current,execute});
 const result=await f.session.submit({intent:'good',current:f.current,execute});
 assert.equal(result.status,'conflict');assert.equal(executions,1);assert.equal(f.counts().ids,1);
});
test('reentrant retry from an error callback cannot settle the wrong submit promise',async()=>{
 const f=fixture(),network=deferred();let retry,complete,firstStatus,retryStatus;
 const first=f.session.submit({intent:'good',current:f.current,execute(){throw Error('first write failed');},onError(){
  retry=f.session.submit({intent:'good',current:f.current,execute(_request,control){complete=()=>control.durable();return network.promise;}});
 }});
 first.then(result=>{firstStatus=result.status;});retry.then(result=>{retryStatus=result.status;});
 await Promise.resolve();assert.equal(firstStatus,'failed');assert.equal(retryStatus,undefined);
 complete();assert.equal((await retry).status,'saved');assert.equal((await first).status,'failed');network.resolve();
});
test('post-durability presentation failure never unfreezes the saved attempt',async()=>{
 const f=fixture(),issues=[];let writes=0;
 const result=await f.session.submit({intent:'good',current:f.current,execute(_request,control){writes++;control.durable({publish(){throw Error('paint failed');}});},onError:(error,saved)=>issues.push([error.message,saved])});
 assert.equal(result.status,'saved');assert.equal(f.counts().failures,0);assert.deepEqual(issues,[['paint failed',true]]);
 assert.equal((await f.session.submit({intent:'good',current:f.current,execute(){writes++;}})).status,'blocked');assert.equal(writes,1);
});
test('a promise fulfilling without a durable receipt is not a saved attempt',async()=>{
 const f=fixture();const result=await f.session.submit({intent:'good',current:f.current,execute:async()=>{}});
 assert.equal(result.status,'failed');assert.equal(f.counts().commits,0);assert.equal(f.counts().failures,1);
});
test('late saved receipt after a new owner cannot publish or advance the new page',async()=>{
 const f=fixture(),wait=deferred();let published=0,moves=0;
 const pending=f.session.submit({intent:'good',current:f.current,deferred:true,execute:async(_request,control)=>{await wait.promise;control.durable({publish:()=>published++,continue:()=>moves++});}});
 f.setCurrent(false);wait.resolve();assert.equal((await pending).status,'stale');f.continue();assert.equal(published,0);assert.equal(moves,0);
});
test('explicit invalidation preserves new generations and ignores late callbacks',async()=>{
 const f=fixture(),wait=deferred();let shown=0;
 const pending=f.session.submit({intent:'good',current:f.current,execute:async(_request,control)=>{await wait.promise;control.durable({publish:()=>shown++});}});
 f.clear();wait.resolve();assert.equal((await pending).status,'stale');assert.equal(shown,0);assert.equal(f.counts().commits,0);
});
test('synchronous demonstration acknowledgements remain synchronous and do not need persistence',async()=>{
 const f=fixture();let demo=0;const promise=f.session.submit({intent:'demo',current:f.current,execute(_request,control){control.durable({publish:()=>demo++});}});
 assert.equal(demo,1);assert.equal((await promise).status,'saved');
});
test('normal successful navigation does not relabel its own saved receipt as stale',async()=>{
 const f=fixture();const result=await f.session.submit({intent:'good',current:f.current,execute(_request,control){control.durable({publish:()=>f.setCurrent(false)});}});
 assert.equal(result.status,'saved');
});
test('scope invalidation during commit notifications cannot revive a retired session',async()=>{
 const f=fixture();let published=0;const commit=f.gate.commit;
 f.gate.commit=(...args)=>{const applied=commit(...args);f.session.invalidate();return applied;};
 const result=await f.session.submit({intent:'good',current:f.current,execute(_request,control){control.durable({publish:()=>published++});}});
 assert.equal(result.status,'stale');assert.equal(published,0);assert.equal(f.session.snapshot().phase,'stale');
});
test('evaluation cancellation releases its lock and a late operation cannot release a newer evaluation',async()=>{
 let saving=false,notifications=0;const gate=createStudyEvaluation({blocked:()=>saving,notify:()=>notifications++});
 const first=deferred(),second=deferred(),abort=new AbortController();
 const cancelled=gate.run(()=>first.promise,abort.signal);assert.equal(gate.isBusy(),true);
 abort.abort();await assert.rejects(cancelled,{name:'AbortError'});assert.equal(gate.isBusy(),false);
 const newer=gate.run(()=>second.promise);first.resolve('old');await Promise.resolve();assert.equal(gate.isBusy(),true);
 second.resolve('new');assert.equal(await newer,'new');assert.equal(gate.isBusy(),false);
 saving=true;await assert.rejects(gate.run(async()=>1));assert.ok(notifications>=4);
});
