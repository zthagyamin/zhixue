import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseCalculationSupport} from '../src/domain/content/index.ts';

const v1={schemaVersion:1,type:'calculation',mode:'numeric',variables:[],domain:'real',tolerance:'0.000001'};
const step={stepId:'expand',prompt:'写出展开后的左侧表达式。',reference:'x^2-2*x',mode:'symbolic'};
const v2={...v1,schemaVersion:2,variables:['x'],conditions:['x 为实数'],units:'米',step,variantMappingId:'source-map-1'};
const fixture=JSON.parse(readFileSync(new URL('./fixtures/stage3-calculation-support.json',import.meta.url),'utf8'));

for(const row of fixture.supportCases)test(`shared support fixture: ${row.name}`,()=>{
 if(row.valid)assert.deepEqual(parseCalculationSupport(row.support),row.support);
 else assert.throws(()=>parseCalculationSupport(row.support));
});

test('V2 adds bounded source conditions, units, a distinct step and a mapping reference',()=>{
 assert.deepEqual(parseCalculationSupport(v2),v2);
 const parsed=parseCalculationSupport(v2);parsed.conditions.push('changed');parsed.step.reference='changed';
 assert.equal(v2.conditions.length,1);assert.equal(v2.step.reference,'x^2-2*x');
 assert.deepEqual(parseCalculationSupport({...v1,schemaVersion:2}),{...v1,schemaVersion:2});
});
test('strict V1 retains its exact old fields and rejects every V2 addition',()=>{
 assert.deepEqual(parseCalculationSupport(v1),v1);
 for(const [key,value] of Object.entries({conditions:[],units:'m',step,variantMappingId:'m'}))
  assert.throws(()=>parseCalculationSupport({...v1,[key]:value}));
 for(const schemaVersion of [0,3,'2',null])assert.throws(()=>parseCalculationSupport({...v2,schemaVersion}));
});
test('V2 rejects unbounded, duplicate, unsafe and unknown fields',()=>{
 for(const patch of [{extra:true},{conditions:['x',' x ']},{conditions:['']},{conditions:Array(9).fill('x')},
  {conditions:['x'.repeat(301)]},{units:''},{units:'m'.repeat(81)},{variantMappingId:''},{variantMappingId:'bad id'},
  {variables:['x','x']},{variables:Array(1)},{mode:{toString:()=> 'numeric'}},{domain:'complex'},{tolerance:'1.000001'},
  {step:{...step,extra:true}},{step:{...step,stepId:''}},{step:{...step,mode:'proof'}},
  {step:{...step,reference:'  写出展开后的左侧表达式。  '}},{step:{...step,prompt:''}},
  {step:{...step,mode:{toString:()=> 'numeric'}}},{step:{...step,reference:''}},{step:{...step,reference:'x'.repeat(513)}},{units:'m\u0000'}])
  assert.throws(()=>parseCalculationSupport({...v2,...patch}));
});
test('both versions preserve the bounded exploration contract',()=>{
 const exploration={expression:'x*x',parameters:[{id:'x',label:'x',min:'-2',max:'2',step:'0.5',defaultValue:'0'}]};
 for(const schemaVersion of [1,2]){
  const support={...v1,schemaVersion,variables:['x'],exploration};
  assert.deepEqual(parseCalculationSupport(support),support);
  assert.throws(()=>parseCalculationSupport({...support,exploration:{...exploration,parameters:[...exploration.parameters,...exploration.parameters]}}));
 }
 const inherited=Object.create(exploration);
 assert.throws(()=>parseCalculationSupport({...v2,exploration:inherited}));
 assert.throws(()=>parseCalculationSupport({...v2,exploration:{...exploration,parameters:[Object.create(exploration.parameters[0])]}}));
});
