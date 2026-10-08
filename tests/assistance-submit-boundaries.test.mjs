import assert from 'node:assert/strict';
import test from 'node:test';
import {tsxFunction} from './fixtures/tsx-functions.mjs';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {waitForRecallResult,recallResultRating} from '../app/recall-flow-model.ts';
import {validateRecallModelEvaluation,recallEvaluationNotice} from '../app/recall-evaluation.ts';
import {codeRunFailure} from '../src/domain/remediation/index.ts';
const noop=()=>{};
function observer(){const value=createLearningDraftStore().adapter('item','mode').assistance;value.cover();return value;}
test('the first quiz selection freezes pre-help before its wrong-answer retry phase',()=>{
  const assistance=observer();tsxFunction(new URL('../app/plugins/plugin-quiz.tsx',import.meta.url),'handleSelect',{assistance,quizState:'guessing',data:{answer:'right'},firstWrong:'',setFirstWrong:noop,setSelectedOption:noop,setFeedbackDisplayId:noop,setQuizState:noop,setFailedOnce:noop,failedOnce:false})('wrong');
  assistance.shown('ai-hint','retry-hint');assert.deepEqual(assistance.snapshot().postSubmitFeedback,[{action:'ai-hint',count:1}]);
});
test('nonempty recall submission freezes before asynchronous grading returns',async()=>{
  const assistance=observer(),results=[];const submit=tsxFunction(new URL('../app/plugin-recall.tsx',import.meta.url),'submitRecall',{nonWord:undefined,submitLock:{current:false},setPendingReview:noop,contentChanged:false,identity:'one',currentIdentity:{current:'one'},criteria:[],quality:{capabilities:{canAutoAssess:true}},setDisputed:noop,validateRecallModelEvaluation,recallEvaluationNotice,request:{current:null},saveLock:{current:false},live:{current:true},focusFeedback:{current:false},waitForRecallResult,recallResultRating,setSelectedRating:noop,policy:{ready:true,pending:false},support:undefined,assistance,answer:'my answer',submitting:false,setSubmitting:noop,setFallbackNotice:noop,data:{},reference:'reference',context:{gradeRecall:async()=>({source:'ai',verdict:'correct',rating:'good',feedback:'feedback'})},setFeedbackDisplayId:noop,setResult:value=>results.push(value),setRevealed:noop,fallback:()=>assert.fail('unexpected fallback')});
  await submit();assert.equal(results[0].verdict,'correct');assistance.shown('ai-tutor','feedback-help');assert.deepEqual(assistance.snapshot().postSubmitFeedback,[{action:'ai-tutor',count:1}]);
});
test('calculation submission freezes before the authenticated grader is invoked',async()=>{
  const assistance=observer(),grades=[];const submit=tsxFunction(new URL('../app/plugin-calculation.tsx',import.meta.url),'handleSubmit',{active:{current:true},request:{current:null},identity:'one',currentIdentity:{current:'one'},assistance,value:'3',result:null,submitting:false,setSubmitting:noop,data:{prompt:'1+2'},context:{gradeCalculation:async()=>({verdict:'correct',correct:true,explanation:'ok'})},
    gradeCalculation:tsxFunction(new URL('../app/plugin-calculation.tsx',import.meta.url),'gradeCalculation',{}),setFeedbackDisplayId:noop,setResult:noop,onGrade:value=>grades.push(value)});
  await submit();assert.deepEqual(grades,['good']);assert.equal(assistance.shown('answer-feedback','result'),true);
});
test('the first actual code test marks submission but an unavailable runtime does not',async()=>{
  for(const isReady of [true,false]){const assistance=observer(),states=[];await tsxFunction(new URL('../app/plugins/plugin-code.tsx',import.meta.url),'handleRunTests',{assistance,isReady,isTesting:false,codeState:'coding',runEpoch:{current:0},setPanel:noop,setResultKind:noop,setElapsed:noop,code:'pass',data:{testCode:'assert True'},firstOutput:'',setFirstCode:noop,setFirstOutput:noop,codeRunFailure,setIsTesting:noop,setTestOutput:noop,setTestOutputId:noop,runPython:async()=>({output:'ok',assertionsPassed:1}),setCodeState:value=>states.push(value),setFailedOnce:noop})();
    assert.deepEqual(states,isReady?['passed']:[]);assert.equal(assistance.shown('answer-feedback','execution'),isReady);}
});
test('an empty recall or calculation submit does not manufacture an attempt boundary',async()=>{
  for(const [path,name,value] of [['plugin-recall.tsx','submitRecall',{answer:''}],['plugin-calculation.tsx','handleSubmit',{value:''}]]){
    const assistance=observer();await tsxFunction(new URL('../app/'+path,import.meta.url),name,{assistance,...value,submitting:false})();
    assert.equal(assistance.shown('answer-feedback','invalid-empty'),false);
  }
});
