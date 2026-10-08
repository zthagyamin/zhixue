import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {adaptStudyItemForPlugin} from '../app/plugin-routing.ts';
const {PluginContentBoundary}=loadTsx(new URL('../app/plugin-content-boundary.tsx',import.meta.url));
const {validatePluginData:validate}=loadTsx(new URL('../app/study-dashboard/prelude.ts',import.meta.url));
function boundary(mode,data,context,View=()=>createElement('p',null,'VALID CONTENT')){let grades=0;const html=renderToStaticMarkup(createElement(PluginContentBoundary,{mode,data,context,View,onGrade:()=>grades++}));return{html,grades};}
test('display validation admits structured quiz and numeric zero; quality boundary remains authoritative',()=>{
 for(const item of [{prompt:'选择答案',answer:0,options:['零','一']},{prompt:'选择所有正确项',learningSupport:{type:'quiz'}}])assert.equal(validate('quiz',item),null);
 assert.equal(validate('flashcard',{front:'结果',back:0}),null);assert.equal(validate('code',{prompt:'写一个函数'}),null);
 assert.match(validate('recall',{}),/缺少题干/);
});
test('bad configuration and ambiguous quiz get a visible ungraded skip before implementation loads',()=>{
 const cases=[['recall',{prompt:'解释',answer:'定义',learningSupport:{schemaVersion:999,type:'recall'}}],['quiz',{prompt:'选择',options:['相同','相同'],answer:0}]];
 for(const [mode,data] of cases){
  const result=boundary(mode,data,{contentNavigation:{onSkip(){}}});assert.match(result.html,/本题暂不计入成绩/);assert.match(result.html,/暂时跳过，不计成绩/);assert.equal(result.grades,0);assert.doesNotMatch(result.html,/VALID CONTENT/);
 }
});
test('switching a question-only source to a flashcard cannot manufacture a reference',()=>{
 const result=boundary('flashcard',{front:'为什么？',back:'为什么？'},{contentSource:{mode:'recall',data:{prompt:'为什么？',answer:'为什么？'}},contentNavigation:{onSkip(){}}});assert.match(result.html,/本题暂不计入成绩/);assert.equal(result.grades,0);
});
test('zero flashcard references and visible React text remain valid',()=>{
 for(const back of [0,createElement('span',null,'有依据的回答')])assert.match(boundary('flashcard',{front:'结果是多少？',back}).html,/VALID CONTENT/);
});

test('word sources with recall or flashcard recommendation retain their valid reference in every compatible view',()=>{
 const word={word:'Tree',meaning:'树',context:'植物',example:'A tree grows here.'};
 for(const sourceMode of ['recall','flashcard'])for(const mode of ['recall','flashcard','spelling']){
  const result=boundary(mode,adaptStudyItemForPlugin(mode,word),{contentSource:{mode:sourceMode,data:word}});
  assert.match(result.html,/VALID CONTENT/,sourceMode+' -> '+mode);
 }
});
test('legacy flashcards use supplied explanation or review point, while explicit empty backs remain blocked',()=>{
 for(const source of [{prompt:'Question',answer:'',explanation:'Valid reference'},{prompt:'Question',reviewPoint:'Valid reference'}]){
  assert.match(boundary('flashcard',{front:source.prompt,back:'Valid reference'},{contentSource:{mode:'flashcard',data:source}}).html,/VALID CONTENT/);
 }
 assert.match(boundary('flashcard',{front:'Question',back:'',explanation:'Hidden reference'}).html,/本题暂不计入成绩/);
});
test('code without tests remains available for trial, but cannot claim automatic pass',()=>{
 const data={prompt:'写一个函数',initialCode:'pass',testCode:'',explanation:'参考解释'};
 const result=boundary('code',data,undefined,props=>{props.onGrade('good');props.onGrade('again');return createElement('p',null,'TRIAL ONLY');});assert.match(result.html,/TRIAL ONLY/);assert.equal(result.grades,0);
});
test('paper rendering never creates a grade',()=>{
 const result=boundary('paper',{paper:{}},undefined,props=>{props.onGrade('good');return createElement('p',null,'READ ONLY');});assert.equal(result.grades,0);assert.match(result.html,/READ ONLY/);
});
test('inline unsupported typed content offers ungraded skip instead of fallback grading buttons',()=>{
 const {PracticeSession}=loadTsx(new URL('../app/practice-session.tsx',import.meta.url));
 for(const questionType of ['quiz','code','three-stage']){
  const item={itemId:'invalid',fingerprint:'v1',questionType,prompt:'配置缺失的题目',sourceLabel:'合成材料'};
  const html=renderToStaticMarkup(createElement(PracticeSession,{items:[item]}));
  assert.match(html,/本题暂不计入成绩/);assert.match(html,/暂时跳过，不计成绩/);
  assert.doesNotMatch(html,/>记得<|>不记得</);
 }
});

test('unfocused material stays readable with no grading UI even after switching to flashcards',()=>{
 const source={prompt:'请闭卷回忆「材料标题」的核心要点，并说明相关概念、依据或适用条件。',answer:'原始参考内容',sourceLabel:'材料标题'};
 const result=boundary('flashcard',{front:source.prompt,back:source.answer},{contentSource:{mode:'recall',data:source},contentNavigation:{onSkip(){}}});
 assert.match(result.html,/待补具体问题/);assert.match(result.html,/原始参考内容/);assert.match(result.html,/下一项，不计成绩/);
 assert.doesNotMatch(result.html,/VALID CONTENT|记住了|不记得|提交并核对/);assert.equal(result.grades,0);
});

test('reading-only material retains the original rubric and full-hint reference',()=>{
 const source={prompt:'请闭卷回忆「材料标题」的核心要点，并说明相关概念、依据或适用条件。',learningSupport:{schemaVersion:1,type:'recall',criteria:[{id:'one',text:'原文判据仍保留'}],hints:['方向','结构','原始完整参考仍保留']}};
 const result=boundary('recall',source,{contentSource:{mode:'recall',data:source}});
 assert.match(result.html,/待补具体问题/);assert.match(result.html,/原始完整参考仍保留/);assert.equal(result.grades,0);
 const rubricOnly={...source,learningSupport:{schemaVersion:1,type:'recall',criteria:source.learningSupport.criteria}};
 assert.match(boundary('recall',rubricOnly,{contentSource:{mode:'recall',data:rubricOnly}}).html,/原文判据仍保留/);
});

test('migrated objective keeps its literal note in the reading-only view',()=>{
 const data={prompt:'请闭卷回答：区分甲与乙。',reviewPoint:'区分甲与乙',answer:'区分甲与乙',explanation:'区分甲与乙',sourceLabel:'方法对比'};
 const result=boundary('recall',data,{});
 assert.match(result.html,/待补具体问题/);assert.match(result.html,/区分甲与乙/);assert.match(result.html,/查看原始摘记/);assert.equal(result.grades,0);
});
