import assert from 'node:assert/strict';
import test from 'node:test';
import {tsxHandler} from './fixtures/tsx-handlers.mjs';
import {accountAiFailureMessage} from '../app/account-study-runtime.ts';
test('calculation transport failure is unknown, never reported as a wrong answer or graded',async()=>{
  let result,graded=false;
  const submit=tsxHandler(new URL('../app/plugin-calculation.tsx',import.meta.url),'handleSubmit',{active:{current:true},request:{current:null},identity:'one',currentIdentity:{current:'one'},assistance:undefined,value:'3',submitting:false,result:null,data:{},context:{},setSubmitting(){},setFeedbackDisplayId(){},setResult:value=>result=value,onGrade:()=>graded=true,gradeCalculation:async()=>{throw new Error('连接暂不可用');}});
  await submit();assert.equal(graded,false);assert.equal(result.correct,null);assert.match(result.explanation,/连接暂不可用/);
});
test('unknown verdict and cancelled late result never grade a calculation',async()=>{
 for(const cancelled of [false,true]){let graded=false,result;const request={current:null};const submit=tsxHandler(new URL('../app/plugin-calculation.tsx',import.meta.url),'handleSubmit',{active:{current:true},request,identity:'one',currentIdentity:{current:'one'},assistance:undefined,value:'x/x',submitting:false,result:null,data:{},context:{},setSubmitting(){},setFeedbackDisplayId(){},setResult:value=>result=value,onGrade:()=>graded=true,gradeCalculation:async()=>{if(cancelled)request.current.abort();return{verdict:cancelled?'correct':'unknown',explanation:'无法判定'};}});await submit();assert.equal(graded,false);if(cancelled)assert.equal(result,undefined);else assert.equal(result.correct,null);}
});
test('failed quiz AI request stays an error, not a successful hint or a grade',async()=>{
  let hint,error;
  const request=tsxHandler(new URL('../app/plugins/plugin-quiz.tsx',import.meta.url),'requestHint',{hintLoading:false,data:{},selectedOption:'A',setHintLoading(){},setHintText:value=>hint=value,setHintError:value=>error=value,accountAiFailureMessage,context:{requestAiHint:async()=>{throw new Error('study-service-unavailable');}}});
  await request();assert.equal(hint,undefined);assert.match(error,/暂不可用/);assert.doesNotMatch(error,/study-service-unavailable/);
});
