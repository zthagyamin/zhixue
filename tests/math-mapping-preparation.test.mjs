import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMathMappingPreparation,validateMathMappingPreparation} from '../src/domain/guided-math/index.ts';
import {reviewedCases,reviewedSource} from './fixtures/math-mapping-fixtures.mjs';

for(const example of reviewedCases)test(`preparation binds reviewed synthetic ${example.templateId} original without inferring teaching quality`,()=>{
 const {item,preparation}=reviewedSource(example);
 assert.deepEqual(validateMathMappingPreparation(preparation,item),preparation);
 assert.deepEqual(parseMathMappingPreparation(preparation),preparation);
 assert.deepEqual(validateMathMappingPreparation(preparation,{...item,learningSupport:{...item.learningSupport,conditions:item.learningSupport.conditions.map(x=>`  ${x.toUpperCase()}  `)}}),preparation);
});
test('preparation rejects missing review, fabricated quotes, unsupported source, conditions and closed-protocol extras',()=>{
 const {item,preparation:p}=reviewedSource(reviewedCases[0]);
 for(const patch of [{review:undefined},{review:{sourceQuote:'',rationale:'reviewed'}},{review:{...p.review,sourceQuote:'not present'}},
  {review:{...p.review,rationale:''}},{review:{...p.review,approved:true}},{review:{...p.review,rationale:'a'.repeat(2001)}},
  {approved:true},{snapshotId:''},{schemaVersion:2},{mapping:{...p.mapping,hashKind:'visible-snapshot'}},
  {mapping:{...p.mapping,sourceConditions:['unrelated']}},{mapping:{...p.mapping,parentItemKey:'another'}},
  {mapping:{...p.mapping,parentContentHash:'b'.repeat(64)}},{mapping:{...p.mapping,parameters:{k:0,nonzero:2}}}])
  assert.throws(()=>validateMathMappingPreparation({...p,...patch},item));
 for(const source of [null,{...item,kind:'word'},{...item,practice:{...item.practice,questionType:'recall'}},
  {...item,practice:{...item.practice,prompt:''}},{...item,learningSupport:{...item.learningSupport,schemaVersion:1}},
  {...item,learningSupport:{...item.learningSupport,variantMappingId:'other'}},
  {...item,learningSupport:{...item.learningSupport,conditions:undefined}},
  {...item,learningSupport:{...item.learningSupport,conditions:[]}}])assert.throws(()=>validateMathMappingPreparation(p,source));
});
