import assert from 'node:assert/strict';
import test from 'node:test';
import {tsxFunction} from './fixtures/tsx-functions.mjs';
const file=new URL('../app/plugins/tutor-follow-up.tsx',import.meta.url);
test('empty or malformed Tutor success preserves previous reply and produces no new display identity',async()=>{
  for(const result of [undefined,{},'   ']){let answer='previous reply',error='',identity=null;
    await tsxFunction(file,'ask',{question:'question',loading:false,requestBusy:{current:false},questionRevision:{current:0},item:{},askTutor:async()=>result,
      setLoading(){},setError:value=>error=value,setAnswer:value=>answer=value,setAnswerDisplayId:value=>identity=value,setQuestion(){}})();
    assert.equal(answer,'previous reply');assert.equal(identity,null);assert.match(error,/返回|重试/);
  }
});
test('a valid Tutor reply gets a distinct reusable display identity without storing that ID as content',async()=>{
  let answer='',identity='';await tsxFunction(file,'ask',{question:'question',loading:false,requestBusy:{current:false},questionRevision:{current:0},item:{},askTutor:async()=> 'guided reply',
    setLoading(){},setError(){},setAnswer:value=>answer=value,setAnswerDisplayId:value=>identity=value,setQuestion(){}})();
  assert.equal(answer,'guided reply');assert.match(identity,/^[a-f0-9-]{36}$/);
});
