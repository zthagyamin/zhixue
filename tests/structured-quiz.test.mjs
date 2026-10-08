import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {tsxFunction} from './fixtures/tsx-functions.mjs';
const file=new URL('../app/plugins/structured-quiz.tsx',import.meta.url);
const support={schemaVersion:1,type:'quiz',selection:'multiple',options:[{optionId:'a',text:'First'},{optionId:'b',text:'Second'},{optionId:'c',text:'Third',trapType:'reverse_causality',trapExplanation:'The direction is reversed.'}],correctOptionIds:['a','b']};
const data={topic:'fixture',prompt:'Choose the supported claims.',explanation:'Source explanation.',learningSupport:support};
function markup(values={}){const {StructuredQuiz}=loadTsx(file);return renderToStaticMarkup(createElement(StructuredQuiz,{data,onGrade(){},context:{draft:{read:(field,fallback)=>Object.hasOwn(values,field)?values[field]:fallback,write(){}}}}));}
test('new quiz keeps answers and diagnostic labels hidden until submission',()=>{
 const before=markup({quizSelectedIds:['c']});assert.doesNotMatch(before,/因果倒置|The direction|正确选项：|Source explanation/);assert.match(before,/提交答案/);
 const after=markup({quizSelectedIds:['c'],quizSubmitted:true});assert.match(after,/因果倒置/);assert.match(after,/The direction is reversed/);assert.match(after,/这次需要复习/);
});
test('submit and grade callbacks are bounded to one explicit submission',()=>{
 let submissions=0,visible=false;const submittedRef={current:false};const env={submittedRef,selectedIds:['a'],assistance:{submit:()=>submissions++},setFeedbackId(){},setSubmitted:v=>visible=v,crypto:{randomUUID:()=> 'feedback'}};
 const submit=tsxFunction(file,'submit',env);submit();submit();assert.equal(submissions,1);assert.equal(visible,true);
 const grades=[],gradedRef={current:false};const finish=tsxFunction(file,'finish',{submitted:true,gradedRef,setGraded(){},onGrade:r=>grades.push(r),correct:false});finish();finish();assert.deepEqual(grades,['again']);
});
test('exclude removes selection, reselect removes exclusion, and submitted answers freeze',()=>{
 let selected=['a'],excluded=[];const submittedRef={current:false},env={submittedRef,support,invalidateHint(){},setSelected:f=>selected=f(selected),setExcluded:f=>excluded=f(excluded)};
 tsxFunction(file,'exclude',env)('a');assert.deepEqual(selected,[]);assert.deepEqual(excluded,['a']);
 tsxFunction(file,'toggle',env)('a');assert.deepEqual(selected,['a']);assert.deepEqual(excluded,[]);
 submittedRef.current=true;tsxFunction(file,'toggle',env)('b');assert.deepEqual(selected,['a']);
});
test('changing selections clears visible hints and rejects delayed hint responses',async()=>{
 let resolve,hint='old hint',hintId='old',error='',loading=false;const selectionRevision={current:0},submittedRef={current:false},mounted={current:true};
 const env={selectionRevision,submittedRef,mounted,loading:false,reference:data,selectedIds:['a'],setLoading:v=>loading=v,setError:v=>error=v,setHint:v=>hint=v,setHintId:v=>hintId=v,context:{requestAiHint:()=>new Promise(done=>resolve=done)},crypto:{randomUUID:()=> 'new'},accountAiFailureMessage:()=> 'error'};
 const pending=tsxFunction(file,'requestHint',env)();
 tsxFunction(file,'invalidateHint',env)();assert.equal(hint,'');assert.equal(hintId,null);
 resolve('Hint about old selection');await pending;assert.equal(hint,'');assert.equal(hintId,null);assert.equal(error,'');assert.equal(loading,false);
});

