import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveCalculationReferenceSupport} from '../src/domain/math-study/index.ts';
import {numericEquivalent} from '../src/domain/math/index.ts';
import {support} from './fixtures/practice-evidence-fixtures.mjs';
test('source with no support receives only bounded numeric legacy compatibility',()=>{
 for(const reference of ['3',3,' -1.5 ','2e2','9007199254740993']){
  const resolved=resolveCalculationReferenceSupport(undefined,reference);assert.equal(resolved.mode,'numeric');assert.equal(resolved.schemaVersion,1);assert.deepEqual(resolved.variables,[]);assert.equal(resolved.step,undefined);assert.equal(resolved.variantMappingId,undefined);
  assert.equal(numericEquivalent(String(reference),String(reference),resolved.tolerance),true);
 }
});
test('legacy symbolic code infinite empty and absent references remain unsupported',()=>{
 for(const reference of [undefined,null,'','x+x','1+2','sqrt(4)','sin(x)','1e101','__import__("os")',Infinity,NaN,{},[],false])assert.equal(resolveCalculationReferenceSupport(undefined,reference),null);
});
test('explicit valid support is honored without guessing, malformed support never falls back to numeric',()=>{
 assert.deepEqual(resolveCalculationReferenceSupport(support,'3'),support);
 const symbolic={schemaVersion:1,type:'calculation',mode:'symbolic',variables:['x'],domain:'real'};assert.deepEqual(resolveCalculationReferenceSupport(symbolic,'x+x'),symbolic);
 for(const invalid of [null,{},false,[],{schemaVersion:3,type:'calculation'},{...symbolic,variables:['xx']},{...symbolic,type:'code'}])assert.equal(resolveCalculationReferenceSupport(invalid,'3'),null);
});
