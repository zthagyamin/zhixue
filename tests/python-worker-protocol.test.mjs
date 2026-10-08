import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/workers/python-runtime.js',import.meta.url),'utf8');
function fixture({packageError=false,longOutput=false}={}){
  const messages=[];let executions=0,stdout,input;
  const python={loadPackagesFromImports:async(_code,options)=>{if(packageError)options.errorCallback('package download failed');},setStdin:options=>{input=options.stdin;},setStdout:options=>{stdout=options.batched;},setStderr(){},toPy:()=>({destroy(){}}),runPythonAsync:async()=>{executions++;stdout(longOutput?'x'.repeat(30000):input?.()??'ok');return null;}};
  const self={postMessage:value=>messages.push(value)};
  const context=vm.createContext({self,fixturePython:python});
  vm.runInContext(source+'\npython=fixturePython;checkAssertions=()=>2;validateTests=()=>{};',context);
  return {self,messages,context,python,executions:()=>executions};
}
test('a non-throwing package download failure stays an environment error and never executes learner code',async()=>{
  const f=fixture({packageError:true});await f.self.onmessage({data:{type:'run',id:1,code:'import numpy',testCode:'assert True',captureOutput:true}});
  assert.equal(f.executions(),0);assert.equal(f.messages.length,1);assert.equal(f.messages[0].type,'prepare-error');assert.match(f.messages[0].error,/package download failed/);
});
test('execution starts after preparation, uses stdin and returns a measured assertion count',async()=>{
  const f=fixture();await f.self.onmessage({data:{type:'run',id:7,code:'print(input())',stdin:'hello',testCode:'assert True',captureOutput:true}});
  assert.equal(f.executions(),1);assert.equal(f.messages[0].type,'running');assert.equal(f.messages[1].type,'result');assert.equal(f.messages[1].output,'hello\n');assert.equal(f.messages[1].assertionsPassed,2);
});
test('large output is bounded and clearly marked as truncated',async()=>{
  const f=fixture({longOutput:true});await f.self.onmessage({data:{type:'run',id:1,code:'print(1)',captureOutput:true}});const result=f.messages.at(-1);assert.ok(result.output.length<=20000);assert.match(result.output,/输出已截断/);
});

test('test TypeError text mentioning AssertionError is never trusted assertion evidence',async()=>{
 const f=fixture();vm.runInContext('checkAssertions=()=>{throw new TypeError("AssertionError appears in setup text");}',f.context);
 await f.self.onmessage({data:{type:'run',id:11,code:'pass',testCode:'assert True'}});
 assert.equal(f.messages.at(-1).assertionFailure,false);
});
test('program exception marker text is not a test definition error',async()=>{
 const f=fixture();f.python.runPythonAsync=async()=>{throw new Error('ZHIXUE_INVALID_TEST_DEFINITION in student text');};
 await f.self.onmessage({data:{type:'run',id:12,code:'raise ValueError()'}});
 assert.equal(f.messages.at(-1).type,'error');assert.equal(f.messages.at(-1).testDefinitionError,false);
});


let realPython;
async function realFixture(){
 const {loadPyodide}=await import('pyodide');realPython??=loadPyodide();const python=await realPython;
 const messages=[];const self={postMessage:value=>messages.push(value),__zhixueSandboxRuntime:async()=>({python,checker:readFileSync(new URL('../public/workers/python-assertions.py',import.meta.url),'utf8')})};
 vm.runInContext(source,vm.createContext({self}));await self.onmessage({data:{type:'init'}});assert.equal(messages.at(-1).type,'ready');messages.length=0;
 return{self,messages};
}
test('actual Pyodide Worker produces a one-call structured report with no invented identity',async()=>{
 const f=await realFixture();await f.self.onmessage({data:{type:'run',id:51,code:'calls=0\ndef add(a,b):\n global calls\n calls+=1\n return a+b+calls',tests:{schemaVersion:1,type:'code',functionNames:['add'],cases:[{id:'sum',functionName:'add',args:[1,2],expected:3}]}}});
 const result=f.messages.at(-1);assert.equal(result.type,'error');assert.equal(result.report.firstFailure.actual,4);assert.equal(result.report.assertionsExecuted,1);assert.equal(result.report.identity,undefined);
});
test('actual Pyodide keeps absent tests, builtin assertions, custom names and import-only test mappings distinct',async()=>{
 const f=await realFixture();
 for(const [id,code,testCode,kind,isAssertion,prefix] of [
 [61,"raise ValueError('ZHIXUE_INVALID_TEST_DEFINITION')",undefined,'student-error',false,0],
 [62,'pass',"raise TypeError('AssertionError text')",'unknown',false,0],
 [63,'pass','class AssertionError(Exception): pass\nraise AssertionError("custom")','unknown',false,0],
 [64,'def add(a,b): return a+b','assert add(1,2)==4','student-error',true,0],
 [65,'x=1\nraise ValueError("student")','assert math.sqrt(4)==2','student-error',false,1],
 ]){
 await f.self.onmessage({data:{type:'run',id,code,testCode}});const result=f.messages.at(-1);assert.equal(result.report.outcome,kind);assert.equal(result.report.exception.isAssertion,isAssertion);assert.equal(result.report.mapping.prefixLineCount,prefix);
 if(id===65)assert.equal(result.report.exception.location.originalLine,2);
 }
 await f.self.onmessage({data:{type:'run',id:66,code:'import asyncio\nawait asyncio.sleep(0)\n3+4'}});assert.equal(f.messages.at(-1).type,'result');assert.equal(f.messages.at(-1).result,'7');
});

import {createPythonWorkerClient} from '../app/python-worker-client.ts';
import {codeRunFailure,codeRunSuccess,formatCodeFailureFeedback} from '../src/domain/remediation/index.ts';
test('actual Pyodide report survives the client boundary into domain feedback and measured legacy success',async()=>{
 const f=await realFixture();const port={onmessage:null,onerror:null,postMessage:value=>{void f.self.onmessage({data:value});},terminate(){}};
 f.self.postMessage=value=>{f.messages.push(value);port.onmessage?.({data:structuredClone(value)});};
 const client=createPythonWorkerClient(()=>port);await client.ready();
 const identity={attemptId:'real-attempt',revision:1,sourceVersion:'source',testVersion:'cases'};
 const tests={schemaVersion:1,type:'code',functionNames:['add'],cases:[{id:'sum',functionName:'add',args:[1,2],expected:3,hint:'Check addition.'}]};
 try{
 await assert.rejects(client.run('def add(a,b): return a+b+1','',true,undefined,{identity,tests}),error=>{
 assert.equal(codeRunFailure(error).kind,'student-error');assert.equal(formatCodeFailureFeedback(error).firstFailure.actual,4);assert.deepEqual(error.report.identity,identity);return true;
 });
 const passed=await client.run('def add(a,b): return a+b','',true,'assert add(1,2)==3\nassert add(-1,1)==0');
 assert.equal(passed.report.assertionsExecuted,2);assert.equal(codeRunSuccess(passed,'tests').kind,'checked');assert.equal(codeRunSuccess(passed,'tests').report.identity,undefined);
 await assert.rejects(client.run('pass','',true,"raise TypeError('AssertionError text')"),error=>codeRunFailure(error).kind==='unknown');
 }finally{client.dispose();}
});

async function realClientFixture(){
 const f=await realFixture();const port={onmessage:null,onerror:null,postMessage:value=>{void f.self.onmessage({data:value});},terminate(){}};
 f.self.postMessage=value=>{f.messages.push(value);port.onmessage?.({data:structuredClone(value)});};
 const client=createPythonWorkerClient(()=>port);await client.ready();return {client,messages:f.messages};
}
test('review: actual Pyodide SyntaxError uses trusted compilation or executed frame rather than chosen filename',async()=>{
 const f=await realClientFixture();
 try{
 for(const testCode of ["compile('def broken(', '<learner>', 'exec')","raise SyntaxError('fake', ('<learner>', 999, 1, 'ignored'))","exec(compile(\"raise SyntaxError('fake', ('<learner>', 1, 1, 'ignored'))\", '<learner>', 'exec'))"]){
 await assert.rejects(f.client.run('pass','',true,testCode),error=>{
 assert.equal(error.name,'PythonError');assert.equal(codeRunFailure(error).kind,'unknown');assert.equal(error.report.phase,'tests');assert.equal(error.report.exception.location.origin,'tests');assert.equal(error.report.exception.location.line,1);return true;
 });
 }
 await assert.rejects(f.client.run('def broken('),error=>{assert.equal(codeRunFailure(error).kind,'student-error');assert.equal(error.report.exception.location.originalLine,1);return true;});
 await assert.rejects(f.client.run("def break_it():\n compile('def broken(', '<题目测试>', 'exec')",'',true,'break_it()'),error=>{assert.equal(codeRunFailure(error).kind,'student-error');assert.equal(error.report.exception.location.origin,'learner');assert.equal(error.report.exception.location.originalLine,2);return true;});
 }finally{f.client.dispose();}
});

test('review: actual Pyodide keeps successful legacy checks when later setup fails without reevaluation',async()=>{
 const f=await realClientFixture();
 try{
 for(const [testCode,executed,passed,kind] of [
 ['assert True\nraise TypeError("setup")',1,1,'unknown'],
 ['assert True\nassert True\nraise TypeError("setup")',2,2,'unknown'],
 ['assert True\nassert False',2,1,'student-error'],
 ['assert True\nassert missing_fixture()',2,1,'unknown'],
 ])await assert.rejects(f.client.run('pass','',true,testCode),error=>{assert.equal(error.name,'PythonError');assert.equal(error.report.assertionsExecuted,executed);assert.equal(error.report.assertionsPassed,passed);assert.equal(codeRunFailure(error).kind,kind);return true;});
 const code="events=[]\nclass Truth:\n def __bool__(self):\n  events.append('truth')\n  return True\ndef observe():\n events.append('expression')\n return Truth()";
 await assert.rejects(f.client.run(code,'',true,"assert observe(), missing_failure_message()\nassert events == ['expression', 'truth']\nraise TypeError('setup')"),error=>{assert.equal(codeRunFailure(error).kind,'unknown');assert.equal(error.report.assertionsExecuted,2);assert.equal(error.report.assertionsPassed,2);return true;});
 }finally{f.client.dispose();}
});

test('review: actual Pyodide clips Unicode diagnostic fields in UTF16 without dropping report provenance',async()=>{
 const f=await realClientFixture();
 try{
 await assert.rejects(f.client.run('raise ValueError("😀"*3000)'),error=>{assert.equal(error.name,'PythonError');assert.equal(codeRunFailure(error).kind,'student-error');assert.equal(error.report.exception.kind,'ValueError');assert.equal(error.report.exception.message,'😀'.repeat(2000));assert.equal(error.report.exception.location.originalLine,1);return true;});
 await assert.rejects(f.client.run('raise ValueError("a"*3999 + "😀tail")'),error=>{assert.equal(error.report.exception.message,'a'.repeat(3999));return true;});
 const name='𐐀'.repeat(90);
 await assert.rejects(f.client.run(`raise type("${name}", (Exception,), {})("message")`),error=>{assert.equal(error.name,'PythonError');assert.equal(codeRunFailure(error).kind,'student-error');assert.ok(error.report.exception.kind.length<=128);return true;});
 await assert.rejects(f.client.run(`def ${name}():\n raise ValueError("message")\n${name}()`),error=>{assert.equal(error.name,'PythonError');assert.ok(error.report.exception.location.functionName.length<=128);assert.equal(error.report.exception.location.originalLine,2);return true;});
 }finally{f.client.dispose();}
});

import {createNonWordSession} from '../src/application/nonword-study/index.ts';
import {applyAttemptMutation,parseAttemptMutation} from '../src/domain/learning-attempt/index.ts';
import {attemptFingerprint,evaluationFingerprint} from '../src/infrastructure/learning-attempt/index.ts';
test('actual empty nonword submission runs in Pyodide with its durable answer revision zero',async()=>{
 const rows=new Map();let operation=0;
 const binding={ownerId:'empty-owner',libraryId:'library',snapshotId:'snapshot',itemKey:'code',contentHash:'a'.repeat(64),groupId:'group',roundId:'round'};
 const repository={read:async id=>rows.get(id)??null,mutate:async raw=>{
 const mutation=parseAttemptMutation(raw),receipt=applyAttemptMutation(rows.get(mutation.attemptId)??null,mutation,await attemptFingerprint(mutation));
 if(receipt.status==='accepted')rows.set(mutation.attemptId,receipt.attempt);
 return {...receipt,durable:receipt.status!=='conflict'};
 }};
 const session=createNonWordSession({repository,binding,attemptId:'empty-code',formalEventId:'empty-formal',mode:'code',now:()=> '2026-10-08T00:00:00.000Z',newId:()=>`empty-operation-${++operation}`,fingerprint:attemptFingerprint,evaluationFingerprint});
 await session.open();await session.submit('');const submitted=session.snapshot();
 assert.equal(submitted.submitted.answer,'');assert.equal(submitted.submitted.answerRevision,0);
 const identity={attemptId:submitted.attemptId,revision:submitted.submitted.answerRevision,sourceVersion:binding.contentHash,testVersion:'empty-trial-tests'};
 const f=await realClientFixture();
 try{
 const result=await f.client.run(submitted.submitted.answer,'',true,undefined,{identity});
 assert.deepEqual(result.report.identity,identity);assert.equal(result.report.identity.revision,0);assert.equal(codeRunSuccess(result,'trial').kind,'trial');
 assert.equal(session.snapshot().submitted.answerRevision,0);assert.equal(session.snapshot().submitted.answer,'');
 }finally{f.client.dispose();}
});

test('review round2: actual Pyodide retains coherent unknown report and raw output after caught checks',async()=>{
 const f=await realClientFixture();
 try{
 for(const [testCode,executed,passed] of [
 ['try:\n assert False\nexcept AssertionError:\n pass\nassert True\nprint("caught-check-output")',2,1],
 ['try:\n assert missing_fixture()\nexcept NameError:\n pass\nassert True\nprint("caught-check-output")',2,1],
 ['def check():\n try:\n  assert False\n except AssertionError:\n  pass\ncheck()\nprint("caught-check-output")',1,0],
 ])await assert.rejects(f.client.run('pass','',true,testCode),error=>{
 assert.equal(error.name,'PythonError');assert.equal(codeRunFailure(error).kind,'unknown');assert.equal(error.report.status,'failed');assert.equal(error.report.phase,'tests');assert.equal(error.report.assertionsExecuted,executed);assert.equal(error.report.assertionsPassed,passed);assert.equal(error.report.exception,undefined);assert.equal(error.report.firstFailure,undefined);assert.match(error.message,/caught-check-output/);assert.equal(f.messages.at(-1).output,'caught-check-output\n');return true;
 });
 const code="events=[]\ndef observe():\n events.append('condition')\n return False\ndef message():\n events.append('message')\n return 'expected failure'";
 await assert.rejects(f.client.run(code,'',true,"try:\n assert observe(), message()\nexcept AssertionError:\n pass\nassert events == ['condition', 'message'], missing_message()"),error=>{assert.equal(codeRunFailure(error).kind,'unknown');assert.equal(error.report.assertionsExecuted,2);assert.equal(error.report.assertionsPassed,1);return true;});
 }finally{f.client.dispose();}
});
