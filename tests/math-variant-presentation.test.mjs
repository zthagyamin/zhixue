import test from 'node:test';
import assert from 'node:assert/strict';
import katex from 'katex';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {splitMathSegments} from '../app/math-segments.ts';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {createMathVariant,evaluateMathVariant} from '../src/domain/guided-math/index.ts';
import {presentMathVariant,formatVariantMathFeedback} from '../src/features/calculation-study/variant-math.ts';

const {MathText}=loadTsx(new URL('../app/math-text.tsx',import.meta.url));
const parent={parentItemKey:'synthetic:math',parentContentHash:'a'.repeat(64),hashKind:'content'};
const cases=[
 ['cancel-domain',{k:-8,nonzero:0}],['cancel-domain',{k:0,nonzero:0}],['cancel-domain',{k:8,nonzero:1}],
 ['sqrt-sign',{x:-9}],['sqrt-sign',{x:0}],['sqrt-sign',{x:9}],
 ['context-linear',{rate:1,baseline:12,target:12}],['context-linear',{rate:8,baseline:0,target:40}],
 ['context-linear',{rate:8,baseline:12,target:13}],
 ['inverse-linear',{x:-8,b:12,y:-20}],['inverse-linear',{x:8,b:-12,y:20}],
 ['inverse-linear',{x:0,b:12,y:13}],['inverse-linear',{x:0,b:-12,y:-12}],
];
function freeze(value){
 if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;
}
function formulaMarkup(text){
 const formulas=splitMathSegments(text).filter(segment=>segment.type!=='text');
 assert.ok(formulas.length>0,`Expected formula segments in: ${text}`);
 for(const segment of formulas){
  const html=katex.renderToString(segment.value,{displayMode:segment.type==='block',throwOnError:true,output:'html'});
  assert.doesNotMatch(html,/katex-error/);
 }
 const markup=renderToStaticMarkup(createElement(MathText,{text}));
 assert.match(markup,/class="katex"/);assert.doesNotMatch(markup,/katex-error/);
 return formulas.map(segment=>segment.value).join(' ');
}
for(const [templateId,parameters] of cases)test(`display-only ${templateId} ${JSON.stringify(parameters)} renders real prompt/domain/reference mathematics`,async()=>{
 const variant=freeze(await createMathVariant({parent,templateId,parameters,seed:4294967295})),before=JSON.stringify(variant);
 const answer={answerKind:variant.definition.answerKind,answer:variant.definition.answer};
 const grade=evaluateMathVariant(variant,answer),shown=presentMathVariant(variant);
 assert.deepEqual(Object.keys(shown).sort(),['domain','prompt','reference']);
 for(const field of ['prompt','domain','reference'])formulaMarkup(shown[field]);
 assert.equal(JSON.stringify(variant),before);assert.deepEqual(evaluateMathVariant(variant,answer),grade);
 assert.equal(grade.final.verdict,'correct');
 assert.match(shown.prompt,/实数|理想化记录模型/);
 if(templateId==='cancel-domain'){
  assert.match(shown.prompt,new RegExp(`\\(${parameters.k}\\)`));
  assert.match(shown.reference,parameters.nonzero?/变形合法不等于原等式一定有解/:/先区分/);
  assert.match(formulaMarkup(shown.domain),parameters.nonzero?/\\ne 0/:/\\mathbb\{R\}/);
 }
 if(templateId==='sqrt-sign'){
  assert.match(formulaMarkup(shown.prompt),/\\sqrt\{x\^\{2\}\}/);
  assert.match(formulaMarkup(shown.reference),/\\lvert x\\rvert/);
  assert.match(shown.reference,/这不是对任意变量根式的自动证明/);
  assert.match(formulaMarkup(shown.reference),parameters.x<0?/-x/:/x \\ge 0/);
 }
 if(templateId==='context-linear'){
  assert.ok(formulaMarkup(shown.reference).includes(`\\frac{${parameters.target}-${parameters.baseline}}{${parameters.rate}}`));
  assert.match(shown.prompt,/变化率保持不变.*时间允许是分数/);
  assert.match(shown.reference,/这里只讨论题目明确给定的理想模型/);
 }
 if(templateId==='inverse-linear'){
  if(parameters.x===0)assert.match(shown.reference,parameters.y===parameters.b?/任意实数.*不能唯一确定/:/条件矛盾，无解/);
  else assert.ok(formulaMarkup(shown.reference).includes(`\\frac{(${parameters.y-parameters.b})}{(${parameters.x})}`));
 }
});
test('unknown template/version/invalid parameters and customized original prose remain intact',async()=>{
 const variant=await createMathVariant({parent,templateId:'sqrt-sign',seed:0,parameters:{x:-2}});
 for(const patch of [{templateId:'future-template'},{templateVersion:2},{schemaVersion:2},{parameters:{x:100}},
  {schemaVersion:undefined,templateVersion:undefined,parameters:undefined},{parameters:undefined}]){
  const changed={...variant,...patch};assert.deepEqual(presentMathVariant(changed),{
   prompt:variant.definition.prompt,domain:variant.definition.domain,reference:variant.definition.reference});
  assert.equal(formatVariantMathFeedback(changed,variant.definition.reference),variant.definition.reference);
 }
 for(const text of ['Custom sqrt(x²) is not the canonical source.','`sqrt(x²)`','```text\nsqrt(x²)\n```','$\\sqrt{x^2}$','\\(\\sqrt{x^2}\\)']){
  const changed={...variant,definition:{...variant.definition,prompt:text,domain:text,reference:text}};
  assert.deepEqual(presentMathVariant(changed),{prompt:text,domain:text,reference:text});
 }
});
test('feedback projects only canonical known text and preserves code, existing latex and every prose suffix',async()=>{
 const variant=await createMathVariant({parent,templateId:'sqrt-sign',seed:0,parameters:{x:-2}}),source=variant.definition.reference;
 const protectedText=`\n\`\`\`text\n${source}\n\`\`\`\n\`${source}\`\n$\\sqrt{x^2}$\n\\(${source}\\)\n\\[${source}\\]`;
 const text=`首轮结论保持不变。\n${source}\n尾注：不推断掌握。${protectedText}`;
 const displayed=formatVariantMathFeedback(variant,text);
 assert.equal(displayed,`首轮结论保持不变。\n${presentMathVariant(variant).reference}\n尾注：不推断掌握。${protectedText}`);
 assert.equal(formatVariantMathFeedback(variant,displayed),displayed);
 assert.equal(formatVariantMathFeedback(variant,'陌生 sqrt(z^2) 或 (7-1)/3 仅作原文。'),'陌生 sqrt(z^2) 或 (7-1)/3 仅作原文。');
 assert.equal(formatVariantMathFeedback(variant,`~~~text\n${source}\n~~~`),`~~~text\n${source}\n~~~`);
 assert.equal(formatVariantMathFeedback(variant,`\`\`\`text\n${source}`),`\`\`\`text\n${source}`);
});

test('successful numeric variant feedback does not claim a general identity was checked',async()=>{
 const variant=await createMathVariant({parent,templateId:'sqrt-sign',seed:0,parameters:{x:-2}});
 const stored='在声明的实数域内，两式等价。',before=JSON.stringify(variant);
 assert.equal(formatVariantMathFeedback(variant,stored,true),'本题数值结果与参考一致。这里只核对当前取值，未验证对所有实数成立的恒等关系。');
 assert.equal(formatVariantMathFeedback(variant,stored,false),stored);
 assert.equal(formatVariantMathFeedback(variant,stored,null),stored);
 assert.equal(formatVariantMathFeedback(variant,stored),stored);
 assert.equal(formatVariantMathFeedback({...variant,templateVersion:2},stored,true),stored);
 assert.equal(JSON.stringify(variant),before);
 const linear=await createMathVariant({parent,templateId:'context-linear',seed:0,parameters:{rate:2,baseline:0,target:12}});
 assert.equal(formatVariantMathFeedback(linear,stored,true),'本题数值结果与参考一致。');
 assert.equal(formatVariantMathFeedback(variant,'`'+stored+'`',true),'`'+stored+'`');
});
