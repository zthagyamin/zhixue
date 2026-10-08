import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gradeCalculationStep} from '../src/domain/math-step/index.ts';
import {gradeCalculationReference} from '../app/calculation-grade.ts';

const support=(mode,reference,extra={})=>({schemaVersion:2,type:'calculation',mode:'numeric',variables:['x'],domain:'real',
 step:{stepId:'one',prompt:'只写题目要求的中间表达式。',reference,mode},...extra});
function status(answer,data,expected){
 const result=gradeCalculationStep(answer,data);assert.equal(result.status,expected);assert.equal(result.source,'deterministic');
 assert.deepEqual(Object.keys(result).sort(),['explanation','source','status']);assert.ok(result.explanation.trim());return result;
}
const fixture=JSON.parse(readFileSync(new URL('./fixtures/stage3-calculation-support.json',import.meta.url),'utf8'));
for(const row of fixture.stepCases)test(`shared step fixture: ${row.name}`,()=>{
 const extra={};if(row.tolerance!==undefined)extra.tolerance=row.tolerance;if(row.conditions!==undefined)extra.conditions=row.conditions;
 status(row.answer,support(row.mode,row.reference,extra),row.status);
});
test('numeric step uses exact decimal tolerance without IEEE precision loss',()=>{
 status('9007199254740993',support('numeric','9007199254740993',{tolerance:'0'}),'correct');
 status('9007199254740992',support('numeric','9007199254740993',{tolerance:'0'}),'incorrect');
 status('0.7500001',support('numeric','0.75'),'correct');
 status('0.7',support('numeric','0.75'),'incorrect');
});
test('symbolic step checks just its requested expression using the existing kernel',()=>{
 status('x*(x-2)',support('symbolic','x^2-2*x'),'correct');
 status('x^2+2*x',support('symbolic','x^2-2*x'),'incorrect');
 status('x/x',support('symbolic','1'),'undetermined');
 status('sqrt(x^2)',support('symbolic','x'),'undetermined');
 status('x',support('symbolic','0',{conditions:['x = 0']}),'undetermined');
});
test('missing, blank, semantic, invalid and unsupported steps abstain',()=>{
 const old={schemaVersion:1,type:'calculation',mode:'numeric',variables:[],domain:'real'};
 status('0',old,'undetermined');status('  ',support('numeric','0'),'undetermined');
 status('减去常数项',support('semantic','先减去常数项，再除以非零系数。'),'undetermined');
 status('0',support('numeric','0',{domain:'complex'}),'undetermined');
 status('unknown',support('numeric','0'),'undetermined');
 status('0',support('numeric','0',{step:{stepId:'s',prompt:'same',reference:'same',mode:'numeric'}}),'undetermined');
});
test('final result and optional step can disagree without emitting a formal rating',()=>{
 const data=support('numeric','2'),item={answer:'4',learningSupport:data};
 assert.equal(gradeCalculationReference(item,'4').correct,true);status('3',data,'incorrect');
 assert.equal(gradeCalculationReference(item,'3').correct,false);status('2',data,'correct');
});
