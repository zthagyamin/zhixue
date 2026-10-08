import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
const file=new URL('../src/features/nonword-study/text.tsx',import.meta.url);
function render(text){const calls=[],{LearningFeedback}=loadTsx(file);assert.equal(typeof LearningFeedback,'function');const html=renderToStaticMarkup(createElement(LearningFeedback,{text,renderMath:value=>{calls.push(value);return createElement('span',null,value);}}));return{html,calls};}
const long='错选把观察结果当成了因果证据。对照题目条件，需要先核对独立变量与结论之间的关系，再排除没有得到来源支持的推断。'.repeat(30);
test('short feedback remains entirely visible with complete math rendering',()=>{const text='先保留条件，再应用 $x^2+2x+1=(x+1)^2$。';const out=render(text);assert.doesNotMatch(out.html,/<details/);assert.deepEqual(out.calls,[text]);assert.match(out.html,/先保留条件/);});
test('long feedback exposes actual explanation beyond its conclusion and preserves the complete original',()=>{const out=render('这次需要复习。\n\n'+long);const [visible,hidden]=out.html.split('<details');assert.match(visible,/错选把观察结果当成了因果证据/);assert.match(visible,/独立变量与结论/);assert.ok(visible.length<1000);assert.ok(hidden);assert.doesNotMatch(hidden,/ open(?:=|>)/);assert.ok(out.calls.includes('这次需要复习。\n\n'+long));});
test('a long prose excerpt is inert text, never a chopped fragment sent to renderMath',()=>{const text=long+'\n\n$$\\sum_{i=1}^{n} x_i^2$$';const out=render(text);assert.deepEqual(out.calls,[text]);assert.match(out.html.split('<details')[0],/错选把观察/);});
test('fenced code remains complete and is not mistaken for prose inside a blank code paragraph',()=>{const code='```python\nassert x < y\n\n'+('print("<script>")\n'.repeat(90))+'```',out=render(code+'\n\n'+long);const visible=out.html.split('<details')[0];assert.doesNotMatch(visible,/assert x|print/);assert.match(visible,/错选把观察/);assert.match(out.html,/assert x &lt; y/);assert.match(out.html,/&lt;script&gt;/);assert.doesNotMatch(out.html,/<script>/);assert.ok(out.calls.includes('\n\n'+long));});
test('all-math or all-code feedback stays fully readable instead of hiding every substantive detail',()=>{for(const text of ['$$'+('x_i+'.repeat(300))+'1$$','```python\n'+('assert x < y\n'.repeat(100))+'```']){const out=render(text);assert.doesNotMatch(out.html,/<details/);if(text.startsWith('$$'))assert.deepEqual(out.calls,[text]);else assert.match(out.html,/assert x &lt; y/);}});
test('malformed mathematical or fenced source remains preserved and safely readable',()=>{const text='```python\n'+('assert value > 0\n'.repeat(100));const out=render(text);assert.doesNotMatch(out.html,/<details/);assert.deepEqual(out.calls,[text]);assert.match(out.html,/assert value &gt; 0/);});
test('actual modern quiz uses readable disclosures for both wrong-option and question explanations',()=>{
 const {NonWordQuiz}=loadTsx(new URL('../src/features/nonword-study/quiz.tsx',import.meta.url));
 const data={prompt:'Choose the supported statement.',explanation:long,learningSupport:{schemaVersion:1,type:'quiz',selection:'single',options:[{optionId:'a',text:'Supported'},{optionId:'b',text:'Wrong',trapExplanation:long}],correctOptionIds:['a']}};
 const state={phase:'feedback',selection:['b'],first:{selection:['b'],result:{status:'incorrect',wrong:['b'],missing:['a']}}};
 const html=renderToStaticMarkup(createElement(NonWordQuiz,{data,state,setState(){},onGrade(){}})),visible=html.replace(/<details>[\s\S]*?<\/details>/g,'');
 assert.match(html,/查看完整选项解释/);assert.match(html,/查看完整解释/);assert.equal((visible.match(/解释摘录/g)||[]).length,2);assert.match(visible,/独立变量与结论/);assert.match(html,/完整参考答案/);
});

test('guided quiz feedback has one shared independent exit and does not offer a first-attempt retry or inert continue',()=>{
 const {NonWordQuiz}=loadTsx(new URL('../src/features/nonword-study/quiz.tsx',import.meta.url));
 const data={prompt:'Choose the supported statement.',options:['Supported','Wrong'],answer:'Supported',explanation:'Use the stated condition.'};
 const state={phase:'feedback',selection:['option-1'],first:{selection:['option-1'],result:{status:'incorrect',wrong:['option-1'],missing:['option-0']}}};
 const html=renderToStaticMarkup(createElement(NonWordQuiz,{data,state,setState(){},onGrade(){},lifecycle:{ready:true,purpose:'guided'}}));
 assert.match(html,/收起讲解后进入独立尝试/);assert.doesNotMatch(html,/收起解释，再试一次|跳过补练或结束补练，继续/);
});
