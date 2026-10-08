import test from 'node:test';
import assert from 'node:assert/strict';
import {tsxFunction} from './fixtures/tsx-functions.mjs';
import {codeRunFailure} from '../src/domain/remediation/index.ts';

const file=new URL('../app/plugins/plugin-code.tsx',import.meta.url);
function fixture(outcome){
  const state={failedOnce:false,codeState:'coding'},grades=[];
  const bindings={assistance:{submit(){}},isReady:true,isTesting:false,codeState:'coding',
    runEpoch:{current:0},code:'answer()',stdin:'',data:{testCode:'assert answer() == 1'},firstOutput:'',codeRunFailure,
    setPanel(){},setElapsed(){},setIsTesting(){},setTestOutputId(){},setFirstCode(){},setFirstOutput(){},
    setResultKind:value=>state.resultKind=value,setTestOutput:value=>state.output=value,
    setFailedOnce:value=>state.failedOnce=value,setCodeState:value=>state.codeState=value,
    runPython:async()=>{if(outcome instanceof Error)throw outcome;return outcome;}};
  return {state,run:tsxFunction(file,'handleRunTests',bindings),next:()=>tsxFunction(file,'handleNext',{
    isTesting:false,codeState:state.codeState,failedOnce:state.failedOnce,onGrade:rating=>grades.push(rating)})(),grades};
}
function failure(details){return Object.assign(new Error('synthetic failure'),details);}
for(const [name,details,kind] of [
  ['unknown test execution',{name:'PythonError',executionPhase:'tests'},'unknown'],
  ['unknown Python phase',{name:'PythonError'},'unknown'],
  ['broken test definition',{name:'PythonError',testDefinitionError:true},'test-error'],
  ['environment preparation',{name:'RuntimeError'},'environment-error'],
  ['cancelled run',{name:'AbortError'},'cancelled'],
  ['timeout',{name:'TimeoutError'},'timeout'],
])test(`${name} keeps the learner ungraded and does not poison later success`,async()=>{
  const f=fixture(failure(details));await f.run();
  assert.equal(f.state.failedOnce,false);assert.equal(f.state.codeState,'coding');assert.equal(f.state.resultKind,kind);
  f.next();assert.deepEqual(f.grades,[]);
  const success=fixture({output:'ok',assertionsPassed:2});await success.run();
  success.state.failedOnce=f.state.failedOnce;success.next();assert.deepEqual(success.grades,['good']);
});
for(const details of [{name:'PythonError',executionPhase:'program'},{name:'PythonError',executionPhase:'tests',assertionFailure:true}])
  test(`only attributed student failure (${details.executionPhase}) retains again after successful repair`,async()=>{
    const f=fixture(failure(details));await f.run();assert.equal(f.state.failedOnce,true);assert.equal(f.state.resultKind,'failed');
    f.state.codeState='passed';f.next();assert.deepEqual(f.grades,['again']);
  });
test('formal success names the provided public assertions without claiming broader correctness',async()=>{
  const f=fixture({output:'ok',assertionsPassed:2});await f.run();assert.match(f.state.output,/2 项公开断言/);assert.match(f.state.output,/只覆盖本次测试/);
});
