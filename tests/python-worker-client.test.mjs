import test from 'node:test';
import assert from 'node:assert/strict';
import {createPythonWorkerClient} from '../app/python-worker-client.ts';
class WorkerStub {
  messages=[];stopped=false;onmessage=null;onerror=null;
  postMessage(value){this.messages.push(value);}
  terminate(){this.stopped=true;}
  emit(data){this.onmessage?.({data});}
}
function fixture(timeoutMs=30){const workers=[];const client=createPythonWorkerClient(()=>{const w=new WorkerStub();workers.push(w);return w;},{loadTimeoutMs:100,runTimeoutMs:timeoutMs});return {client,workers};}
async function ready(f){const p=f.client.ready();f.workers.at(-1).emit({type:'ready'});await p;}
test('worker carries stdin, returns bounded result and rejects overlapping runs',async()=>{
  const f=fixture();await ready(f);const p=f.client.run('print(input())','hello');
  await assert.rejects(f.client.run('pass'),/正在运行/);
  const w=f.workers[0],request=w.messages.at(-1);assert.equal(request.stdin,'hello');
  w.emit({type:'result',id:request.id,output:'hello\n',result:null});assert.equal((await p).output,'hello\n');f.client.dispose();
});
test('timeout terminates worker and a retry starts a fresh runtime',async()=>{
  const f=fixture(10);await ready(f);const run=f.client.run('while True: pass');await Promise.resolve();f.workers[0].emit({type:'running',id:f.workers[0].messages.at(-1).id});await assert.rejects(run,{name:'TimeoutError'});assert.equal(f.workers[0].stopped,true);
  await ready(f);assert.equal(f.workers.length,2);f.client.dispose();
});
test('cancellation and stale worker replies never resolve another run',async()=>{
  const f=fixture();await ready(f);const first=f.client.run('pass');await Promise.resolve();const old=f.workers[0],id=old.messages.at(-1).id;f.client.cancel();await assert.rejects(first,{name:'AbortError'});
  await ready(f);const second=f.client.run('print(2)');await Promise.resolve();const w=f.workers[1],next=w.messages.at(-1).id;old.emit({type:'result',id,output:'stale'});w.emit({type:'result',id:next,output:'2'});assert.equal((await second).output,'2');f.client.dispose();
});
test('worker crash and load failure reject rather than reporting a passing test',async()=>{
  const f=fixture();const loading=f.client.ready();f.workers[0].emit({type:'load-error',error:'unavailable'});await assert.rejects(loading,/unavailable/);
  await ready(f);const run=f.client.run('pass');f.workers[1].onerror({preventDefault(){}});await assert.rejects(run,/运行环境/);f.client.dispose();
});
test('dependency preparation has its own budget and cannot be reported as a learner execution failure',async()=>{
 const worker=new WorkerStub(),client=createPythonWorkerClient(()=>worker,{preparationTimeoutMs:10});const loading=client.ready();worker.emit({type:'ready'});await loading;
 await assert.rejects(client.run('import numpy'),{name:'RuntimeError'});assert.equal(worker.stopped,true);client.dispose();
});
test('results are bounded and replies with an unrelated run id do not complete the current run',async()=>{
 const f=fixture();await ready(f);const run=f.client.run('print(1)');await Promise.resolve();const w=f.workers[0],id=w.messages.at(-1).id;w.emit({type:'result',id:id+1,output:'wrong'});w.emit({type:'result',id,output:'x'.repeat(30000)});assert.equal((await run).output.length,20000);f.client.dispose();
});
test('bounded execution diagnostics distinguish program and test phases without changing failure semantics',async()=>{
 const f=fixture();await ready(f);const pending=f.client.run('pass','',true, 'assert False');await Promise.resolve();
 const worker=f.workers[0],id=worker.messages.at(-1).id;
 worker.emit({type:'error',id,error:'test fixture missing a name',executionPhase:'tests',assertionFailure:false});
 await assert.rejects(pending,error=>error.name==='PythonError'&&error.executionPhase==='tests'&&error.assertionFailure===false);f.client.dispose();
});

test('client accepts bound structured reports and rejects wrong identity, malformed metadata or case reconstruction',async()=>{
 const identity={attemptId:'attempt',revision:2,sourceVersion:'source',testVersion:'tests'};
 const tests={schemaVersion:1,type:'code',functionNames:['add'],cases:[{id:'sum',functionName:'add',args:[1,2],expected:3,hint:'Check addition.'}]};
 for(const tamper of [null,'revision','actual-case','version','identity-invented']){
 const f=fixture();await ready(f);const options=tamper==='identity-invented'?{tests}:{identity,tests};
 const pending=f.client.run('def add(a,b): return a+b+1','',true,undefined,options);await Promise.resolve();const worker=f.workers[0],request=worker.messages.at(-1);
 assert.deepEqual(request.tests.cases[0].kwargs,{});
 const report={schemaVersion:1,runId:request.id,identity,status:'failed',phase:'tests',outcome:'student-error',assertionsPassed:0,assertionsExecuted:1,mapping:{prefixLineCount:0,originalLineCount:1},firstFailure:{caseId:'sum',functionName:'add',args:[1,2],kwargs:{},expected:3,actual:4,hint:'Check addition.'}};
 if(tamper==='revision')report.identity={...identity,revision:3};if(tamper==='actual-case')report.firstFailure.args=[5,6];if(tamper==='version')report.schemaVersion=2;
 worker.emit({type:'error',id:request.id,error:'mismatch',report,executionPhase:'program',assertionFailure:true});
 if(tamper)await assert.rejects(pending,{name:'ProtocolError'});else await assert.rejects(pending,error=>error.report.firstFailure.actual===4&&error.executionPhase==='tests');f.client.dispose();
 }
});
test('client rejects mixed legacy and structured tests before sending a run',async()=>{
 const f=fixture();await assert.rejects(f.client.run('pass','',true,'assert True',{tests:{schemaVersion:1,type:'code',functionNames:['add'],cases:[{id:'sum',functionName:'add',args:[],expected:0}]}}),/不能同时/);assert.equal(f.workers.length,0);f.client.dispose();
});
