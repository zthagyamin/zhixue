import test from 'node:test';
import assert from 'node:assert/strict';
import {createMappedMathVariant,parseMathVariantMapping,createMathVariant,evaluateMathVariant} from '../src/domain/guided-math/index.ts';

const parent={parentItemKey:'synthetic-source',parentContentHash:'a'.repeat(64),hashKind:'content'};
const support={schemaVersion:2,type:'calculation',mode:'numeric',variables:[],domain:'real',variantMappingId:'source-map-1'};
const mapping=(templateId,parameters)=>({schemaVersion:1,mappingId:'source-map-1',...parent,templateVersion:1,templateId,
 sourceConditions:['原资料已核验此条件和模板关系。'],parameters});
const cases=[['cancel-domain',{k:2,nonzero:0},'not-allowed',''],['sqrt-sign',{x:-2},'number','2'],
 ['context-linear',{rate:2,baseline:2,target:12},'number','5'],['inverse-linear',{x:2,b:3,y:10},'number','7/2']];

for(const [templateId,parameters,answerKind,answer] of cases)test(`approved mapping rebuilds ${templateId} with exact parent, seed and template identity`,async()=>{
 const trusted=mapping(templateId,parameters),seed=91;
 assert.deepEqual(parseMathVariantMapping(trusted),trusted);
 const result=await createMappedMathVariant({parent,support,mapping:trusted,seed});assert.equal(result.status,'available');
 assert.equal(result.mappingId,trusted.mappingId);assert.deepEqual(result.sourceConditions,trusted.sourceConditions);
 assert.deepEqual(result.variant,await createMathVariant({parent,templateId,parameters,seed}));
 assert.equal(evaluateMathVariant(result.variant,{answerKind,answer}).final.verdict,'correct');
 const restored=await createMappedMathVariant({parent:result.variant.parent,support,mapping:trusted,seed:result.variant.seed});
 assert.deepEqual(restored,result);
 const changed=await createMappedMathVariant({parent,support,mapping:trusted,seed:seed+1});
 assert.equal(changed.variant.exposureKey,result.variant.exposureKey);assert.notEqual(changed.variant.variantHash,result.variant.variantHash);
});
test('no mapping, mismatched scope and invalid seed cannot fabricate a related variant',async()=>{
 const trusted=mapping('sqrt-sign',{x:-2});
 for(const patch of [{mapping:undefined},{support:{...support,variantMappingId:undefined}},
  {support:{...support,variantMappingId:'another'}},{parent:{...parent,parentItemKey:'other'}},
  {parent:{...parent,parentContentHash:'b'.repeat(64)}},{parent:{...parent,hashKind:'visible-snapshot'}},
  {seed:-1},{seed:2**32},{seed:1.2}]){
  const result=await createMappedMathVariant({parent,support,mapping:trusted,seed:5,...patch});assert.equal(result.status,'unavailable');
  assert.equal(result.variant,undefined);
 }
});
test('mapping parser rejects unsupported versions/templates, unbounded conditions and caller supplied answers',async()=>{
 const trusted=mapping('sqrt-sign',{x:-2});
 for(const patch of [{schemaVersion:2},{templateVersion:2},{templateId:'topic-guess'},{parameters:{x:10}},
  {parameters:{x:-2,answer:2}},{definition:{answer:'pretend'}},{mappingId:'bad id'},
  {sourceConditions:['same',' same ']},{sourceConditions:['']},{sourceConditions:['a'.repeat(301)]},
  {sourceConditions:Array(9).fill('same')},{sourceConditions:undefined},{hashKind:'legacy'}]){
  assert.throws(()=>parseMathVariantMapping({...trusted,...patch}));
  assert.equal((await createMappedMathVariant({parent,support,mapping:{...trusted,...patch},seed:5})).status,'unavailable');
 }
 for(const [templateId,parameters] of [['cancel-domain',{k:0,nonzero:2}],['context-linear',{rate:0,baseline:0,target:12}],
  ['inverse-linear',{x:2,b:3,y:21}],['sqrt-sign',{x:-2,extra:1}]])assert.throws(()=>parseMathVariantMapping(mapping(templateId,parameters)));
});
