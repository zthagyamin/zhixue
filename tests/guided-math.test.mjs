import assert from 'node:assert/strict';
import test from 'node:test';
import {createMathVariant,evaluateMathVariant,acceptLegacyReview,assertSeparatedFamilies} from '../src/domain/guided-math/index.ts';

const parent={parentItemKey:'synthetic-parent',parentContentHash:'source-v1',hashKind:'content'};
const variant=(templateId,parameters,seed=7)=>createMathVariant({parent,templateId,seed,parameters});

test('VR-01 deterministic parameters and identity bind version, seed and actual parent',async()=>{
 const first=await variant('inverse-linear',{x:2,b:3,y:10});
 assert.deepEqual(first,await variant('inverse-linear',{x:2,b:3,y:10}));
 assert.notEqual(first.variantHash,(await variant('inverse-linear',{x:2,b:3,y:10},8)).variantHash);
 const other=await createMathVariant({parent:{...parent,parentContentHash:'v2'},templateId:'inverse-linear',seed:7,parameters:{x:2,b:3,y:10}});
 assert.notEqual(first.variantHash,other.variantHash);assert.equal(first.templateVersion,1);
 assert.equal(evaluateMathVariant(first,{answerKind:'number',answer:'7/2'}).final.verdict,'correct');
});
test('VR-02/03 zero coefficient distinguishes inconsistent and indeterminate equations',async()=>{
 for(const [y,kind] of [[3,'all'],[4,'none']]){
  const item=await variant('inverse-linear',{x:0,b:3,y});
  assert.equal(evaluateMathVariant(item,{answerKind:kind,answer:''}).final.verdict,'correct');
  assert.equal(evaluateMathVariant(item,{answerKind:'number',answer:'0'}).final.verdict,'wrong');
 }
 await assert.rejects(variant('context-linear',{rate:0,baseline:2,target:5}),/parameters/);
 await assert.rejects(variant('inverse-linear',{x:99,b:0,y:1}),/parameters/);
 await assert.rejects(variant('inverse-linear',{x:1,b:0,y:1,extra:1}),/parameters/);
});
test('MS-01/04 a matching final answer never hides illegal cancellation at zero',async()=>{
 const item=await variant('cancel-domain',{k:2,nonzero:0});
 const checked=evaluateMathVariant(item,{answerKind:'not-allowed',answer:'',method:'divide',condition:'nonzero',transformation:'x^2-2*x'},true);
 assert.equal(checked.final.verdict,'correct');assert.equal(checked.steps.verdict,'wrong');
 const allowed=await variant('cancel-domain',{k:0,nonzero:1});
 assert.equal(evaluateMathVariant(allowed,{answerKind:'allowed',answer:'',method:'divide',condition:'nonzero',transformation:'x*x'},true).steps.verdict,'correct');
});
test('MS-02/03 square-root sign rule is explicit and unsupported symbolic syntax abstains',async()=>{
 const item=await variant('sqrt-sign',{x:-2});
 assert.equal(evaluateMathVariant(item,{answerKind:'number',answer:'2',method:'principal-root',condition:'negative',transformation:'0-x'},true).steps.verdict,'correct');
 assert.equal(evaluateMathVariant(item,{answerKind:'number',answer:'2',method:'principal-root',condition:'negative',transformation:'x'},true).steps.verdict,'wrong');
 assert.equal(evaluateMathVariant(item,{answerKind:'number',answer:'sqrt(x^2)'}).final.verdict,'unknown');
 assert.equal(evaluateMathVariant(item,{answerKind:'number',answer:'2',method:'principal-root',condition:'negative',transformation:'abs(x)'},true).steps.verdict,'unknown');
 assert.equal(evaluateMathVariant(item,{answerKind:'number',answer:'2',method:'unsupported-proof',condition:'custom-domain',transformation:'-x'},true).steps.verdict,'unknown');
 assert.equal(evaluateMathVariant(item,{answerKind:'number',answer:'2'}).steps,null);
});
test('VR-04 old presentation retries cannot change semantic content or its identity',()=>{
 const source={itemId:'a',fingerprint:'v1',questionType:'quiz',prompt:'Choose A',options:['A','B'],answer:0};
 assert.equal(acceptLegacyReview(source,{...source,options:['B','A'],answer:1}).kind,'reordered-review');
 assert.throws(()=>acceptLegacyReview(source,{...source,answer:1}),/legacy-review/);
 assert.throws(()=>acceptLegacyReview(source,{...source,itemId:'b'}),/legacy-review/);
 const calc={itemId:'c',questionType:'calculation',prompt:'2+2',answer:'4'};
 assert.throws(()=>acceptLegacyReview(calc,{...calc,prompt:'2+2（数值 ×2）',answer:'8'}),/legacy-review/);
 assert.deepEqual(acceptLegacyReview(calc,{...calc}).item,calc);
});
test('degenerate boundaries accept all mathematically valid listed methods',async()=>{
 const item=await variant('context-linear',{rate:2,baseline:0,target:12});
 assert.equal(evaluateMathVariant(item,{answerKind:'number',answer:'6',method:'divide-total',condition:'positive-rate',transformation:'12/2'},true).steps.verdict,'correct');
 const cancel=await variant('cancel-domain',{k:2,nonzero:1});
 assert.equal(evaluateMathVariant(cancel,{answerKind:'allowed',answer:'',method:'split-zero',condition:'nonzero',transformation:'x^2-2*x'},true).steps.verdict,'correct');
});
test('VR-06 different seeds of one family cannot leak across development and holdout',()=>{
 assert.throws(()=>assertSeparatedFamilies([{familyKey:'linear',parentItemKey:'a',split:'development'},{familyKey:'linear',parentItemKey:'b',split:'holdout'}]),/family-overlap/);
 assert.throws(()=>assertSeparatedFamilies([{familyKey:'linear',parentItemKey:'a',split:'development'},{familyKey:'sqrt',parentItemKey:'a',split:'holdout'}]),/parent-overlap/);
 assert.doesNotThrow(()=>assertSeparatedFamilies([{familyKey:'linear',parentItemKey:'a',split:'development'},{familyKey:'sqrt',parentItemKey:'b',split:'holdout'}]));
});
